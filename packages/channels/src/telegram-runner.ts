import { NakaClient } from "./mcp-client.js";
import { claimCheck } from "./claimcheck.js";
import { TOOLS } from "./tools-openai.js";
import { loadSystemPrompt } from "./prompt.js";
import { getUpdates, sendMessage } from "./telegram-client.js";
import { toTelegramHtml, toPlainText } from "./telegram-format.js";
import { providerChain, makeClients, complete, type Provider } from "./llm.js";

export interface RunnerOptions {
  token: string;
  baseUrl: string;
  agentId: string;
  /** Private key PEM text, or a path to one. */
  agentKey: string;
  mandateId: string;
  merchantId?: string;
  buyerRef?: string;
  providers?: Provider[];
  systemPrompt?: string;
  /** Slash-commands handled by the host (e.g. "/alerts"); return a reply to short-circuit the LLM. */
  onCommand?: (command: string, chatId: number, from: string) => Promise<string | null>;
  log?: (line: string) => void;
}

interface ChatSession {
  messages: any[];
  /** Every tool result seen anywhere in this chat, not just the current turn. */
  allToolResults: unknown[];
}

const MAX_TOOL_ROUNDS = 8;

/** One Telegram bot for one merchant: long-polls getUpdates, keeps a conversation per chat. */
export class TelegramBotRunner {
  private running = false;
  private loop: Promise<void> | undefined;
  private sessions = new Map<number, ChatSession>();
  private readonly log: (line: string) => void;
  chatsServed = 0;
  messagesHandled = 0;
  lastError: string | null = null;

  constructor(private readonly opts: RunnerOptions) {
    this.log = opts.log ?? ((l) => console.error(`[telegram${opts.merchantId ? ":" + opts.merchantId : ""}] ${l}`));
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.run().catch((err) => {
      this.lastError = String(err?.message ?? err);
      this.log(`loop died: ${this.lastError}`);
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    const o = this.opts;
    const chain = o.providers ?? providerChain();
    if (chain.length === 0) throw new Error("no LLM provider configured (OPENROUTER_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY)");
    const clients = makeClients(chain);
    const providerState = { index: 0 };
    const buyer = new NakaClient(o.baseUrl, o.agentId, o.agentKey, o.merchantId);
    const systemPrompt = o.systemPrompt ?? (await loadSystemPrompt(o.baseUrl, o.merchantId));
    const buyerRef = o.buyerRef ?? "telegram";
    this.log(`polling (providers: ${chain.map((p) => `${p.label}/${p.model}`).join(" -> ")})`);

    const runTool = async (name: string, input: any): Promise<any> => {
      switch (name) {
        case "search_catalog": return buyer.searchCatalog(input);
        case "get_product": return buyer.getProduct(input);
        case "create_checkout": return buyer.createCheckout({ ...input, mandate_id: o.mandateId, buyer_ref: buyerRef });
        case "get_checkout": return buyer.getCheckout(input);
        case "update_checkout": return buyer.updateCheckout(input);
        case "suggest_addons": return buyer.suggestAddons(input);
        case "complete_checkout": return buyer.completeCheckout(input);
        case "cancel_checkout": return buyer.cancelCheckout(input);
        default: return { error: { code: "UNKNOWN_TOOL" } };
      }
    };

    let offset = 0;
    while (this.running) {
      let updates;
      try {
        updates = await getUpdates(o.token, offset);
      } catch (err) {
        this.lastError = (err as Error).message;
        this.log(`getUpdates error, retrying in 3s: ${this.lastError}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        const chatId = msg.chat.id;
        const from = msg.from?.username ?? msg.from?.first_name ?? "user";
        this.messagesHandled++;
        this.log(`[chat ${chatId}] ${from}: ${msg.text}`);

        if (msg.text.startsWith("/") && o.onCommand) {
          const handled = await o.onCommand(msg.text.trim().split(/\s+/)[0].toLowerCase(), chatId, from).catch(() => null);
          if (handled) {
            await sendMessage(o.token, chatId, toTelegramHtml(handled), toPlainText(handled)).catch(() => {});
            continue;
          }
        }

        let session = this.sessions.get(chatId);
        if (!session) {
          session = { messages: [{ role: "system", content: systemPrompt }], allToolResults: [] };
          this.sessions.set(chatId, session);
          this.chatsServed++;
        }
        session.messages.push({ role: "user", content: msg.text === "/start" ? "Hi" : msg.text });

        try {
          let response = await complete(chain, providerState, clients, { tools: TOOLS, messages: session.messages }, this.log);
          let choice = response.choices[0];
          session.messages.push(choice.message);

          let iterations = 0;
          while (choice.message.tool_calls?.length && iterations < MAX_TOOL_ROUNDS) {
            iterations++;
            for (const call of choice.message.tool_calls) {
              const fn = call.function;
              const args = fn.arguments ? JSON.parse(fn.arguments) : {};
              const result = await runTool(fn.name, args);
              session.allToolResults.push(result);
              this.log(`  [tool] ${fn.name}(${JSON.stringify(args)}) -> ${JSON.stringify(result).slice(0, 160)}`);
              session.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
            }
            response = await complete(chain, providerState, clients, { tools: TOOLS, messages: session.messages }, this.log);
            choice = response.choices[0];
            session.messages.push(choice.message);
          }

          let text = (choice.message.content ?? "").trim();
          let check = claimCheck(text, session.allToolResults.slice(-30));

          // A blocked reply is not a dead end: tell the model which figures were unverifiable and let it correct itself once.
          if (!check.ok) {
            this.log(`  [claim-check] BLOCKED ${check.unmatched.join(",")} in: ${text.slice(0, 120)}`);
            session.messages.push({
              role: "user",
              content:
                `[system] Your last reply was blocked: the amounts ${check.unmatched.map((p) => `₹${(p / 100).toFixed(2)}`).join(", ")} ` +
                `do not appear in any tool result. Remember price_paise is in paise (100 paise = ₹1) and every result carries a ` +
                `price_display string already formatted for humans. Rewrite your reply quoting price_display exactly.`,
            });
            const retry = await complete(chain, providerState, clients, { tools: TOOLS, messages: session.messages }, this.log);
            const retryChoice = retry.choices[0];
            session.messages.push(retryChoice.message);
            const retryText = (retryChoice.message.content ?? "").trim();
            const retryCheck = claimCheck(retryText, session.allToolResults.slice(-30));
            if (retryCheck.ok && retryText) {
              text = retryText;
              check = retryCheck;
            }
          }

          let reply: string;
          if (!check.ok) reply = "I have an update on your order, let me check the details again before I say a number.";
          else if (text) reply = text;
          else if (iterations >= MAX_TOOL_ROUNDS) reply = "I had trouble looking that up just now. Could you tell me the product and size again?";
          else reply = "Sorry, I didn't catch that, could you say it another way?";
          this.log(`  [reply] ${reply.slice(0, 160)}`);
          await sendMessage(o.token, chatId, toTelegramHtml(reply), toPlainText(reply));
        } catch (err: any) {
          this.lastError = String(err?.message ?? err);
          this.log(`chat ${chatId} error: ${this.lastError}`);
          const reply = err?.status === 429
            ? "I'm getting rate-limited right now, please wait about a minute and try again."
            : "Sorry, something went wrong on my end, please try again.";
          await sendMessage(o.token, chatId, reply).catch(() => {});
        }
      }
    }
  }
}
