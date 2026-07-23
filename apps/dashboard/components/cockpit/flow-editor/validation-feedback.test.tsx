import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDefinitionValidationIssue } from "@shared/contracts";
import type { WorkflowValidationState } from "@/lib/workflow-editor/validation-controller";
import {
  groupValidationIssues,
  NodeValidationErrors,
  ValidationSummary,
} from "./validation-feedback";

const issues = [
  {
    code: "deployment",
    nodeId: null,
    message: "A trigger must reach an end block.",
  },
  {
    code: "deployment",
    nodeId: "implementation",
    message: 'Required input "plan" is missing.',
    path: "/nodes/2/inputs/plan",
  },
  {
    code: "deployment",
    nodeId: "implementation",
    message: "Output schema is invalid.",
  },
] as WorkflowDefinitionValidationIssue[];

test("groups workflow and block validation issues without losing order", () => {
  assert.deepEqual(groupValidationIssues(issues), {
    workflow: [issues[0]],
    byNode: {
      implementation: [issues[1], issues[2]],
    },
  });
});

test("renders errors in a red overlay that can focus the affected block", () => {
  const validation: WorkflowValidationState = {
    status: "invalid",
    issues,
    nodeContracts: {},
    availableValuesByNode: {},
  };
  const html = renderToStaticMarkup(
    <ValidationSummary
      validation={validation}
      nodeNames={{ implementation: "Implementation" }}
      onSelectNode={() => undefined}
    />,
  );

  assert.match(html, /3 validation issues/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-error-presentation="overlay"/);
  assert.match(html, /absolute/);
  assert.match(html, /bg-red-50/);
  assert.match(html, /Workflow/);
  assert.match(html, /aria-label="Select block Implementation"/);
  assert.match(html, /2 errors/);
  assert.doesNotMatch(html, /amber/);
});

test("renders a selected block's validation errors expanded with its exact path", () => {
  const html = renderToStaticMarkup(
    <NodeValidationErrors nodeId="implementation" issues={issues.slice(1)} />,
  );

  assert.match(html, /aria-label="Validation errors"/);
  assert.match(html, /Validation errors/);
  assert.match(html, /Required input &quot;plan&quot; is missing/);
  assert.match(html, /\/nodes\/2\/inputs\/plan/);
  assert.match(html, /border-red-200/);
  assert.doesNotMatch(html, /<details/);
});
