import { fileURLToPath } from "node:url";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";
import {
  createWorkflowVitestIsolation,
  workflowVitestIsolationGlobalSetup,
} from "./src/test-support/workflow-vitest-isolation.js";

const workerRoot = fileURLToPath(new URL("./", import.meta.url));
const workflowRoot = fileURLToPath(
  new URL("./workflow-test-fixtures/", import.meta.url),
);
const isolation = createWorkflowVitestIsolation("run-control");

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
    include: ["workflow-sdk-tests/*.test.ts"],
    testTimeout: 30_000,
  },
});
