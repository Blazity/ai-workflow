import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";

import type {
  WebhookEndpointConfigResponse,
  WorkflowDefinitionV2,
  WorkflowEditorOptions,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { ConfigFields } from "./config-fields";
import { PromptAuthoringProvider } from "./prompt-authoring-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

const activeConfig: WebhookEndpointConfigResponse = {
  state: "active",
  endpoint: {
    endpointId: "wh_9f3c",
    url: "https://worker.example.com/webhooks/custom/wh_9f3c",
    authScheme: "hmac_sha256",
    headerName: "X-Workflow-Signature",
    maskedSecret: "whsec_••••••••8a41",
    hasPendingRotation: false,
    previousExpiresAt: null,
    rejectionsToday: [],
  },
};

const CLEARTEXT = "whsec_live_cleartext_2f7ad91b";

function tree(
  node: FlowNodeDef,
  onChange: (path: string, value: unknown) => void,
) {
  return (
    <PromptAuthoringProvider
      availableValues={[]}
      onV2ConfigurationChange={() => undefined}
      previewCandidate={{
        definitionId: 42,
        definition: {} as WorkflowDefinitionV2,
        blockId: node.id,
      }}
    >
      <ConfigFields node={node} options={options} canEdit onChange={onChange} />
    </PromptAuthoringProvider>
  );
}

function nodeText(instance: ReactTestInstance): string {
  return instance.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

function byAria(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root.findAll(
    (instance) =>
      typeof instance.type === "string" &&
      instance.props["aria-label"] === label,
  );
  assert.equal(matches.length, 1, `expected exactly one element labelled ${label}`);
  return matches[0];
}

/** The confirm panel's confirm button and the field's Reveal button share their
 *  text; only the field one carries an aria-label, so match on its absence. */
function confirmButton(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root
    .findAll((instance) => instance.type === "button")
    .filter(
      (instance) =>
        instance.props["aria-label"] == null &&
        nodeText(instance).trim() === text,
    );
  assert.equal(matches.length, 1, `expected exactly one confirm button ${text}`);
  return matches[0];
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

// An optional key that the registry defaults for must clear on empty rather than
// persist "", or the worker's strict schema rejects the deploy.
test("emptying the header name deletes the param instead of storing a blank", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ state: "await_deploy", endpoint: null })) as typeof fetch;
  const changes: [string, unknown][] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        tree(webhookNode({ headerName: "X-Custom-Header" }), (path, value) =>
          changes.push([path, value]),
        ),
      );
    });
    await settle();

    const header = renderer.root.findAll(
      (instance) =>
        instance.type === "input" && instance.props.value === "X-Custom-Header",
    );
    assert.equal(header.length, 1);
    await act(async () => header[0].props.onChange({ target: { value: "" } }));

    assert.deepEqual(changes, [["params.headerName", undefined]]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

// Reveal must survive a later reload failure and Copy must lift the cleartext,
// never the mask, so drive the real container through the confirm flow.
test("reveal shows the cleartext once; Copy lifts it and Hide drops it", async () => {
  const originalFetch = globalThis.fetch;
  const configCalls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/webhook/config")) {
      configCalls.push(path);
      return Response.json(activeConfig);
    }
    if (path.endsWith("/webhook/deliveries")) {
      return Response.json({ deliveries: [] });
    }
    if (path.endsWith("/webhook/reveal") && init?.method === "POST") {
      return Response.json({ endpointId: "wh_9f3c", secret: CLEARTEXT });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  const clipboard: string[] = [];
  const originalClipboard = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "clipboard",
  );
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        clipboard.push(value);
      },
    },
  });

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree(webhookNode(), () => undefined));
    });
    await settle();
    const root = () => renderer.root;

    // The config load runs exactly once on mount.
    assert.equal(configCalls.length, 1);

    // Open the reveal confirmation, then confirm it.
    await act(async () => byAria(root(), "Reveal signing secret").props.onClick());
    await act(async () => confirmButton(root(), "Reveal").props.onClick());
    await settle();

    const secretField = () =>
      byAria(root(), "Webhook signing secret").props.value as string;
    assert.equal(secretField(), CLEARTEXT);
    // Reviewer 5: reveal must not reload config, or a failed reload would wipe
    // the one-time cleartext we just displayed.
    assert.equal(configCalls.length, 1);

    // Copy lifts the cleartext, never the mask.
    await act(async () => byAria(root(), "Copy signing secret").props.onClick());
    assert.deepEqual(clipboard, [CLEARTEXT]);

    // Hide drops the cleartext and the mask returns.
    await act(async () => byAria(root(), "Hide signing secret").props.onClick());
    assert.equal(secretField(), activeConfig.endpoint!.maskedSecret);
    assert.equal(
      root().findAll(
        (instance) =>
          typeof instance.type === "string" &&
          instance.props.value === CLEARTEXT,
      ).length,
      0,
    );
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    } else {
      delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    }
  }
});
