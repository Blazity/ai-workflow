import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  WebhookEndpointConfigResponse,
  WebhookTestDeliveryResponse,
  WorkflowDefinitionV2,
  WorkflowEditorOptions,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import {
  ConfigFields,
  WebhookDeliveriesSection,
  WebhookEndpointSection,
  describeRotationWindow,
  formatWebhookInstant,
} from "./config-fields";
import {
  WebhookTestDeliveryModal,
  WebhookTestDeliveryResultView,
} from "./webhook-test-delivery-modal";
import { PromptAuthoringProvider } from "./prompt-authoring-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const options = {
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

function webhookNode(params: FlowNodeDef["params"] = {}): FlowNodeDef {
  return {
    id: "n7",
    type: "trigger_webhook",
    name: "Webhook",
    x: 0,
    y: 0,
    params,
    inputs: {},
    v2: { configuration: params, inputs: {}, additionalInputs: [] },
  };
}

function render(
  node: FlowNodeDef = webhookNode(),
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

const activeConfig: WebhookEndpointConfigResponse = {
  state: "active",
  endpoint: {
    endpointId: "wh_9f3c",
    url: "https://worker.example.com/webhooks/custom/wh_9f3c",
    authScheme: "hmac_sha256",
    headerName: "X-Workflow-Signature",
    requireTimestamp: false,
    timestampHeader: "X-Workflow-Timestamp",
    timestampToleranceSeconds: 300,
    maskedSecret: "whsec_••••••••8a41",
    hasPendingRotation: false,
    previousExpiresAt: null,
    rejectionsToday: [],
  },
};

function endpoint(
  overrides: Partial<Parameters<typeof WebhookEndpointSection>[0]> = {},
): string {
  return renderToStaticMarkup(
    <WebhookEndpointSection
      config={activeConfig}
      loading={false}
      loadError={null}
      canEdit
      busy={false}
      actionError={null}
      confirm={null}
      secret={null}
      copied={null}
      copyError={false}
      now={Date.parse("2026-08-05T10:00:00.000Z")}
      onCopyUrl={() => undefined}
      onCopySecret={() => undefined}
      onDismissSecret={() => undefined}
      onConfirmRequest={() => undefined}
      onConfirmCancel={() => undefined}
      onConfirmRun={() => undefined}
      onReload={() => undefined}
      {...overrides}
    />,
  );
}

test("the mock endpoint and secret are gone from the inspector", () => {
  const html = render();

  assert.doesNotMatch(html, /ai-workflow-app\.vercel\.app/);
  assert.doesNotMatch(html, /whsec_/);
  assert.doesNotMatch(html, /webhooks\/custom/);
});

test("node config is editable and shows the registry defaults as placeholders", () => {
  const html = render();

  assert.match(html, /Authentication/);
  assert.match(html, /HMAC SHA-256 signature/);
  assert.match(html, /placeholder="X-Workflow-Signature"/);
  // Subject path is an example, not a styled default a reader could mistake for
  // an applied value.
  assert.match(html, /placeholder="e\.g\. ticket\.id"/);
  for (const placeholder of ["subject", "description", "requester", "priority"]) {
    assert.match(html, new RegExp(`placeholder="${placeholder}"`));
  }
});

test("the editable controls warn that scheme and header changes need a deploy", () => {
  const html = render();

  assert.match(html, /apply after you deploy/);
});

test("the subject path note spells out that empty means no coalescing", () => {
  const html = render();

  assert.match(html, /Empty means every delivery starts its own run \(no coalescing\)/);
});

test("the header placeholder follows the selected scheme", () => {
  const html = render(webhookNode({ authScheme: "shared_token" }));

  assert.match(html, /placeholder="X-Workflow-Token"/);
  assert.doesNotMatch(html, /placeholder="X-Workflow-Signature"/);
});

test("configured mappings render as values, not placeholders", () => {
  const html = render(
    webhookNode({ subjectPath: "ticket.id", mapSubject: "ticket.summary" }),
  );

  assert.match(html, /value="ticket\.id"/);
  assert.match(html, /value="ticket\.summary"/);
});

test("the notes explain the auth schemes and the mapping semantics", () => {
  const html = render();

  assert.match(html, /signs the raw request body/);
  assert.match(html, /X-Workflow-Token/);
  assert.match(html, /dot-paths into the delivered JSON body/);
  assert.match(html, /becomes an empty string/);
  assert.match(html, /coalesce onto the run already handling it/);
});

test("hmac shows the replay-protection checkbox and hides the details until it is on", () => {
  const html = render();

  assert.match(html, /Replay protection/);
  assert.match(html, /Require a signed timestamp/);
  // Off by default: the header, tolerance and note stay hidden.
  assert.doesNotMatch(html, /Timestamp header/);
  assert.doesNotMatch(html, /Tolerance \(seconds\)/);
});

test("turning on the timestamp flag reveals the header, tolerance and how to sign", () => {
  const html = render(
    webhookNode({ requireTimestamp: true, timestampToleranceSeconds: 600 }),
  );

  assert.match(html, /Timestamp header/);
  assert.match(html, /placeholder="X-Workflow-Timestamp"/);
  assert.match(html, /Tolerance \(seconds\)/);
  assert.match(html, /value="600"/);
  assert.match(html, /\{timestamp\}\.\{rawBody\}/);
  assert.match(html, /body-only senders like Sentry/);
});

test("shared token hides replay protection entirely", () => {
  const html = render(
    webhookNode({ authScheme: "shared_token", requireTimestamp: true }),
  );

  assert.doesNotMatch(html, /Replay protection/);
  assert.doesNotMatch(html, /Require a signed timestamp/);
  assert.doesNotMatch(html, /Timestamp header/);
});

test("a deployed endpoint with replay protection on shows the header and tolerance", () => {
  const html = endpoint({
    config: {
      state: "active",
      endpoint: {
        ...activeConfig.endpoint!,
        requireTimestamp: true,
        timestampHeader: "X-Zendesk-Timestamp",
        timestampToleranceSeconds: 600,
      },
    },
  });

  assert.match(html, /Deployed replay protection/);
  assert.match(html, /X-Zendesk-Timestamp/);
  assert.match(html, /600s/);
});

test("a deployed endpoint with replay protection off hides that row", () => {
  const html = endpoint();

  assert.doesNotMatch(html, /Deployed replay protection/);
});

test("an unconfigured deployment names the encryption key, not a generic secret", () => {
  const html = endpoint({ config: { state: "unconfigured", endpoint: null } });

  assert.match(html, /WEBHOOK_TRIGGER_ENCRYPTION_KEY/);
  assert.match(html, /redeploy/);
  assert.doesNotMatch(html, /Endpoint URL/);
  assert.doesNotMatch(html, /Rotate/);
});

test("a draft-only trigger points at deploy and can refresh without a remount", () => {
  const html = endpoint({ config: { state: "await_deploy", endpoint: null } });

  assert.match(html, /Deploy the workflow/);
  assert.match(html, /Refresh<\/button>/);
  assert.doesNotMatch(html, /Endpoint URL/);
});

test("an active endpoint shows the URL, deployed auth, a masked secret and both actions", () => {
  const html = endpoint();

  assert.ok(html.indexOf("Endpoint URL") < html.indexOf("Signing secret"));
  assert.match(html, /https:\/\/worker\.example\.com\/webhooks\/custom\/wh_9f3c/);
  assert.match(html, /whsec_••••••••8a41/);
  // Effective (deployed) scheme and header are shown read-only, so draft vs
  // deployed never reads as a contradiction.
  assert.match(html, /Deployed authentication/);
  assert.match(html, /Deployed header/);
  assert.match(html, /Reveal<\/button>/);
  assert.match(html, /Rotate<\/button>/);
  assert.match(html, /Revoke<\/button>/);
  // The full URL has to survive the 320px inspector, so it wraps instead of scrolling.
  assert.match(html, /break-all/);
  // Only the URL and the masked secret are editable-looking textareas; the
  // deployed rows are plain read-only text.
  assert.equal(html.match(/readOnly=""/g)?.length, 2);
  assert.equal(html.match(/aria-readonly="true"/g)?.length, 2);
});

test("an inactive endpoint banners that it is not receiving, distinct from revoked", () => {
  const html = endpoint({ config: { ...activeConfig, state: "inactive" as const } });

  assert.match(html, /not receiving/);
  assert.match(html, /another\s+workflow owns the webhook trigger/);
  assert.doesNotMatch(html, /This endpoint is revoked/);
  // The endpoint still exists, so its URL and management actions remain.
  assert.match(html, /Endpoint URL/);
  assert.match(html, /Rotate<\/button>/);
  assert.match(html, /Reveal<\/button>/);
});

test("a shared-token endpoint calls the value a token, not a signing secret", () => {
  const html = endpoint({
    config: {
      state: "active",
      endpoint: { ...activeConfig.endpoint!, authScheme: "shared_token" },
    },
  });

  assert.match(html, /Shared token/);
  assert.doesNotMatch(html, /Signing secret/);
});

test("a pending rotation dates the window and explains the previous verifiedWith", () => {
  const html = endpoint({
    config: {
      state: "active",
      endpoint: {
        ...activeConfig.endpoint!,
        hasPendingRotation: true,
        previousExpiresAt: "2026-08-05T10:45:00.000Z",
      },
    },
  });

  assert.match(html, /Rotation in flight/);
  assert.match(html, /in 45 minutes/);
  assert.match(html, /verified with previous/);
});

test("a revoked endpoint banners the outage and offers only unrevoke", () => {
  const html = endpoint({ config: { ...activeConfig, state: "revoked" as const } });

  assert.match(html, /This endpoint is revoked/);
  assert.match(html, /Unrevoke<\/button>/);
  assert.doesNotMatch(html, /Rotate<\/button>/);
  assert.doesNotMatch(html, /Revoke<\/button>/);
  assert.doesNotMatch(html, /Reveal<\/button>/);
});

test("every mutation confirms first and says what it costs", () => {
  assert.match(endpoint({ confirm: "reveal" }), /recorded in the audit log/);
  assert.match(endpoint({ confirm: "rotate" }), /previous one keeps working/);
  assert.match(
    endpoint({ confirm: "force_rotate" }),
    /ends the previous signing secret immediately/,
  );
  assert.match(endpoint({ confirm: "revoke" }), /refused from now on/);
  assert.match(
    endpoint({ confirm: "unrevoke", config: { ...activeConfig, state: "revoked" as const } }),
    /NEW signing secret/,
  );
});

test("shared-token confirm copy talks about the literal header token", () => {
  const sharedTokenConfig = {
    state: "active" as const,
    endpoint: { ...activeConfig.endpoint!, authScheme: "shared_token" as const },
  };

  assert.match(
    endpoint({ confirm: "reveal", config: sharedTokenConfig }),
    /literal value senders send in the header/,
  );
  assert.match(
    endpoint({ confirm: "rotate", config: sharedTokenConfig }),
    /A new shared token is issued/,
  );
});

test("a rotation conflict offers the force option next to its warning", () => {
  const html = endpoint({
    confirm: "force_rotate",
    actionError: "A rotation is already in flight, so the previous secret is still inside its acceptance window.",
  });

  assert.match(html, /already in flight/);
  assert.match(html, /Force rotate<\/button>/);
});

test("a revealed secret replaces the mask only while it is on screen", () => {
  const masked = endpoint();
  const revealed = endpoint({ secret: "whsec_live_2f7ad91b" });

  assert.doesNotMatch(masked, /whsec_live_2f7ad91b/);
  assert.match(revealed, /whsec_live_2f7ad91b/);
  assert.match(revealed, /Hide<\/button>/);
  assert.match(revealed, /only another reveal/);
});

test("a clipboard failure on the one-time secret offers a manual-copy fallback", () => {
  const html = endpoint({ secret: "whsec_live_2f7ad91b", copyError: true });

  assert.match(html, /Copy failed, select and copy manually/);
  // The cleartext is still on screen for the operator to select by hand.
  assert.match(html, /whsec_live_2f7ad91b/);
});

test("a failed load reports the reason and offers a retry", () => {
  const html = endpoint({ config: null, loadError: "Worker request timed out" });

  assert.match(html, /Worker request timed out/);
  assert.match(html, /Retry<\/button>/);
});

test("the delivery log renders every outcome with its reason and verification", () => {
  const html = renderToStaticMarkup(
    <WebhookDeliveriesSection
      deliveries={[
        {
          deliveryId: "d1",
          receivedAt: "2026-08-05T09:41:07.000Z",
          outcome: "started",
          reason: null,
          runId: "run_31",
          verifiedWith: "current",
        },
        {
          deliveryId: "d2",
          receivedAt: "2026-08-05T09:40:00.000Z",
          outcome: "pending",
          reason: "waiting for capacity",
          runId: null,
          verifiedWith: "previous",
        },
        {
          deliveryId: "d3",
          receivedAt: "2026-08-05T09:39:00.000Z",
          outcome: "test",
          reason: "dashboard probe",
          runId: null,
          verifiedWith: null,
        },
      ]}
      rejectionsToday={[
        { reason: "invalid_signature", count: 12 },
        { reason: "decrypt_failed", count: 3 },
      ]}
      loading={false}
      error={null}
      canTest
      onRefresh={() => undefined}
      onTest={() => undefined}
    />,
  );

  assert.match(html, />started</);
  assert.match(html, />pending</);
  assert.match(html, />test</);
  assert.match(html, /waiting for capacity/);
  assert.match(html, /run run_31/);
  assert.match(html, /verified with previous/);
  assert.match(html, /not authenticated/);
  assert.match(html, /2026-08-05 09:41:07 UTC/);
  assert.match(html, /Refresh<\/button>/);
  assert.match(html, /Send test<\/button>/);
});

test("the rejection summary carries a one-line cause per reason and a pre-dispatch note", () => {
  const html = renderToStaticMarkup(
    <WebhookDeliveriesSection
      deliveries={[]}
      rejectionsToday={[
        { reason: "invalid_signature", count: 12 },
        { reason: "decrypt_failed", count: 3 },
        { reason: "missing_signature", count: 1 },
        { reason: "rate_limited", count: 40 },
        { reason: "endpoint_disabled", count: 2 },
        { reason: "some_future_reason", count: 5 },
      ]}
      loading={false}
      error={null}
      canTest
      onRefresh={() => undefined}
      onTest={() => undefined}
    />,
  );

  assert.match(html, /Refused today/);
  assert.match(html, /invalid_signature 12/);
  assert.match(html, /signature does not match the secret/);
  assert.match(html, /decrypt_failed 3/);
  assert.match(html, /encryption key drift, redeploy config, not a sender issue/);
  assert.match(html, /sender is not sending the signature header/);
  assert.match(html, /throttled, too many deliveries per minute/);
  assert.match(html, /revoked, or the workflow is disabled/);
  // An unknown reason still renders its raw code and count, without a cause.
  assert.match(html, /some_future_reason 5/);
  // The counter is refusals before dispatch, distinct from the delivery log.
  assert.match(html, /counts refusals before dispatch/);
  assert.match(html, /appear in the delivery log/);
});

test("an empty log stays honest and hides the rejection summary", () => {
  const html = renderToStaticMarkup(
    <WebhookDeliveriesSection
      deliveries={[]}
      rejectionsToday={[]}
      loading={false}
      error={null}
      canTest={false}
      onRefresh={() => undefined}
      onTest={() => undefined}
    />,
  );

  assert.match(html, /No deliveries yet\./);
  assert.doesNotMatch(html, /Refused today/);
});

test("the rotation window reads as a countdown at every scale", () => {
  const now = Date.parse("2026-08-05T10:00:00.000Z");

  assert.equal(describeRotationWindow(null, now), "shortly");
  assert.equal(
    describeRotationWindow("2026-08-05T09:59:00.000Z", now),
    "any moment now",
  );
  assert.equal(
    describeRotationWindow("2026-08-05T10:00:20.000Z", now),
    "in under a minute",
  );
  assert.equal(describeRotationWindow("2026-08-05T10:01:00.000Z", now), "in 1 minute");
  assert.equal(describeRotationWindow("2026-08-05T12:00:00.000Z", now), "in 2 hours");
  assert.equal(describeRotationWindow("not-a-date", now), "shortly");
});

test("delivery timestamps stay in UTC and survive junk", () => {
  assert.equal(
    formatWebhookInstant("2026-08-05T09:41:07.123Z"),
    "2026-08-05 09:41:07 UTC",
  );
  assert.equal(formatWebhookInstant("later"), "later");
});

const testDeliveryResult: WebhookTestDeliveryResponse = {
  outcome: "test",
  reason: null,
  runId: null,
  deliveryId: "test:2f7a",
  subjectId: "TCK-4102",
  entry: {
    subject: "Card reader is offline",
    description: "",
    requester: "ops@example.com",
    priority: "high",
    payload: { subject: "Card reader is offline" },
  },
};

test("a test delivery reports its delivery id, mapped entry and subject id", () => {
  const html = renderToStaticMarkup(
    <WebhookTestDeliveryResultView result={testDeliveryResult} />,
  );

  assert.match(html, /test:2f7a/);
  assert.match(html, /TCK-4102/);
  assert.match(html, /Card reader is offline/);
  assert.match(html, /ops@example\.com/);
  assert.match(html, /\(empty\)/);
});

test("a test delivery without a subject id says what that means", () => {
  const html = renderToStaticMarkup(
    <WebhookTestDeliveryResultView
      result={{ ...testDeliveryResult, subjectId: null }}
    />,
  );

  assert.match(html, /own subject/);
});

test("the test delivery modal frames itself as a dry run that starts no workflow", () => {
  const html = renderToStaticMarkup(
    <WebhookTestDeliveryModal
      definitionId={42}
      nodeId="n7"
      triggerLabel="Webhook"
      onClose={() => undefined}
    />,
  );

  assert.match(html, /dry run/);
  assert.match(html, /no workflow starts/);
  assert.match(html, /no signature is checked/);
});
