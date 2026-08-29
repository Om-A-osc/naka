/** The Telegram channel as a standalone process, a real buyer talking to the merchant over a Telegram bot registered as a buyer agent. */
import { existsSync, readFileSync } from "node:fs";
import { getDb } from "@naka/db";
import { seedAll } from "../../../cli/seed.js";
import { buildServer } from "@naka/server";
import { TelegramBotRunner, providerChain } from "@naka/channels";

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(
      "TELEGRAM_BOT_TOKEN not set, the Telegram channel needs it (get one from @BotFather on Telegram; " +
        "no business verification or approval wait, unlike WhatsApp).\n" +
        "The full system runs and is verified without any keys via:  pnpm demo:replay\n"
    );
    return;
  }
  if (providerChain().length === 0) {
    console.log("No LLM key found, set OPENROUTER_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY in .env.\n");
    return;
  }

  const remote = process.env.NAKA_URL?.replace(/\/$/, "");
  let baseUrl: string;
  let close: () => Promise<void> = async () => {};
  let agentId: string, agentKey: string, mandateId: string;

  if (remote) {
    baseUrl = remote;
    agentId = process.env.NAKA_AGENT_ID ?? "";
    agentKey = process.env.NAKA_AGENT_KEY ?? "";
    mandateId = process.env.NAKA_MANDATE_ID ?? "";
    if (!agentId || !agentKey || !mandateId) {
      console.log("NAKA_URL is set, so NAKA_AGENT_ID, NAKA_AGENT_KEY and NAKA_MANDATE_ID are required too (from the onboarding kit or a minted agent).");
      return;
    }
    console.log(`Telegram bot -> remote Naka at ${baseUrl}`);
  } else {
    const db = getDb();
    const seedOutputPath = "data/seed-output.json";
    const seed = existsSync(seedOutputPath) ? JSON.parse(readFileSync(seedOutputPath, "utf8")) : seedAll(db);
    const built = await buildServer();
    const port = Number(process.env.NAKA_PORT ?? 3000);
    await built.app.listen({ port, host: "127.0.0.1" });
    close = built.close;
    baseUrl = `http://127.0.0.1:${port}`;
    agentId = seed.agents["buyer-claude"].id;
    agentKey = seed.agents["buyer-claude"].privateKeyPath;
    mandateId = seed.mandates.buyer_claude;
    console.log(`server up at ${baseUrl}`);
  }

  const runner = new TelegramBotRunner({
    token,
    baseUrl,
    agentId,
    agentKey,
    mandateId,
    merchantId: process.env.NAKA_MERCHANT,
    log: (l) => console.log(l),
  });
  await runner.start();
  console.log("Telegram bot polling... send it a message to start a chat.\n");

  const shutdown = async () => {
    await runner.stop();
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
