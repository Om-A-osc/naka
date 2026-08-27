import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    /** Each test file gets its own process. */
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
    isolate: true,
  },
});
