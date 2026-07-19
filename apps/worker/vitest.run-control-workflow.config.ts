import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

const workerRoot = fileURLToPath(new URL("./", import.meta.url));
const workflowRoot = fileURLToPath(
  new URL("./workflow-test-fixtures/run-control/", import.meta.url),
);

// @workflow/vitest's builder and client transform both derive stable function
// ids from process.cwd(). Keep the dedicated test process rooted at the small
// fixture while Vitest itself still discovers the test from the worker root.
process.chdir(workflowRoot);

export default defineConfig({
  plugins: workflow({
    cwd: workflowRoot,
    rootDir: workerRoot,
    dataDir: resolve(tmpdir(), "ai-workflow-run-control-vitest-data"),
    outDir: join(workerRoot, ".workflow-vitest", "run-control"),
  }),
  root: workerRoot,
  test: {
    environment: "node",
    include: ["workflow-sdk-tests/run-control-workflow-sdk.test.ts"],
    testTimeout: 30_000,
  },
});
