import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  WorkflowBlockContract,
  WorkflowEditorOptions,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { ManualDispatchModal } from "./manual-dispatch-modal";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const unknownSchema = { type: "unknown" } as const;
const ticketContract: WorkflowBlockContract = {
  type: "trigger_ticket_ai",
  presentation: {
    group: "trigger",
    label: "Ticket assigned to AI",
    description: "Starts from Jira.",
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
const prContract: WorkflowBlockContract = {
  ...ticketContract,
  type: "trigger_pr_created",
  presentation: {
    ...ticketContract.presentation,
    label: "PR created",
  },
};
const options = {
  defaultModel: "model",
  blockRegistry: {
    trigger_ticket_ai: ticketContract,
    trigger_pr_created: prContract,
  },
} as WorkflowEditorOptions;

function render(trigger: FlowNodeDef, dirty = false) {
  return renderToStaticMarkup(
    <ManualDispatchModal
      definitionId={9}
      workflowName="Standard delivery"
      deployedVersion={7}
      trigger={trigger}
      options={options}
      actorLabel="Karol"
      dirty={dirty}
      onClose={() => undefined}
    />,
  );
}

test("ticket modal names the exact deployed version and excludes dirty drafts", () => {
  const html = render(
    {
      id: "ticket-trigger",
      type: "trigger_ticket_ai",
      name: "Ticket assigned to AI",
      x: 0,
      y: 0,
      params: {},
      inputs: {},
    },
    true,
  );
  assert.match(html, /Run from Ticket assigned to AI/);
  assert.match(html, /Standard delivery · deployed v7/);
  assert.match(html, /Unsaved draft changes are excluded/);
  assert.match(html, /Ticket key/);
  assert.match(html, /Requested by Karol/);
});

test("PR modal accepts an authoritative provider URL without Jira movement copy", () => {
  const html = render({
    id: "pr-trigger",
    type: "trigger_pr_created",
    name: "PR created",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  });
  assert.match(html, /Pull or merge request URL/);
  assert.match(html, /https:\/\/github\.com\/org\/repo\/pull\/123/);
  assert.doesNotMatch(html, /Move to AI/);
  assert.match(html, /One active run per pull request/);
});
