import OpenAI from "openai";

export interface Provider {
  apiKey: string;
  baseURL?: string;
  model: string;
  label: string;
  extraBody?: Record<string, unknown>;
}

/** Every provider here speaks the same OpenAI-compatible Chat Completions shape, so switching between them is just a different apiKey/baseURL/model. */
export function providerChain(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const forced = env.TELEGRAM_LLM_PROVIDER;
  const all: Provider[] = [];
  if (env.OPENROUTER_API_KEY) {
    all.push({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      model: env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free",
      label: "OpenRouter",
      // Nemotron defaults to reasoning.effort "high", which on the free tier meant tens of seconds of hidden reasoning before every reply.
      extraBody: { reasoning: { effort: "low" } },
    });
  }
  if (env.GEMINI_API_KEY) {
    const primary = env.GEMINI_MODEL ?? "gemini-2.5-flash";
    all.push({
      apiKey: env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: primary,
      label: "Gemini",
    });
    // Google meters the free tier per model, so a second model on the same key is a second quota bucket: when flash is spent, flash-lite still answers.
    const lite = env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-flash-lite";
    if (lite !== primary) {
      all.push({
        apiKey: env.GEMINI_API_KEY,
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        model: lite,
        label: "Gemini (lite)",
      });
    }
  }
  if (env.OPENAI_API_KEY) {
    all.push({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? "gpt-4o", label: "OpenAI" });
  }
  if (!forced) return all;
  return all.filter((p) => p.label.toLowerCase().startsWith(forced.toLowerCase()));
}

export function makeClients(chain: Provider[]): Map<string, OpenAI> {
  return new Map(chain.map((p) => [p.label, new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL })]));
}

/** True when a 429 says the quota is spent for the day rather than "you are going too fast". */
export function isExhaustedQuota(err: any): boolean {
  const text = `${err?.message ?? ""} ${JSON.stringify(err?.error ?? "")}`.toLowerCase();
  return /per-day|per_day|daily|quota|insufficient_quota|credit|billing/.test(text);
}

async function createWithRetry(client: OpenAI, req: any, log: (s: string) => void, retries = 2, delayMs = 5000): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response: any = await client.chat.completions.create(req);
      // Some providers return HTTP 200 with an { error: ...
      if (!response?.choices?.length) {
        const detail = response?.error ? JSON.stringify(response.error) : JSON.stringify(response).slice(0, 500);
        if (attempt < retries) {
          log(`[no choices in response, retrying in ${delayMs / 1000}s] ${detail}`);
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs *= 2;
          continue;
        }
        throw new Error(`provider returned no choices: ${detail}`);
      }
      return response;
    } catch (err: any) {
      if (err?.status !== 429 || attempt >= retries) throw err;
      if (isExhaustedQuota(err)) throw err; // waiting cannot help; let the caller switch provider
      // Google's free tier answers 429 with no reason at all, so a spent daily quota looks identical to a busy minute.
      const vague = /no body/.test(String(err?.message ?? ""));
      if (vague && attempt >= 1) throw err;
      const wait = vague ? 3000 : delayMs;
      log(`[rate-limited] retrying in ${wait / 1000}s (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
      delayMs *= 2;
    }
  }
}

/** Runs one completion against the first provider in the chain that will serve it. */
export async function complete(
  chain: Provider[],
  state: { index: number },
  clients: Map<string, OpenAI>,
  body: any,
  log: (s: string) => void = () => {}
): Promise<any> {
  const errors: any[] = [];
  const failures: string[] = [];
  for (let i = state.index; i < chain.length; i++) {
    const p = chain[i];
    try {
      const res = await createWithRetry(clients.get(p.label)!, { ...body, model: p.model, ...(p.extraBody ?? {}) }, log);
      if (i !== state.index) log(`[provider] now using ${p.label} (${p.model})`);
      state.index = i;
      return res;
    } catch (err: any) {
      errors.push(err);
      failures.push(`${p.label}/${p.model}: ${describeFailure(err)}`);
      log(`[provider] ${p.label} failed${err?.status === 429 ? " (rate limit/quota)" : ""}: ${err?.message ?? err}`);
      if (i + 1 < chain.length) log(`[provider] falling back to ${chain[i + 1].label}`);
    }
  }
  // One error that tells the whole story of the chain.
  const e: any = new Error(failures.length ? failures.join(" | ") : "no LLM provider configured");
  if (errors.length && errors.every((x) => x?.status === 429)) e.status = 429;
  e.exhausted = errors.length > 0 && errors.every(isExhaustedQuota);
  throw e;
}

/** Short, human-readable reason for one provider failing. */
function describeFailure(err: any): string {
  const msg = String(err?.message ?? err ?? "");
  if (err?.status === 429 && /no body/.test(msg)) return "429 free-tier limit (per-minute or per-day; Google sends no detail)";
  const reset = err?.error?.metadata?.headers?.["X-RateLimit-Reset"];
  const when = reset ? ` (resets ${new Date(Number(reset)).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST)` : "";
  return msg.replace(/^\d{3}\s+/, "").slice(0, 140) + when;
}
