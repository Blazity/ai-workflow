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
import { ConfigFields, triggerRateWindowResetAt } from "./config-fields";
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
    // The two interactions an operator otherwise has to guess at: the limit caps
    // starts rather than concurrency, and the paths it does not cover.
    assert.match(html, /shared run pool still decides/);
    assert.match(html, /Manual dispatch and restarts from approvals are not limited/);
    // No max set: the window picker and the rejection banner stay hidden.
    assert.doesNotMatch(html, /Rate limit window/);
    assert.doesNotMatch(html, /Rejected by the rate limit today/);
  });
}

test("the window reset the rejection banner reports matches the worker's fixed windows", () => {
  const now = new Date("2026-02-01T10:00:31.500Z");

  assert.equal(
    triggerRateWindowResetAt("minute", now).toISOString(),
    "2026-02-01T10:01:00.000Z",
  );
  assert.equal(
    triggerRateWindowResetAt("hour", now).toISOString(),
    "2026-02-01T11:00:00.000Z",
  );
  assert.equal(
    triggerRateWindowResetAt("day", now).toISOString(),
    "2026-02-02T00:00:00.000Z",
  );
  // A calendar month, so February and a year boundary are not 30 days.
  assert.equal(
    triggerRateWindowResetAt("month", now).toISOString(),
    "2026-03-01T00:00:00.000Z",
  );
  assert.equal(
    triggerRateWindowResetAt("month", new Date("2026-12-20T00:00:00.000Z")).toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
});

test("the schedule rate limit note ties a refusal to the skip overlap policy", () => {
  const html = render(triggerNode("trigger_schedule"));

  assert.match(html, /skipped, the same way the skip overlap policy skips one/);
  assert.match(html, /never replayed once the window resets/);
});

test("only the schedule note mentions the overlap policy", () => {
  assert.doesNotMatch(render(triggerNode("trigger_webhook")), /overlap policy/);
  assert.doesNotMatch(render(triggerNode("trigger_ticket_ai")), /overlap policy/);
});

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

test("investigate hides a provider's fields when the selection omits it", () => {
  const html = render(investigateNode({}, { providers: ["slack"] }));

  assert.match(html, /Slack channels/);
  assert.doesNotMatch(html, /Jira JQL template/);
});

test("investigate reads the selection from flat params too", () => {
  const html = render(investigateNode({ providers: ["jira"] }, {}));

  assert.doesNotMatch(html, /Slack channels/);
  assert.match(html, /Jira JQL template/);
});

test("investigate caps max results at the retrieval ceiling", () => {
  const html = render(investigateNode());

  assert.match(html, /type="number" min="1" max="10"/);
});
