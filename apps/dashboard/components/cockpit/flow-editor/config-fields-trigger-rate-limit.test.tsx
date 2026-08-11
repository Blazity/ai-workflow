import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  JsonValue,
  WorkflowDefinitionV2,
  WorkflowEditorOptions,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { ConfigFields } from "./config-fields";
import { PromptAuthoringProvider } from "./prompt-authoring-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const options = {
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

function triggerNode(
  type: FlowNodeDef["type"],
  params: FlowNodeDef["params"] = {},
): FlowNodeDef {
  return {
    id: "n1",
    type,
    name: "Trigger",
    x: 0,
    y: 0,
    params,
    inputs: {},
    v2: { configuration: params, inputs: {}, additionalInputs: [] },
  };
}

function render(
  node: FlowNodeDef,
  changes: [string, unknown][] = [],
): string {
  return renderToStaticMarkup(
    <PromptAuthoringProvider
      availableValues={[]}
      onV2ConfigurationChange={() => undefined}
      previewCandidate={{
        definitionId: 42,
        definition: {} as WorkflowDefinitionV2,
        blockId: node.id,
      }}
    >
      <ConfigFields
        node={node}
        options={options}
        canEdit
        onChange={(path, value) => changes.push([path, value])}
      />
    </PromptAuthoringProvider>,
  );
}

const RATE_LIMIT_NOTE = /up to 2× the limit can start around a window boundary/;

for (const type of [
  "trigger_ticket_ai",
  "trigger_pr_created",
  "trigger_pr_merged",
  "trigger_webhook",
  "trigger_schedule",
] as const) {
  test(`${type} renders the rate limit fields with the fixed-window note`, () => {
    const html = render(triggerNode(type));

    assert.match(html, /Max workflow starts/);
    assert.match(html, RATE_LIMIT_NOTE);
    assert.match(html, /calendar month in UTC/);
    // No max set: the window picker and the rejection banner stay hidden.
    assert.doesNotMatch(html, /Rate limit window/);
    assert.doesNotMatch(html, /Rejected by the rate limit today/);
  });
}

test("the window picker renders once a max is set and binds the stored window", () => {
  const html = render(
    triggerNode("trigger_pr_created", { rateLimitMax: 20, rateLimitWindow: "hour" }),
  );

  assert.match(html, /Rate limit window/);
  assert.match(html, /value="20"/);
  assert.match(html, /Per hour/);
});

test("the webhook rate limit note names the endpoint's own limits", () => {
  const html = render(triggerNode("trigger_webhook"));

  assert.match(html, /in addition to the endpoint/);
  assert.match(html, /600\/min ingress, 60\/min inbox/);
});

test("the ticket trigger rate limit note does not mention endpoint limits", () => {
  const html = render(triggerNode("trigger_ticket_ai"));

  assert.doesNotMatch(html, /600\/min ingress/);
});

function investigateNode(
  params: FlowNodeDef["params"] = {},
  configuration?: Record<string, unknown>,
): FlowNodeDef {
  return {
    id: "n2",
    type: "investigate",
    name: "Investigate",
    x: 0,
    y: 0,
    params,
    inputs: {},
    v2: {
      configuration: (configuration ?? params) as Record<string, JsonValue>,
      inputs: {},
      additionalInputs: [],
    },
  } as unknown as FlowNodeDef;
}

test("investigate renders providers, slack defaults, jql, max results and model", () => {
  const html = render(investigateNode());

  assert.match(html, /Context providers/);
  assert.match(html, /Jira \(similar tickets\)/);
  assert.match(html, /Slack \(channel history\)/);
  assert.match(html, /Slack channels/);
  assert.match(html, /Slack lookback \(days\)/);
  assert.match(html, /value="30"/);
  assert.match(html, /Jira JQL template \(optional\)/);
  assert.match(html, /Max results per provider/);
  assert.match(html, /value="10"/);
  assert.match(html, /Model \(optional\)/);
});

test("investigate hides a provider's fields when that provider is off", () => {
  const html = render(
    investigateNode({}, { providers: { jira: false, slack: true } }),
  );

  assert.match(html, /Slack channels/);
  assert.doesNotMatch(html, /Jira JQL template/);
});

test("investigate reads providers stored in flat params too", () => {
  const node = investigateNode(
    { providers: { jira: true, slack: false } } as unknown as FlowNodeDef["params"],
    {},
  );
  const html = render(node);

  assert.doesNotMatch(html, /Slack channels/);
  assert.match(html, /Jira JQL template/);
});
