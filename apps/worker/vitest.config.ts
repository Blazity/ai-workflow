import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "*.test.ts"],
    testTimeout: 15_000,
    // PGlite-backed files contend heavily on two-core CI runners.
    fileParallelism: process.env.CI ? false : undefined,
  },
});
