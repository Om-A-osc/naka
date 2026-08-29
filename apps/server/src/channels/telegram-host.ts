import type { Db } from "@naka/db";
import { TelegramBotRunner, getMe, providerChain } from "@naka/channels";
import { insertLedgerRow } from "@naka/ledger";
import { mintBuyerAgent } from "../web/onboard.js";

interface TelegramRow {
  telegram_bot_token: string | null;
  telegram_bot_username: string | null;
  telegram_agent_id: string | null;
  telegram_agent_key: string | null;
  telegram_mandate_id: string | null;
  telegram_alert_chat_id: string | null;
}

export interface TelegramStatus {
  connected: boolean;
  username: string | null;
  link: string | null;
  running: boolean;
  llm_available: boolean;
  alerts_chat_set: boolean;
  chats_served: number;
  messages_handled: number;
  last_error: string | null;
}

/** Runs one Telegram bot per merchant, inside the server, from a token the merchant pasted into its console. */
export class TelegramHost {
  private runners = new Map<string, TelegramBotRunner>();

  constructor(
    private db: Db,
    private localBaseUrl: string,
    private offline = process.env.NAKA_TELEGRAM_OFFLINE === "1"
  ) {}

  private row(merchantId: string): TelegramRow | undefined {
    return this.db
      .prepare("SELECT telegram_bot_token, telegram_bot_username, telegram_agent_id, telegram_agent_key, telegram_mandate_id, telegram_alert_chat_id FROM merchants WHERE id = ?")
      .get(merchantId) as TelegramRow | undefined;
  }

  status(merchantId: string): TelegramStatus {
    const r = this.row(merchantId);
    const runner = this.runners.get(merchantId);
    return {
      connected: !!r?.telegram_bot_token,
      username: r?.telegram_bot_username ?? null,
      link: r?.telegram_bot_username ? `https://t.me/${r.telegram_bot_username}` : null,
      running: runner?.isRunning ?? false,
      llm_available: providerChain().length > 0,
      alerts_chat_set: !!r?.telegram_alert_chat_id,
      chats_served: runner?.chatsServed ?? 0,
      messages_handled: runner?.messagesHandled ?? 0,
      last_error: runner?.lastError ?? null,
    };
  }

  async connect(merchantId: string, token: string): Promise<{ username: string; link: string }> {
    const clean = token.trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(clean)) throw new Error("That does not look like a BotFather token (expected digits, a colon, then a long key).");
    const me = this.offline ? { username: `offline_${merchantId}_bot` } : await getMe(clean);

    await this.stopRunner(merchantId);
    const existing = this.row(merchantId);
    let agentId = existing?.telegram_agent_id ?? null;
    let agentKey = existing?.telegram_agent_key ?? null;
    let mandateId = existing?.telegram_mandate_id ?? null;
    if (!agentId || !agentKey || !mandateId) {
      const minted = mintBuyerAgent(this.db, merchantId, "telegram-bot");
      agentId = minted.agent_id;
      agentKey = minted.private_key_pem;
      mandateId = minted.mandate_id;
    }
    this.db
      .prepare(
        `UPDATE merchants SET telegram_bot_token = ?, telegram_bot_username = ?, telegram_agent_id = ?, telegram_agent_key = ?, telegram_mandate_id = ? WHERE id = ?`
      )
      .run(clean, me.username, agentId, agentKey, mandateId, merchantId);
    insertLedgerRow(this.db, { actor: "merchant", agent_id: agentId, action: "TELEGRAM_CONNECTED", inputs: { merchant_id: merchantId, username: me.username } });

    if (!this.offline) await this.startRunner(merchantId);
    return { username: me.username, link: `https://t.me/${me.username}` };
  }

  async disconnect(merchantId: string): Promise<void> {
    await this.stopRunner(merchantId);
    this.db.prepare("UPDATE merchants SET telegram_bot_token = NULL, telegram_bot_username = NULL, telegram_alert_chat_id = NULL WHERE id = ?").run(merchantId);
    insertLedgerRow(this.db, { actor: "merchant", action: "TELEGRAM_DISCONNECTED", inputs: { merchant_id: merchantId } });
  }

  /** Boot: resume every merchant's bot. Called after the HTTP server is listening, since the bots call it. */
  async startAll(): Promise<number> {
    if (this.offline) return 0;
    const rows = this.db.prepare("SELECT id FROM merchants WHERE telegram_bot_token IS NOT NULL AND telegram_agent_key IS NOT NULL").all() as Array<{ id: string }>;
    for (const r of rows) {
      if (this.runners.get(r.id)?.isRunning) continue; // connect() already started it
      await this.startRunner(r.id).catch((err) => console.error(`[telegram:${r.id}] failed to start: ${err?.message ?? err}`));
    }
    return rows.length;
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.runners.keys()]) await this.stopRunner(id);
  }

  private async startRunner(merchantId: string): Promise<void> {
    const r = this.row(merchantId);
    if (!r?.telegram_bot_token || !r.telegram_agent_id || !r.telegram_agent_key || !r.telegram_mandate_id) return;
    if (providerChain().length === 0) return; // status() reports this; nothing to run the model with
    await this.stopRunner(merchantId);
    const runner = new TelegramBotRunner({
      token: r.telegram_bot_token,
      baseUrl: this.localBaseUrl,
      agentId: r.telegram_agent_id,
      agentKey: r.telegram_agent_key,
      mandateId: r.telegram_mandate_id,
      merchantId,
      buyerRef: "telegram",
      onCommand: async (command, chatId) => {
        if (command === "/alerts") {
          this.db.prepare("UPDATE merchants SET telegram_alert_chat_id = ? WHERE id = ?").run(String(chatId), merchantId);
          return "Done, I'll send escalation alerts (orders that need your approval) to this chat.";
        }
        return null;
      },
    });
    this.runners.set(merchantId, runner);
    await runner.start();
  }

  private async stopRunner(merchantId: string): Promise<void> {
    const r = this.runners.get(merchantId);
    if (!r) return;
    this.runners.delete(merchantId);
    await r.stop();
  }
}
