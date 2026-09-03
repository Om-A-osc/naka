import { readFileSync } from "node:fs";

const SYSTEM_PROMPT_PATH = new URL("./prompts/system.md", import.meta.url);

/** The system prompt with the merchant's name filled in from the server's own manifest. */
/** The prompt with a name already known, for callers that live inside the server. */
export function renderSystemPrompt(merchantName: string): string {
  return readFileSync(SYSTEM_PROMPT_PATH, "utf8").replaceAll("{{merchant_name}}", merchantName);
}

export async function loadSystemPrompt(baseUrl: string, merchantId?: string): Promise<string> {
  let merchantName = "the merchant";
  try {
    const res = await fetch(`${baseUrl}/.well-known/naka.json${merchantId ? `?merchant=${encodeURIComponent(merchantId)}` : ""}`);
    const manifest = (await res.json()) as { merchant?: { display_name?: string } };
    if (manifest.merchant?.display_name) merchantName = manifest.merchant.display_name;
  } catch {
    // A missing manifest costs a name, not a conversation.
  }
  return renderSystemPrompt(merchantName);
}
