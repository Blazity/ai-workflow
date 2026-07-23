import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WorkflowDefinitionSaveResponse,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";
import {
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
