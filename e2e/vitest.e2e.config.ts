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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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
    // Within-file tests stay serial — each test owns setup/teardown and
    // concurrent ordering inside one file buys nothing here.
    sequence: { concurrent: false },
    // Enable cross-file parallelism; `maxWorkers` caps how many files run
    // simultaneously. The `test:e2e:tier2:parallel` script relies on this;
    // `tier2-capacity` has a single file, so this flag is a no-op for it;
    // tier1 is currently empty.
    fileParallelism: true,
    maxWorkers: 6,
    minWorkers: 1,
    projects: [
      {
        test: {
          name: "tier1",
          include: ["e2e/tier1/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Most of tier2 can run concurrently: each test owns a unique
        // ticket key, branch name, and Redis field. Excludes US-11, which
        // asserts on the *global* MAX_CONCURRENT_AGENTS cap — if other
        // tests are holding claim slots while it runs, US-11 sees fewer
        // than max of its own tickets claimed and fails.
        test: {
          name: "tier2-parallel",
          include: ["e2e/tier2/**/*.test.ts"],
          exclude: ["e2e/tier2/us11-*.test.ts"],
          testTimeout: 2_100_000,
          hookTimeout: 2_100_000,
        },
      },
      {
        // US-11 runs alone so the capacity cap reflects only its own
        // tickets. Invoked via a separate `vitest run --project` call
        // after tier2-parallel finishes (see package.json scripts), so no
        // other tier2 files hold Redis claim slots while it runs.
        test: {
          name: "tier2-capacity",
          include: ["e2e/tier2/us11-*.test.ts"],
          testTimeout: 2_100_000,
          hookTimeout: 2_100_000,
        },
      },
    ],
  },
});
