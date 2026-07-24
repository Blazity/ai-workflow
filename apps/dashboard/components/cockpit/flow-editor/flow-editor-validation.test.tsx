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
const transformContract: WorkflowBlockContract = {
  type: "transform",
  presentation: {
    group: "utility",
    label: "Transform",
    description: "Maps an object or filters an array.",
    color: "#64748B",
    softColor: "#EEF1F5",
    glyph: "↦",
  },
  defaults: {},
  ports: ["out"],
  allowsFailurePort: false,
  inputs: {},
  additionalInputs: [
    {
      keyPattern: "^[A-Za-z_][A-Za-z0-9_-]*$",
      schema: unknownSchema,
    },
  ],
  output: {
    schema: unknownSchema,
    bindingSchema: unknownSchema,
    statusVariants: ["ok"],
  },
  availability: { available: true, unavailableReason: null },
};
const branchContract: WorkflowBlockContract = {
  type: "branch",
  presentation: {
    group: "control",
    label: "Branch",
    description: "Routes execution by a condition.",
    color: "#7C3AED",
    softColor: "#F3E8FF",
    glyph: "◇",
  },
  defaults: {},
  ports: ["true", "false"],
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
const openPrContract: WorkflowBlockContract = {
  type: "open_pr",
  presentation: {
    group: "vcs",
    label: "Open PR",
    description: "Opens a pull request.",
    color: "#0F766E",
    softColor: "#CCFBF1",
    glyph: "P",
  },
  defaults: {},
  ports: ["out"],
  allowsFailurePort: true,
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
  availableValuesByNode: {},
};
const editorInteractionProps = {
  edgeGeometry: {},
  onNodePositionsChange: () => undefined,
  onEdgeGeometryChange: () => undefined,
  onGraphChange: () => undefined,
  canUndo: false,
  canRedo: false,
  onUndo: () => undefined,
  onRedo: () => undefined,
  onBeginTransaction: () => undefined,
  onCommitTransaction: () => undefined,
  onCancelTransaction: () => undefined,
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
      {...editorInteractionProps}
      schemaVersion={1}
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
      availableValuesByNode: {},
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
    {
      status: "valid",
      issues: [],
      nodeContracts: { entry: triggerContract },
      availableValuesByNode: {},
    },
    "Unable to save layout.",
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Unable to save layout/);
  assert.match(html, /data-error-presentation="inline"/);
  assert.doesNotMatch(html, /data-error-presentation="overlay"/);
});

test("a runnable deployed trigger shows the circular play button beside the node", () => {
  const html = renderToStaticMarkup(
    <FlowEditor
      nodes={[node]}
      edges={[]}
      {...editorInteractionProps}
      schemaVersion={1}
      limits={{}}
      onLimitsChange={() => undefined}
      onNodesChange={() => undefined}
      onEdgesChange={() => undefined}
      canEdit
      runnableTriggerIds={new Set(["entry"])}
      onRunTrigger={() => undefined}
      dirty={false}
      saveEnabled
      saving={false}
      error={null}
      validation={{
        status: "valid",
        issues: [],
        nodeContracts: { entry: triggerContract },
        availableValuesByNode: {},
      }}
      onSave={() => undefined}
      headerTitle="Ticket workflow"
      headerVersionBadge="deployed v3"
      options={options}
    />,
  );

  assert.match(html, /aria-label="Run Ticket received"/);
  assert.match(html, /h-7 w-7/);
  assert.match(html, /-right-\[38px\] -top-\[15px\]/);
  assert.match(html, /title="Run trigger"/);
});

test("draft-only triggers do not expose manual dispatch", () => {
  const html = renderEditor({
    status: "valid",
    issues: [],
    nodeContracts: { entry: triggerContract },
    availableValuesByNode: {},
  });
  assert.doesNotMatch(html, /aria-label="Run Ticket received"/);
});

test("editor actions and canvas controls expose keyboard labels and names", () => {
  const html = renderEditor({
    status: "valid",
    issues: [],
    nodeContracts: { entry: triggerContract },
    availableValuesByNode: {},
  });

  assert.match(html, /aria-label="Undo \(Ctrl\+Z\)"/);
  assert.match(html, /aria-label="Redo \(Ctrl\+Shift\+Z\)"/);
  assert.match(html, /aria-label="Copy \(Ctrl\+C\)"/);
  assert.match(html, /aria-label="Paste \(Ctrl\+V\)"/);
  assert.match(html, /aria-label="Zoom in"/);
  assert.match(html, /aria-label="Zoom out"/);
  assert.match(html, /aria-label="Fit workflow"/);
  assert.match(html, /data-canvas-node-id="entry"/);
  assert.match(
    html,
    /role="group" aria-label="Ticket trigger block controls"/,
  );
  assert.match(html, /data-canvas-node-selector="entry"/);
  assert.match(
    html,
    /<button[^>]+aria-label="Start connection from Ticket received, out output"/,
  );
});

test("a selected v2 Transform exposes typed inputs and its visual operation editor", () => {
  const transformNode: FlowNodeDef = {
    id: "map",
    type: "transform",
    name: "Shape context",
    x: 240,
    y: 40,
    params: {},
    inputs: {},
    v2: {
      configuration: {
        operation: "map_object",
        fields: [
          {
            name: "displayName",
            value: {
              kind: "input",
              source: { input: "profile", path: ["name"] },
            },
          },
        ],
      },
      inputs: {},
      additionalInputs: [
        {
          name: "profile",
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          binding: { kind: "literal", value: { name: "Ada" } },
        },
      ],
    },
  };
  const html = renderToStaticMarkup(
    <FlowEditor
      nodes={[node, transformNode]}
      edges={[{ id: "edge-1", from: "entry", to: "map" }]}
      {...editorInteractionProps}
      schemaVersion={2}
      limits={{}}
      onLimitsChange={() => undefined}
      onNodesChange={() => undefined}
      onEdgesChange={() => undefined}
      canEdit
      dirty
      saveEnabled
      saving={false}
      error={null}
      validation={{
        status: "valid",
        issues: [],
        nodeContracts: { entry: triggerContract, map: transformContract },
        availableValuesByNode: { map: [] },
      }}
      onSave={() => undefined}
      headerTitle="V2 workflow"
      headerVersionBadge="draft"
      options={
        {
          ...options,
          blockRegistry: {
            trigger_ticket_ai: triggerContract,
            transform: transformContract,
          },
        } as WorkflowEditorOptions
      }
      initialSelectedId="map"
    />,
  );

  assert.match(html, /Input values/);
  assert.match(html, /profile/);
  assert.match(html, /Add typed input/);
  assert.match(html, /Map object/);
  assert.match(html, /displayName/);
  assert.match(html, /Default when absent/);
});

function renderSelectedBranch(schemaVersion: 1 | 2): string {
  const branchNode: FlowNodeDef = {
    id: "decision",
    type: "branch",
    name: "Review decision",
    x: 240,
    y: 40,
    params:
      schemaVersion === 1
        ? { condition: "steps.review.output.ok == true" }
        : {},
    inputs: {},
    ...(schemaVersion === 2
      ? {
          v2: {
            configuration: {
              condition: {
                kind: "eq",
                left: {
                  kind: "path",
                  reference: "steps.review.output.ok",
                },
                right: { kind: "lit", value: true },
              },
            },
            inputs: {},
            additionalInputs: [],
          },
        }
      : {}),
  };

  return renderToStaticMarkup(
    <FlowEditor
      nodes={[node, branchNode]}
      edges={[
        {
          ...(schemaVersion === 2 ? { id: "edge-entry-decision" } : {}),
          from: "entry",
          to: "decision",
        },
      ]}
      {...editorInteractionProps}
      schemaVersion={schemaVersion}
      limits={{}}
      onLimitsChange={() => undefined}
      onNodesChange={() => undefined}
      onEdgesChange={() => undefined}
      canEdit
      dirty
      saveEnabled
      saving={false}
      error={null}
      validation={{
        status: "valid",
        issues: [],
        nodeContracts: {
          entry: triggerContract,
          decision: branchContract,
        },
        availableValuesByNode: { decision: [] },
      }}
      onSave={() => undefined}
      headerTitle="Branch workflow"
      headerVersionBadge="draft"
      options={
        {
          ...options,
          blockRegistry: {
            trigger_ticket_ai: triggerContract,
            branch: branchContract,
          },
        } as WorkflowEditorOptions
      }
      initialSelectedId="decision"
    />,
  );
}

test("v2 Branch replaces the legacy expression field with a typed visual editor", () => {
  assert.match(
    renderSelectedBranch(1),
    /placeholder="steps\.review\.output\.ok == true"/,
  );
  const v2 = renderSelectedBranch(2);
  assert.doesNotMatch(v2, /placeholder="steps\.review\.output\.ok == true"/);
  assert.match(v2, /Branch decision/);
  assert.match(v2, /Values are equal/);
  assert.match(v2, /The saved value is unavailable in the current workflow/);
  assert.doesNotMatch(v2, /steps\.review\.output\.ok/);
});

function renderSelectedOpenPr(schemaVersion: 1 | 2): string {
  const openPrNode: FlowNodeDef = {
    id: "publish",
    type: "open_pr",
    name: "Publish",
    x: 240,
    y: 40,
    params: {},
    inputs: {},
    ...(schemaVersion === 2
      ? {
          v2: {
            configuration: {},
            inputs: {},
            additionalInputs: [],
          },
        }
      : {}),
  };

  return renderToStaticMarkup(
    <FlowEditor
      nodes={[node, openPrNode]}
      edges={[
        {
          ...(schemaVersion === 2 ? { id: "edge-entry-publish" } : {}),
          from: "entry",
          to: "publish",
        },
      ]}
      {...editorInteractionProps}
      schemaVersion={schemaVersion}
      limits={{}}
      onLimitsChange={() => undefined}
      onNodesChange={() => undefined}
      onEdgesChange={() => undefined}
      canEdit
      dirty
      saveEnabled
      saving={false}
      error={null}
      validation={{
        status: "valid",
        issues: [],
        nodeContracts: {
          entry: triggerContract,
          publish: openPrContract,
        },
        availableValuesByNode: { publish: [] },
      }}
      onSave={() => undefined}
      headerTitle="Publish workflow"
      headerVersionBadge="draft"
      options={
        {
          ...options,
          blockRegistry: {
            trigger_ticket_ai: triggerContract,
            open_pr: openPrContract,
          },
        } as WorkflowEditorOptions
      }
      initialSelectedId="publish"
    />,
  );
}

test("v2 canvas never exposes an execution-failure port", () => {
  assert.match(renderSelectedOpenPr(1), />failed<\/span>/);
  assert.doesNotMatch(renderSelectedOpenPr(2), />failed<\/span>/);
});
