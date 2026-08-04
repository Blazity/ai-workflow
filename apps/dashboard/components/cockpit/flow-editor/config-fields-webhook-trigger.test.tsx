import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
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

function webhookNode(id: string): FlowNodeDef {
  return {
    id,
    type: "trigger_webhook",
    name: "Webhook",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
    v2: { configuration: {}, inputs: {}, additionalInputs: [] },
  };
}

function render(nodeId = "n7", previewDefinitionId?: number): string {
  const node = webhookNode(nodeId);
  const previewCandidate =
    previewDefinitionId === undefined
      ? undefined
      : {
          definitionId: previewDefinitionId,
          definition: {} as WorkflowDefinitionV2,
          blockId: node.id,
        };
  return renderToStaticMarkup(
    <PromptAuthoringProvider
      availableValues={[]}
      onV2ConfigurationChange={() => undefined}
      previewCandidate={previewCandidate}
    >
      <ConfigFields
        node={node}
        options={options}
        canEdit
        onChange={() => undefined}
      />
    </PromptAuthoringProvider>,
  );
}

const ENDPOINT_RE =
  /https:\/\/ai-workflow-app\.vercel\.app\/webhooks\/custom\/wh_[0-9a-f]{16}/;

function endpoint(html: string): string {
  const match = html.match(ENDPOINT_RE);
  assert.ok(match, "expected a webhook endpoint URL in the markup");
  return match[0];
}

test("the webhook trigger inspector shows the endpoint above the signing secret", () => {
  const html = render();

  assert.ok(html.indexOf("Endpoint URL") < html.indexOf("Signing secret"));
  assert.match(html, /X-Workflow-Signature/);
  assert.match(html, /X-Delivery-Id/);
  assert.doesNotMatch(html, /X-Hub-Signature-256/);
});

test("the endpoint renders in full on the worker host, with no dashboard api prefix", () => {
  const html = render();

  assert.match(html, ENDPOINT_RE);
  assert.doesNotMatch(html, /\/api\/v1\//);
  // The full URL has to survive the 320px inspector, so it wraps instead of scrolling.
  assert.match(html, /break-all/);
  assert.equal(html.match(/readOnly=""/g)?.length, 2);
  assert.equal(html.match(/aria-readonly="true"/g)?.length, 2);
});

test("the signing secret is masked until revealed and offers its own actions", () => {
  const html = render();

  assert.match(html, /whsec_•{32}/);
  assert.doesNotMatch(html, /whsec_[0-9a-f]/);
  assert.match(html, /Reveal<\/button>/);
  assert.equal(html.match(/Copy<\/button>/g)?.length, 2);
});

test("webhook endpoints are deterministic per node and never collide", () => {
  assert.equal(endpoint(render("n7")), endpoint(render("n7")));
  assert.notEqual(endpoint(render("n7")), endpoint(render("n8")));
  assert.notEqual(endpoint(render("n7", 42)), endpoint(render("n7", 43)));
  assert.notEqual(endpoint(render("n7")), endpoint(render("n7", 42)));
});
