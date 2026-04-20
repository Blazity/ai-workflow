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
    // simultaneously. The `agent` and `orchestration` projects rely on
    // this; `capacity` has a single file, so this flag is a no-op for it;
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
        // Agent tests — provision real sandboxes and run Claude Code.
        // Run these in parallel FIRST so expensive failures surface early
        // and don't share a worker pool with cheap orchestration tests.
        //   - US-03: review-fix cycle (two full runs)
        //   - US-04: merge conflict rebase (full run)
        //   - US-06: clarification answered (two full runs)
        //   - US-07: agent failure — kills claude mid-run
        test: {
          name: "agent",
          include: [
            "e2e/tier2/us03-*.test.ts",
            "e2e/tier2/us04-*.test.ts",
            "e2e/tier2/us06-*.test.ts",
            "e2e/tier2/us07-*.test.ts",
          ],
          testTimeout: 4_200_000,
          hookTimeout: 4_200_000,
        },
      },
      {
        // Orchestration tests — redis/dispatch/reconcile paths, no Claude.
        // Each test owns a unique ticket key, branch name, and Redis
        // field, so they run cross-file parallel. Excludes:
        //   - US-11 — asserts the global MAX_CONCURRENT_AGENTS cap; runs
        //             alone via the `capacity` project.
        //   - US-01, US-05 — full agent runs, kept as reference only.
        //   - US-03, US-04, US-06, US-07 — agent tests, run via `agent`.
        test: {
          name: "orchestration",
          include: ["e2e/tier2/**/*.test.ts"],
          exclude: [
            "e2e/tier2/us11-*.test.ts",
            "e2e/tier2/us01-*.test.ts",
            "e2e/tier2/us05-*.test.ts",
            "e2e/tier2/us03-*.test.ts",
            "e2e/tier2/us04-*.test.ts",
            "e2e/tier2/us06-*.test.ts",
            "e2e/tier2/us07-*.test.ts",
          ],
          testTimeout: 2_100_000,
          hookTimeout: 2_100_000,
        },
      },
      {
        // US-11 runs alone so the capacity cap reflects only its own
        // tickets. Invoked via a separate `vitest run --project` call
        // after orchestration finishes (see package.json scripts), so no
        // other tier2 files hold Redis claim slots while it runs.
        test: {
          name: "capacity",
          include: ["e2e/tier2/us11-*.test.ts"],
          testTimeout: 2_100_000,
          hookTimeout: 2_100_000,
        },
      },
    ],
  },
});
