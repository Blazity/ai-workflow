import { resolve } from "node:path";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";
import {
  createWorkflowVitestIsolation,
  workflowVitestIsolationGlobalSetup,
} from "./src/test-support/workflow-vitest-isolation.js";

const workerRoot = import.meta.dirname;
const workflowRoot = resolve(workerRoot, "workflow-test-fixtures");
const isolation = createWorkflowVitestIsolation("divergence");

// The manual-dispatch suite that pins the Workflow SDK's concurrent-wait replay
// defect. Separate from vitest.run-control-workflow.config.ts so those rows stay
// out of every pull request's budget: see
// workflow-sdk-tests/divergence/wdk-wait-divergence.test.ts for what they are for
// and when to run them. Its own invocation root so a dispatch run cannot
// disturb the default suite's runtime data or builder cache.
//
// @workflow/vitest's builder and client transform both derive stable function
// ids from process.cwd(). Keep the dedicated test process rooted at the small
// fixture while Vitest itself still discovers the test from the worker root.
process.chdir(workflowRoot);

export default defineConfig({
  plugins: workflow({
    cwd: workflowRoot,
    rootDir: workerRoot,
    dataDir: isolation.dataDir,
    outDir: isolation.outDir,
  }),
  root: workerRoot,
  test: {
    environment: "node",
    // Merged with the Workflow SDK's own global setup; this entry only owns
    // teardown of this invocation's isolated artifacts.
    globalSetup: [workflowVitestIsolationGlobalSetup],
    include: ["workflow-sdk-tests/divergence/*.test.ts"],
    // Each pinned row waits out four replay divergences and three recovery
    // replays, and the serial baselines walk a real multi-block poll loop.
    testTimeout: 180_000,
  },
});
