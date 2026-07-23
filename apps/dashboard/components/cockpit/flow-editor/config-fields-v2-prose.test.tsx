import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  WorkflowAvailableValue,
  WorkflowEditorOptions,
} from "@shared/contracts";
import type { FlowNodeDef, WorkflowBlockType } from "@/lib/flows";
import { ConfigFields } from "./config-fields";
import { PromptAuthoringProvider } from "./prompt-authoring-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const options = {
  agentKind: "claude",
  defaultModel: "claude-sonnet",
  defaultModels: {
    claude: "claude-sonnet",
    codex: "gpt-5",
  },
  models: {
    claude: ["claude-sonnet"],
    codex: ["gpt-5"],
  },
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

const availableValues: WorkflowAvailableValue[] = [
  {
    reference: "steps.entry.output.ticketKey",
    label: "Active trigger · ticketKey",
    description: "Ticket identifier.",
    schema: { type: "string" },
    source: { kind: "entry", nodeId: null, blockType: null },
    guarantee: {
      kind: "active_entry",
      triggerNodeIds: ["trigger"],
      viaEdgeIds: [],
    },
    compatibleInputNames: [],
  },
];

function node(
  type: WorkflowBlockType,
  schemaVersion: 1 | 2,
  params: FlowNodeDef["params"],
): FlowNodeDef {
  return {
    id: `${type}-${schemaVersion}`,
    type,
    name: type,
    x: 0,
    y: 0,
    params,
    inputs: {},
    ...(schemaVersion === 2
      ? {
          v2: {
            configuration: params,
            inputs: {},
            additionalInputs: [],
          },
        }
      : {}),
  };
}

function render(nodeDefinition: FlowNodeDef): string {
  return renderToStaticMarkup(
    <PromptAuthoringProvider
      availableValues={availableValues}
      onV2ConfigurationChange={() => undefined}
    >
      <ConfigFields
        node={nodeDefinition}
        options={options}
        canEdit
        onChange={() => undefined}
      />
    </PromptAuthoringProvider>,
  );
}

test("Open PR uses canonical value authoring in v2 and legacy variables only in v1", () => {
  const v2 = render(
    node("open_pr", 2, {
      title: "PR for {{data:steps.entry.output.ticketKey}}",
      body: "Ticket {{data:steps.entry.output.ticketKey}}",
    }),
  );
  assert.match(v2, /Insert workflow value/);
  assert.match(v2, /Use the Value picker/);
  assert.doesNotMatch(v2, /Insert variable/);
  assert.doesNotMatch(v2, /\{\{ticket_key\}\}/);

  const v1 = render(
    node("open_pr", 1, {
      title: "[{{ticket_key}}] {{ticket_title}}",
      body: "{{change_summary}}",
    }),
  );
  assert.match(v1, /Insert variable/);
  assert.match(v1, /\{\{ticket_key\}\}/);
  assert.match(v1, /substituted at run time/);
});

test("Human Question uses one canonical chip editor per question only in v2", () => {
  const v2 = render(
    node("human_question", 2, {
      questions: [
        "Review {{data:steps.entry.output.ticketKey}}?",
      ],
    }),
  );
  assert.match(v2, /Insert workflow value/);
  assert.match(v2, /\+ Add question/);
  assert.doesNotMatch(v2, /One question per line/);
  assert.doesNotMatch(v2, /Insert variable/);

  const v1 = render(
    node("human_question", 1, {
      questions: ["Review {{ticket_key}}?"],
    }),
  );
  assert.match(v1, /One question per line/);
  assert.doesNotMatch(v1, /\+ Add question/);
});

test("all v2 comment and notification prose fields use canonical value authoring", () => {
  const cases: Array<{
    type: WorkflowBlockType;
    params: FlowNodeDef["params"];
  }> = [
    {
      type: "post_ticket_comment",
      params: { body: "{{data:steps.entry.output.ticketKey}}" },
    },
    {
      type: "post_pr_comment",
      params: {
        body: "{{data:steps.entry.output.ticketKey}}",
        target: "primary",
      },
    },
    {
      type: "send_slack_message",
      params: {
        message: "{{data:steps.entry.output.ticketKey}}",
        sendOn: "always",
      },
    },
    {
      type: "terminate",
      params: {
        terminalStatus: "done",
        postComment: "{{data:steps.entry.output.ticketKey}}",
      },
    },
  ];

  for (const item of cases) {
    const html = render(node(item.type, 2, item.params));
    assert.match(html, /Insert workflow value/, item.type);
    assert.doesNotMatch(html, /Insert variable/, item.type);
    assert.doesNotMatch(html, /\{\{pr_url\}\}/, item.type);
  }
});
