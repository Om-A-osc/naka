/** The standalone server entry point. */
import { getDb, resolveDbPath } from "@naka/db";
import { buildServer } from "./index.js";
import { env } from "./config/env.js";

async function seedIfEmpty(): Promise<void> {
  const db = getDb();
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM merchants").get() as { n: number };
  if (n > 0) return;
  const { seedAll } = await import("../../../cli/seed.js");
  const out = seedAll(db);
  console.log(`[naka] empty database, seeded demo merchant ${out.merchant_id} with buyer agent ${out.agents["buyer-claude"].id}`);
}

// First thing on stdout, before any import-time work can fail quietly: if this line is missing from a deploy log, the process never reached us.
console.log(`[naka] boot node=${process.version} port=${process.env.NAKA_PORT ?? process.env.PORT ?? 3000} db=${resolveDbPath()} volume=${process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "-"} mode=${process.env.RAZORPAY_MODE ?? "recorded"}`);
process.on("exit", (code) => console.log(`[naka] exit code=${code}`));

async function main() {
  await seedIfEmpty();
  const { app, telegram } = await buildServer();
  await app.listen({ port: env.port, host: "0.0.0.0" });
  app.log.info(`naka listening on ${env.baseUrl} (mode=${env.mode}, merchant=${env.merchantId}, db=${resolveDbPath()})`);
  // The operator-level TELEGRAM_BOT_TOKEN in `.env` predates hosted bots.
  if (env.telegramBotToken && !telegram.status(env.merchantId).connected) {
    try {
      const r = await telegram.connect(env.merchantId, env.telegramBotToken);
      app.log.info(`adopted TELEGRAM_BOT_TOKEN for ${env.merchantId}: @${r.username}`);
    } catch (err) {
      app.log.warn(`could not adopt TELEGRAM_BOT_TOKEN: ${(err as Error).message}`);
    }
  }
  const bots = await telegram.startAll();
  if (bots) app.log.info(`hosting ${bots} merchant Telegram bot${bots === 1 ? "" : "s"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
