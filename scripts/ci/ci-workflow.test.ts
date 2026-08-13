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
