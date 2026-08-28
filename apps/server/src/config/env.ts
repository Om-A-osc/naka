import { defaultMerchantId } from "@naka/engine";

export const env = {
  mode: process.env.RAZORPAY_MODE ?? "recorded",
  // NAKA_PORT wins locally; PORT is what Railway/Render/Fly inject.
  port: Number(process.env.NAKA_PORT ?? process.env.PORT ?? 3000),
  baseUrl: process.env.NAKA_BASE_URL ?? "http://localhost:3000",
  keyId: process.env.RAZORPAY_KEY_ID ?? "",
  keySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
  consolePassword: process.env.CONSOLE_PASSWORD ?? "change-me",
  merchantId: defaultMerchantId(),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramMerchantChatId: process.env.TELEGRAM_MERCHANT_CHAT_ID ?? "",
};

if (env.mode === "real" && !env.keyId.startsWith("rzp_test_")) {
  throw new Error(
    "RAZORPAY_MODE=real but RAZORPAY_KEY_ID is not set to a test-mode key (must start with rzp_test_). " +
      "This project never runs against live Razorpay keys."
  );
}
