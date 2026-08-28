/** A Gemini-powered buyer, added alongside the Claude- and OpenAI-powered ones at the user's request. */
import { existsSync, readFileSync } from "node:fs";
import { getDb } from "@naka/db";
import { seedAll } from "../../../cli/seed.js";
import { buildServer } from "@naka/server";
import { NakaClient } from "./mcp-client.js";
import { claimCheck } from "./claimcheck.js";
import { loadSystemPrompt } from "./prompt.js";
import { TOOLS } from "./tools-openai.js";



async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log(
      "GEMINI_API_KEY is not set, this is the Gemini-powered buyer and needs it.\n" +
        "The full system runs and is verified without any keys via:  pnpm demo:replay\n" +
        "The Claude-powered buyer is:  pnpm demo:live\n" +
        "The OpenAI-powered buyer is:  pnpm demo:live:openai\n"
    );
    return;
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  const db = getDb();
  const seedOutputPath = "data/seed-output.json";
  const seed = existsSync(seedOutputPath) ? JSON.parse(readFileSync(seedOutputPath, "utf8")) : seedAll(db);

  const { app, close } = await buildServer();
  const port = Number(process.env.NAKA_PORT ?? 3000);
  await app.listen({ port, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`server up at ${baseUrl} (Gemini buyer, model=${model})\n`);

  const buyer = new NakaClient(baseUrl, seed.agents["buyer-claude"].id, seed.agents["buyer-claude"].privateKeyPath);
  const mandateId = seed.mandates.buyer_claude;

  async function runTool(name: string, input: any): Promise<any> {
    switch (name) {
      case "search_catalog": return buyer.searchCatalog(input);
      case "get_product": return buyer.getProduct(input);
      case "create_checkout": return buyer.createCheckout({ ...input, mandate_id: mandateId });
      case "get_checkout": return buyer.getCheckout(input);
      case "update_checkout": return buyer.updateCheckout(input);
      case "suggest_addons": return buyer.suggestAddons(input);
      case "complete_checkout": return buyer.completeCheckout(input);
      case "cancel_checkout": return buyer.cancelCheckout(input);
      default: return { error: { code: "UNKNOWN_TOOL" } };
    }
  }

  const systemPrompt = await loadSystemPrompt(baseUrl);
  const scenarios = [
    "500 gram filter kaapi aur ek steel filter chahiye, mera budget theek hai.",
    "haan wahi le lo, aur agar kuch aur suggest karna hai toh batao, lekin abhi kuch add mat karna bina poochhe.",
    "nahi rehne do, yehi order kar do.",
  ];

  const messages: any[] = [{ role: "system", content: systemPrompt }];
  const toolResultsThisTurn: unknown[] = [];

  for (const userMsg of scenarios) {
    console.log(`\nhuman: ${userMsg}`);
    messages.push({ role: "user", content: userMsg });

    let response = await client.chat.completions.create({ model, tools: TOOLS, messages });
    let choice = response.choices[0];
    messages.push(choice.message as any);

    let iterations = 0;
    while (choice.message.tool_calls?.length && iterations < 8) {
      iterations++;
      for (const call of choice.message.tool_calls) {
        const fn = (call as any).function;
        const args = fn.arguments ? JSON.parse(fn.arguments) : {};
        const result = await runTool(fn.name, args);
        toolResultsThisTurn.push(result);
        console.log(`  [tool] ${fn.name}(${JSON.stringify(args)}) -> ${JSON.stringify(result).slice(0, 200)}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      response = await client.chat.completions.create({ model, tools: TOOLS, messages });
      choice = response.choices[0];
      messages.push(choice.message as any);
    }

    const text = choice.message.content ?? "";
    const check = claimCheck(text, toolResultsThisTurn.slice(-10));
    if (!check.ok) {
      console.log(`  [claim-check] BLOCKED unmatched figures ${check.unmatched.join(",")}; falling back to a templated reply.`);
      console.log(`assistant (templated): I have an update on your order, let me check the details again before I say a number.`);
    } else {
      console.log(`assistant: ${text}`);
    }
  }

  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
