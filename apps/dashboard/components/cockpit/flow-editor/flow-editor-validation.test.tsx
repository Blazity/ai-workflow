import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  WorkflowBlockContract,
  WorkflowEditorOptions,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import type { WorkflowValidationState } from "@/lib/workflow-editor/validation-controller";
import { FlowEditor } from "./flow-editor";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const unknownSchema = { type: "unknown" } as const;
const triggerContract: WorkflowBlockContract = {
  type: "trigger_ticket_ai",
  presentation: {
    group: "trigger",
    label: "Ticket trigger",
    description: "Starts a workflow from a ticket.",
    color: "#3C43E7",
    softColor: "#EEF0FF",
    glyph: "T",
  },
  defaults: {},
  ports: ["next"],
  allowsFailurePort: false,
  inputs: {},
  additionalInputs: [],
  output: {
    schema: unknownSchema,
    bindingSchema: unknownSchema,
    statusVariants: ["ok"],
  },
  availability: { available: true, unavailableReason: null },
};
const options = {
  defaultModel: "model",
  blockRegistry: { trigger_ticket_ai: triggerContract },
} as WorkflowEditorOptions;
const node: FlowNodeDef = {
  id: "entry",
  type: "trigger_ticket_ai",
  name: "Ticket received",
  x: 40,
  y: 40,
  params: {},
  inputs: {},
};
const validation: WorkflowValidationState = {
  status: "invalid",
  issues: [
    {
      code: "deployment",
      severity: "error",
      nodeId: "entry",
      path: "/nodes/0/params",
      message: "Trigger configuration is incomplete.",
    },
  ],
  nodeContracts: { entry: triggerContract },
};

function renderEditor(
  validationState: WorkflowValidationState,
  error: string | null = null,
  initialSelectedId?: string,
) {
  return renderToStaticMarkup(
    <FlowEditor
      nodes={[node]}
      edges={[]}
      limits={{}}
      onLimitsChange={() => undefined}
      onNodesChange={() => undefined}
      onEdgesChange={() => undefined}
      canEdit
      dirty
      saveEnabled
      saving={false}
      error={error}
      validation={validationState}
      onSave={() => undefined}
      headerTitle="Ticket workflow"
      headerVersionBadge="draft"
      options={options}
      initialSelectedId={initialSelectedId}
    />,
  );
}

test("invalid nodes have a red accessible outline and selected errors are expanded", () => {
  const html = renderEditor(validation, null, "entry");

  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="workflow-node-entry-validation-errors"/);
  assert.match(html, /border-red-500/);
  assert.match(html, /aria-label="Validation errors"/);
  assert.match(html, /Trigger configuration is incomplete/);
  assert.match(html, /\/nodes\/0\/params/);
  assert.doesNotMatch(html, /border-amber-300 bg-amber-50/);
});

test("immediate validation transport and supersession errors occupy no flow layout", () => {
  for (const issue of [
    {
      code: "validation.transport",
      severity: "error" as const,
      nodeId: null,
      message: "Validation service is unavailable.",
    },
    {
      code: "validation.superseded",
      severity: "error" as const,
      nodeId: null,
      message: "The workflow changed while it was being validated.",
    },
  ]) {
    const html = renderEditor({
      status: "error",
      issues: [issue],
      nodeContracts: {},
    });

    assert.match(html, /role="alert"/);
    assert.match(html, new RegExp(issue.message.replace(".", "\\.")));
    assert.match(html, /data-error-presentation="overlay"/);
    assert.match(html, /class="absolute /);
    assert.doesNotMatch(html, /data-error-presentation="inline"/);
  }
});

test("generic editor errors retain their in-flow presentation", () => {
  const html = renderEditor(
    { status: "valid", issues: [], nodeContracts: { entry: triggerContract } },
    "Unable to save layout.",
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Unable to save layout/);
  assert.match(html, /data-error-presentation="inline"/);
  assert.doesNotMatch(html, /data-error-presentation="overlay"/);
});
