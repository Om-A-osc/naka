import type { Db } from "@naka/db";
import { env } from "../config/env.js";

/** Merchant-side escalation notice over Telegram. */
export async function notifyMerchantEscalation(db: Db, merchantId: string, text: string): Promise<void> {
  const row = db.prepare("SELECT telegram_bot_token, telegram_alert_chat_id FROM merchants WHERE id = ?").get(merchantId) as
    | { telegram_bot_token: string | null; telegram_alert_chat_id: string | null }
    | undefined;
  const token = row?.telegram_bot_token && row.telegram_alert_chat_id ? row.telegram_bot_token : env.telegramBotToken;
  const chatId = row?.telegram_bot_token && row.telegram_alert_chat_id ? row.telegram_alert_chat_id : env.telegramMerchantChatId;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // best-effort only
  }
}
