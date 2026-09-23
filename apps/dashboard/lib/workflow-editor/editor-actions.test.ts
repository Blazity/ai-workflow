import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WorkflowDefinitionSaveResponse,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";
import {
  deployUnavailableReason,
  draftDiffersFromDeployed,
  workflowDeploymentAfterSave,
  workflowEditorActions,
} from "./editor-actions.ts";

test("cached validation does not gate saving or deploying a structural candidate", () => {
  assert.deepEqual(
    workflowEditorActions({
      dirty: true,
      structurallyValid: true,
      hasDraft: true,
    }),
    { canSave: true, canDeploy: true },
  );
});

test("a clean saved draft can be deployed and an unsaved invalid shape cannot", () => {
  assert.deepEqual(
    workflowEditorActions({
      dirty: false,
      structurallyValid: true,
      hasDraft: true,
    }),
    { canSave: false, canDeploy: true },
  );
  assert.equal(
    workflowEditorActions({
      dirty: true,
      structurallyValid: false,
      hasDraft: false,
    }).canDeploy,
    false,
  );
});

test("dirty deploy stops when saved-snapshot validation diverges from the immediate check", () => {
  const immediate: WorkflowDefinitionValidationResponse = {
    valid: true,
    issues: [],
    nodeContracts: {},
    availableValuesByNode: {},
  };
  const authoritative: WorkflowDefinitionValidationResponse = {
    valid: false,
    issues: [
      {
        code: "deployment",
        severity: "error",
        nodeId: "review",
        path: "/nodes/1",
        message: "Review is no longer available.",
      },
    ],
    nodeContracts: {},
    availableValuesByNode: {},
  };
  const saved = {
    meta: { draftRevision: 2 },
    draft: {},
    validation: authoritative,
    validationError: null,
  } as WorkflowDefinitionSaveResponse;

  assert.deepEqual(workflowDeploymentAfterSave(immediate, saved), {
    kind: "invalid",
    validation: authoritative,
  });
});

test("draftDiffersFromDeployed flags a saved draft that no longer matches what is deployed", () => {
  // AIW-288: a rollback rewrites the deployed pointer without touching the
  // saved draft, so the two semantic keys diverge even though nothing about
  // the draft itself changed.
  assert.equal(draftDiffersFromDeployed('{"v":9}', '{"v":6}'), true);
});

test("draftDiffersFromDeployed reports no divergence once the draft matches deployed again", () => {
  assert.equal(draftDiffersFromDeployed('{"v":6}', '{"v":6}'), false);
});

test("draftDiffersFromDeployed has nothing to compare when either side is missing", () => {
  assert.equal(draftDiffersFromDeployed(null, '{"v":6}'), false);
  assert.equal(draftDiffersFromDeployed('{"v":9}', null), false);
  assert.equal(draftDiffersFromDeployed(null, null), false);
});

test("a Deploy that cannot be pressed says why, in the order the author has to act", () => {
  const ready = { hasTrigger: true, saveIssueCount: 0, dirty: true, hasDraft: true };
  assert.equal(deployUnavailableReason(ready), null);
  assert.equal(
    deployUnavailableReason({ ...ready, hasTrigger: false, saveIssueCount: 2 }),
    "Add a trigger block before deploying.",
  );
  assert.equal(
    deployUnavailableReason({ ...ready, saveIssueCount: 1 }),
    "Fix the block marked with an error before deploying.",
  );
  assert.equal(
    deployUnavailableReason({ ...ready, saveIssueCount: 3 }),
    "Fix the 3 blocks marked with an error before deploying.",
  );
  assert.equal(
    deployUnavailableReason({ ...ready, dirty: false, hasDraft: false }),
    "Nothing to deploy: the canvas holds no change and no saved draft.",
  );
});
