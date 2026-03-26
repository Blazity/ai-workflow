import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Load .env.e2e if it exists (CI uses environment secrets instead)
const envPath = resolve(import.meta.dirname, "../.env.e2e");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    sequence: { concurrent: false },
    projects: [
      {
        test: {
          name: "tier1",
          include: ["e2e/tier1/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: "tier2",
          include: ["e2e/tier2/**/*.test.ts"],
          testTimeout: 2_100_000,
        },
      },
    ],
  },
});
