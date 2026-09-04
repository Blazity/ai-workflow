import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("main pushes run CI in a non-canceling concurrency group", async () => {
  const source = await readFile(".github/workflows/ci.yml", "utf8");
  const workflow = parse(source) as {
    on: { push: { branches: string[] } };
    concurrency: { group: string; "cancel-in-progress": boolean };
  };

  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(
    workflow.concurrency.group,
    /github\.event_name == 'push' && github\.sha/,
  );
});

test("all setup-node workflow jobs use Node 24", async () => {
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/e2e.yml",
  ];
  let setupNodeJobs = 0;

  for (const workflowPath of workflowPaths) {
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as {
      jobs: Record<
        string,
        {
          steps?: Array<{
            uses?: string;
            with?: { "node-version"?: string | number };
          }>;
        }
      >;
    };

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const setupNodeSteps = job.steps?.filter((step) =>
        step.uses?.startsWith("actions/setup-node@"),
      );
      if (!setupNodeSteps?.length) continue;

      setupNodeJobs += 1;
      for (const step of setupNodeSteps) {
        assert.equal(
          String(step.with?.["node-version"]),
          "24",
          `${workflowPath}: job "${jobName}" must use Node 24`,
        );
      }
    }
  }

  assert.equal(
    setupNodeJobs,
    7,
    `expected 7 setup-node jobs across CI workflows, found ${setupNodeJobs}`,
  );
});
