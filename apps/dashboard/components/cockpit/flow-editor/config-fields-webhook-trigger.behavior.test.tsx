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

/** What `settle` watches: the reads these panels have out, and how many they
 *  have started, so a turn that started another one is not mistaken for quiet. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/**
 * Installs `handler` as the fetch for one test and returns the undo.
 *
 * Every answer lands a turn later, the way a response does: resolving in the
 * caller's own microtask is what let a counted wait look reliable.
 * `FIXTURE_SLOW_MS` delays every answer by that many milliseconds, which is
 * how this harness reproduces a runner slow enough to break a counted wait.
 */
function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const originalFetch = globalThis.fetch;
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    mine.inFlight += 1;
    mine.started += 1;
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      return handler(String(url), init);
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

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
    requireTimestamp: false,
    timestampHeader: "X-Workflow-Timestamp",
    timestampToleranceSeconds: 300,
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

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the chain of loads a panel starts finish, and waits for exactly that.
 *
 * NEVER A COUNT OF TURNS. How many turns a chain costs is the runner's
 * business, so a fixed count passes on an idle machine and, on a loaded one,
 * returns while reads are still in flight: the assertion then reads a loading
 * panel and the failure looks like the product. Quiet is the condition those
 * assertions mean, and it is two things, because a read that lands usually
 * starts the next one: nothing in flight, and a turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of
 * failing, and a panel that never settles fails as a readable timeout rather
 * than hanging the suite.
 */
async function settle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await turn();
    if (reads.inFlight === 0) {
      const started = reads.started;
      await turn();
      if (reads.inFlight === 0 && reads.started === started) return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`the panel was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`);
    }
  }
}


// An optional key that the registry defaults for must clear on empty rather than
// persist "", or the worker's strict schema rejects the deploy.
test("emptying the header name deletes the param instead of storing a blank", async () => {
  const restore = installFetch(async () =>
    Response.json({ state: "await_deploy", endpoint: null }));
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
    restore();
  }
});

// The replay-protection checkbox writes the boolean flag; the tolerance input
// parses to an int and clears the key on a non-numeric value.
test("toggling replay protection writes the flag; the tolerance parses to an int", async () => {
  const restore = installFetch(async () =>
    Response.json({ state: "await_deploy", endpoint: null }));
  const changes: [string, unknown][] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        tree(webhookNode({ requireTimestamp: true }), (path, value) =>
          changes.push([path, value]),
        ),
      );
    });
    await settle();

    const checkbox = renderer.root.findAll(
      (instance) =>
        instance.type === "input" && instance.props.type === "checkbox",
    );
    assert.equal(checkbox.length, 1);
    await act(async () => checkbox[0].props.onChange({ target: { checked: false } }));
    assert.deepEqual(changes.at(-1), ["params.requireTimestamp", undefined]);

    const tolerance = renderer.root.findAll(
      (instance) =>
        instance.type === "input" && instance.props.placeholder === "300",
    );
    assert.equal(tolerance.length, 1);
    await act(async () => tolerance[0].props.onChange({ target: { value: "600" } }));
    assert.deepEqual(changes.at(-1), ["params.timestampToleranceSeconds", 600]);
    await act(async () => tolerance[0].props.onChange({ target: { value: "abc" } }));
    assert.deepEqual(changes.at(-1), ["params.timestampToleranceSeconds", undefined]);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

// Reveal must survive a later reload failure and Copy must lift the cleartext,
// never the mask, so drive the real container through the confirm flow.
test("reveal shows the cleartext once; Copy lifts it and Hide drops it", async () => {
  const configCalls: string[] = [];
  const restore = installFetch(async (url: string, init?: RequestInit) => {
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
  });

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
    restore();
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    } else {
      delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    }
  }
});

// Importing a sender-dictated secret posts only the pasted value in the request
// body, reloads the masked config, and never renders the value back on screen.
test("Set secret posts the pasted value, reloads config, and never echoes it", async () => {
  const configCalls: string[] = [];
  const posted: string[] = [];
  const restore = installFetch(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/webhook/config")) {
      configCalls.push(path);
      return Response.json(activeConfig);
    }
    if (path.endsWith("/webhook/deliveries")) {
      return Response.json({ deliveries: [] });
    }
    if (path.endsWith("/webhook/set-secret") && init?.method === "POST") {
      posted.push(String(init.body));
      // The worker answers with the refreshed masked config, never the secret.
      return Response.json(activeConfig.endpoint);
    }
    throw new Error(`unexpected fetch ${path}`);
  });

  const IMPORTED = "sentry_client_secret_ab12cd34ef56";
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree(webhookNode(), () => undefined));
    });
    await settle();
    const root = () => renderer.root;

    assert.equal(configCalls.length, 1);

    // Open the import panel, paste a value, submit it.
    await act(async () => byAria(root(), "Set signing secret").props.onClick());
    await act(async () =>
      byAria(root(), "New signing secret value").props.onChange({
        target: { value: IMPORTED },
      }),
    );
    await act(async () => confirmButton(root(), "Set secret").props.onClick());
    await settle();

    // Exactly the pasted value went up, wrapped as { secret }.
    assert.equal(posted.length, 1);
    assert.deepEqual(JSON.parse(posted[0]), { secret: IMPORTED });
    // Config reloaded after the import (mount + reload).
    assert.equal(configCalls.length, 2);
    // The pasted value is nowhere in the rendered tree.
    assert.equal(
      root().findAll(
        (instance) =>
          typeof instance.type === "string" && instance.props.value === IMPORTED,
      ).length,
      0,
    );
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});
