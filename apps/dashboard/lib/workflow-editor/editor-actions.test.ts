import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowEditorActions } from "./editor-actions.ts";

test("an invalid semantic draft remains saveable but cannot deploy", () => {
  assert.deepEqual(
    workflowEditorActions({
      dirty: true,
      structurallyValid: true,
      hasDraft: true,
      validationStatus: "invalid",
      validationIsCurrent: true,
    }),
    { canSave: true, canDeploy: false },
  );
});

test("deploy requires a current successful validation of a clean draft", () => {
  assert.deepEqual(
    workflowEditorActions({
      dirty: false,
      structurallyValid: true,
      hasDraft: true,
      validationStatus: "valid",
      validationIsCurrent: true,
    }),
    { canSave: false, canDeploy: true },
  );
  assert.equal(
    workflowEditorActions({
      dirty: false,
      structurallyValid: true,
      hasDraft: true,
      validationStatus: "valid",
      validationIsCurrent: false,
    }).canDeploy,
    false,
  );
});
