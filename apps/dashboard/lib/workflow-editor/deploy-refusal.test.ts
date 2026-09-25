import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinitionValidationIssue } from "@shared/contracts";

import { deployRefusal } from "./deploy-refusal";

function issue(nodeId: string | null, message: string): WorkflowDefinitionValidationIssue {
  return { code: "deployment", severity: "error", nodeId, message } as WorkflowDefinitionValidationIssue;
}

// Red when: the sentence names a block by its id. Production: "Not deployed.
// Allow clean input (copy): Block "clean-copy" is not reachable from a
// trigger.", naming the same block twice, once by a word the canvas never shows.
test("a refused Deploy names the block the way the canvas does, once", () => {
  const refusal = deployRefusal(
    [issue("clean-copy", 'Block "clean-copy" is not reachable from a trigger.')],
    { "clean-copy": "Allow clean input (copy)" },
  );
  assert.equal(
    refusal.sentence,
    "Not deployed. Allow clean input (copy): This block is not reachable from a trigger.",
  );
});

test("another block the sentence mentions is named too, and an unknown one keeps its id", () => {
  const names = { workspace: "Prepare workspace", nightly: "Every night" };
  assert.equal(
    deployRefusal(
      [issue("workspace", 'Block "workspace" (prepare_workspace) is reachable from schedule trigger "nightly".')],
      names,
    ).sentence,
    'Not deployed. Prepare workspace: This block (prepare_workspace) is reachable from schedule trigger "Every night".',
  );
  assert.equal(
    deployRefusal([issue("workspace", 'Block "workspace" references unknown block "gone".')], names).sentence,
    'Not deployed. Prepare workspace: This block references unknown block "gone".',
  );
});
