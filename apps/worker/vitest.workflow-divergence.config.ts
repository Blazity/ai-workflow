import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

const workerRoot = fileURLToPath(new URL("./", import.meta.url));
const workflowRoot = fileURLToPath(
  new URL("./workflow-test-fixtures/", import.meta.url),
);

// The manual-dispatch suite that pins the Workflow SDK's concurrent-wait replay
// defect. Separate from vitest.run-control-workflow.config.ts so those rows stay
// out of every pull request's budget: see
// workflow-sdk-tests/divergence/wdk-wait-divergence.test.ts for what they are for
// and when to run them. Its own dataDir and outDir so a dispatch run cannot
// disturb the default suite's builder cache.
//
// @workflow/vitest's builder and client transform both derive stable function
// ids from process.cwd(). Keep the dedicated test process rooted at the small
// fixture while Vitest itself still discovers the test from the worker root.
process.chdir(workflowRoot);

export default defineConfig({
  plugins: workflow({
    cwd: workflowRoot,
    rootDir: workerRoot,
    dataDir: resolve(tmpdir(), "ai-workflow-divergence-vitest-data"),
    outDir: join(workerRoot, ".workflow-vitest", "divergence"),
  }),
  root: workerRoot,
  test: {
    environment: "node",
    include: ["workflow-sdk-tests/divergence/*.test.ts"],
    // Each pinned row waits out four replay divergences and three recovery
    // replays, and the serial baselines walk a real multi-block poll loop.
    testTimeout: 180_000,
  },
});
