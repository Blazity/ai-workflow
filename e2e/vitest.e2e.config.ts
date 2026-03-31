import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Load .env.e2e if it exists (CI uses environment secrets instead)
const envPath = resolve(import.meta.dirname, "../.env.e2e");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    sequence: { concurrent: false },
    fileParallelism: false,
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
