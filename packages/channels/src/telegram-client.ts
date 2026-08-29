/** Thin wrapper over the two Telegram Bot API calls this project needs. */

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { username?: string; first_name?: string } };
}

export async function getUpdates(token: string, offset: number, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}`;
  const res = await fetch(url, { signal: AbortSignal.timeout((timeoutSeconds + 10) * 1000) });
  const body = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
  if (!body.ok) throw new Error(`getUpdates failed: ${JSON.stringify(body)}`);
  return body.result;
}

async function post(token: string, chatId: number, text: string, parseMode?: "HTML"): Promise<{ ok: boolean; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    }),
  });
  return (await res.json()) as { ok: boolean; description?: string };
}

/** Sends `html` with Telegram's HTML renderer, falling back to `plain` if Telegram refuses to parse it. */
export async function sendMessage(token: string, chatId: number, html: string, plain?: string): Promise<void> {
  const first = plain === undefined ? await post(token, chatId, html) : await post(token, chatId, html, "HTML");
  if (first.ok) return;

  if (plain !== undefined) {
    console.error(`sendMessage HTML rejected (${first.description ?? "no reason"}), retrying as plain text`);
    const second = await post(token, chatId, plain);
    if (second.ok) return;
    throw new Error(`sendMessage failed: ${JSON.stringify(second)}`);
  }
  throw new Error(`sendMessage failed: ${JSON.stringify(first)}`);
}

/** Validates a bot token and returns the bot's identity (username, display name). */
export async function getMe(token: string): Promise<{ id: number; username: string; first_name: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as { ok: boolean; result?: { id: number; username: string; first_name: string }; description?: string };
  if (!body.ok || !body.result) throw new Error(body.description ?? "Telegram rejected the token");
  return body.result;
}
