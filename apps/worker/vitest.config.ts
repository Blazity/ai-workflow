import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@vercel/sandbox": fileURLToPath(
        new URL("./src/test-support/vercel-sandbox.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
