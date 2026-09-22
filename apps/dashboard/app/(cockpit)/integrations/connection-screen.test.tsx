// The screen where a credential is typed, walked the way an admin walks it.
//
// It sits beside the `[id]` directory rather than inside it because node's test
// runner reads an explicit path as a glob, where `[id]` is a character class
// matching "i" or "d". A test file under a Next dynamic-route directory is
// therefore discovered by `**/*.test.tsx` and silently skipped whenever it is
// named on its own, which is exactly what `pnpm run verify:changed` does with
// the files a branch changed.
// From docs/qa/integrations-scenarios.md J2, J4, J5 and J7: the wrong token,
// the URL corrected without retyping the token, the empty required field, the
// deployment with no secrets key, the second tab, the preview, the member.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type {
  IntegrationConnectionFieldDto,
  IntegrationDto,
  IntegrationState,
} from "@shared/contracts";

import { CockpitCtx } from "@/components/cockpit/context";

import { ConnectionScreen } from "./[id]/connection/connection-screen";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The shared Modal opens on an animation frame, which node has no browser to
// give it. Running the callback at once is what a test wants anyway.
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) => {
  callback(0);
  return 0;
}) as typeof globalThis.requestAnimationFrame;
globalThis.cancelAnimationFrame ??= (() => {}) as typeof globalThis.cancelAnimationFrame;

const ROUTER = {
  refresh: () => {},
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

const URL_FIELD: IntegrationConnectionFieldDto = {
  key: "baseUrl",
  label: "Site URL",
  env: "DEMO_BASE_URL",
  secret: false,
  optional: false,
  format: "url",
  envSet: false,
  storedValue: "https://old.example",
  storedSecretSet: false,
};

const TOKEN_FIELD: IntegrationConnectionFieldDto = {
  key: "apiToken",
  label: "API token",
  env: "DEMO_API_TOKEN",
  secret: true,
  optional: false,
  format: "text",
  envSet: false,
  storedSecretSet: true,
};

function state(overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: "demo",
    enabled: true,
    source: "stored",
    status: "connected",
    connection: "connected",
    verification: { state: "passed", at: "2026-09-18T10:00:00.000Z" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: ["DEMO_BASE_URL"], complete: false },
    stored: {
      latestVersion: 3,
      activeVersion: 3,
      missingFields: [],
      complete: true,
      prepared: null,
    },
    pin: { integrationId: "demo", configFingerprint: "abc123abc123" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

function integration(overrides: Partial<IntegrationDto> = {}): IntegrationDto {
  return {
    id: "demo",
    name: "Demo",
    description: "A deterministic provider used for demos.",
    capabilities: ["messaging"],
    blocks: [{ type: "demo_echo", label: "Demo echo" }],
    pages: [],
    fields: [URL_FIELD, TOKEN_FIELD],
    state: state(),
    ...overrides,
  };
}

interface Sent {
  url: string;
  method: string | undefined;
  body: unknown;
}

/** The impact read every change makes first, answered as "nothing stops"
 *  unless a test says otherwise. A disconnect moves the pin; a save and a
 *  switch of source, whose sources hold the same values, do not. */
function previewReply(call: Sent): unknown | null {
  const body = call.body as { preview?: string } | null;
  const kinds = ["save", "disconnect", "source", "disable"];
  if (body?.preview === undefined || !kinds.includes(body.preview)) return null;
  return {
    changesFingerprint: body.preview === "disconnect",
    enabledDefinitions: [],
    inFlightRuns: 0,
    repositories: [],
  };
}

function stubFetch(
  t: TestContext,
  reply: (sent: Sent) => unknown,
  status = 200,
  autoPreview = true,
) {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const call = {
      url: String(url),
      method: init?.method,
      body: init?.body === undefined ? null : JSON.parse(String(init.body) || "null"),
    };
    const automatic = autoPreview ? previewReply(call) : null;
    if (automatic === null) sent.push(call);
    return Promise.resolve(
      new Response(JSON.stringify(automatic ?? reply(call)), {
        status: automatic === null ? status : 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

/** The same stub for a walk that meets more than one status, such as a save
 *  refused with a 409 and the read-back that follows it. */
function stubReplies(
  t: TestContext,
  reply: (sent: Sent) => { status: number; body: unknown },
  autoPreview = true,
) {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const call = {
      url: String(url),
      method: init?.method,
      body: init?.body === undefined ? null : JSON.parse(String(init.body) || "null"),
    };
    const automatic = autoPreview ? previewReply(call) : null;
    if (automatic === null) sent.push(call);
    const answer = automatic === null
      ? reply(call)
      : { status: 200, body: automatic };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

function render(
  t: TestContext,
  props: Partial<React.ComponentProps<typeof ConnectionScreen>> = {},
  router: typeof ROUTER = ROUTER,
): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={router as never}>
        <ConnectionScreen
          integration={integration()}
          writes={{ allowed: true }}
          canManage
          {...props}
        />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

function text(root: ReactTestInstance): string {
  return root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");
}

function inputs(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === "input" || node.type === "textarea");
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll(
    (node) => node.type === "button" && text(node).includes(label),
  );
  assert.ok(found.length > 0, `no button labelled ${label}`);
  return found[0]!;
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });
}

function type(node: ReactTestInstance, value: string): void {
  act(() => {
    node.props.onChange?.({ target: { value } });
  });
}

test("a secret field never shows a value, and says blank keeps the stored one", (t) => {
  const root = render(t);
  const secret = inputs(root).find((node) => node.props.type === "password");
  assert.ok(secret, "the token field is a password input");
  assert.equal(secret.props.value, "", "a stored secret is never sent back, so it is never shown");
  assert.match(text(root), /Leave this blank to keep it/);
});

test("correcting the URL and leaving the token alone sends the URL and no token", async (t) => {
  // INT-052, the case that catches a form that re-sends a placeholder.
  const sent = stubFetch(t, () => ({ integration: integration(), test: { ok: true } }));
  const root = render(t);
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "https://new.example");
  await press(button(root, "Save and test"));

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "PUT");
  assert.deepEqual(sent[0]!.body, {
    // The command is named rather than inferred, so a request that lost it is
    // refused instead of being carried out as a write.
    preview: "write",
    expectedVersion: 3,
    values: { baseUrl: "https://new.example" },
    clearSecrets: [],
  });
});

test("an empty required field is named before anything leaves the browser", async (t) => {
  const sent = stubFetch(t, () => ({}));
  const root = render(t);
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "  ");
  await press(button(root, "Save and test"));

  assert.equal(sent.length, 0, "nothing is sent while a required field is empty");
  assert.match(text(root), /Fill Site URL in before saving/);
});

test("a wrong token is reported in the provider's own words with the values still on screen", async (t) => {
  const sent = stubFetch(t, () => ({
    integration: integration(),
    test: {
      ok: false,
      failure: { reason: "credential_rejected", message: "401 unauthorised" },
    },
  }));
  const root = render(t);
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "https://new.example");
  const secret = inputs(root).find((node) => node.props.type === "password");
  assert.ok(secret);
  type(secret, "wrong-token");
  await press(button(root, "Save and test"));

  assert.equal(sent.length, 1);
  assert.match(text(root), /401 unauthorised/);
  const urlAfter = inputs(root).find((node) => node.props.type === "url");
  assert.equal(
    urlAfter?.props.value,
    "https://new.example",
    "the non-secret field stays filled so one field can be corrected",
  );
  const secretAfter = inputs(root).find((node) => node.props.type === "password");
  assert.equal(
    secretAfter?.props.value,
    "",
    "the secret input is emptied: keeping the characters would suggest the field holds the stored value",
  );
});

const PROJECT_FIELD: IntegrationConnectionFieldDto = {
  key: "projectKey",
  label: "Project key",
  env: "DEMO_PROJECT_KEY",
  secret: false,
  optional: false,
  format: "text",
  envSet: false,
  storedValue: "OLD-1",
  storedSecretSet: false,
};

test("a second tab is told somebody else saved, and keeps what was typed", async (t) => {
  // The lost update, from docs/qa J7. Saving again used to send every field as
  // this page last knew it, which quietly wrote the colleague's Project key
  // back to the value it had before they changed it.
  const mine = integration({ fields: [URL_FIELD, PROJECT_FIELD, TOKEN_FIELD] });
  const theirs = integration({
    fields: [
      { ...URL_FIELD, storedValue: "https://colleague.example" },
      { ...PROJECT_FIELD, storedValue: "NEW-9" },
      TOKEN_FIELD,
    ],
    state: state({
      stored: {
        latestVersion: 7,
        activeVersion: 7,
        missingFields: [],
        complete: true,
        prepared: null,
      },
    }),
  });
  let saves = 0;
  const sent = stubReplies(t, (call) => {
    if (call.method !== "PUT") {
      return { status: 200, body: { integrations: [theirs], writes: { allowed: true } } };
    }
    saves += 1;
    // Only the first save loses the race; the second one is the point.
    return saves === 1
      ? { status: 409, body: { error: "integration_version_conflict", currentVersion: 7 } }
      : { status: 200, body: { integration: theirs, test: { ok: true } } };
  });
  const root = render(t, { integration: mine });
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "https://new.example");
  await press(button(root, "Save and test"));

  assert.equal(sent.length, 2, "the refusal is followed by a read of what is now stored");
  const rendered = text(root);
  assert.match(rendered, /Somebody else changed Demo while this page was open/);
  assert.doesNotMatch(rendered, /409/, "a status code is not a sentence an admin can act on");
  assert.match(
    rendered,
    /Site URL is now "https:\/\/colleague\.example" here, and you typed "https:\/\/new\.example"\./,
    "the field this admin typed in is named with both values",
  );
  assert.doesNotMatch(
    rendered,
    /Project key is now/,
    "a field nobody here touched is not a disagreement",
  );
  assert.equal(
    inputs(root).find((node) => node.props.type === "url")?.props.value,
    "https://new.example",
    "what was typed is still the admin's",
  );
  assert.equal(
    inputs(root).find((node) => node.props.value === "NEW-9")?.props.value,
    "NEW-9",
    "the untouched field now holds the value that won",
  );

  await press(button(root, "Save and test"));
  assert.equal(sent.length, 3);
  assert.deepEqual(
    sent[2]!.body,
    {
      preview: "write",
      expectedVersion: 7,
      values: { baseUrl: "https://new.example", projectKey: "NEW-9" },
      clearSecrets: [],
    },
    "saving again carries the version that won and keeps the colleague's value",
  );
});

test("a conflict that cannot be read back says so instead of offering a blind save", async (t) => {
  const sent = stubReplies(t, (call) =>
    call.method === "PUT"
      ? { status: 409, body: { error: "integration_version_conflict", currentVersion: 7 } }
      : { status: 503, body: { error: "the worker did not answer" } },
  );
  const root = render(t);
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "https://new.example");
  await press(button(root, "Save and test"));

  assert.equal(sent.length, 2);
  assert.match(text(root), /could not be read back/);
  assert.match(text(root), /Reload the page before saving again/);
});

test("a deployment with no secrets key disables the secret field and names the variable", (t) => {
  const root = render(t, {
    integration: integration({ state: state({ secretsKeyAvailable: false }) }),
  });
  const secret = inputs(root).find((node) => node.props.type === "password");
  assert.equal(secret?.props.disabled, true);
  assert.match(text(root), /Set INTEGRATION_SECRETS_KEY on this deployment/);
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.equal(url?.props.disabled, false, "the non-secret fields are unaffected");
});

test("a deployment that does not own its database offers no write control at all", (t) => {
  const root = render(t, {
    writes: {
      allowed: false,
      reason:
        "This deployment runs as preview and the database belongs to production, so integration changes here would change production's.",
    },
  });
  const rendered = text(root);
  assert.match(rendered, /the database belongs to production/);
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).includes("Save and test")).length,
    0,
  );
  assert.ok(
    inputs(root).every((node) => node.props.disabled === true),
    "every field is read-only where a write can never succeed",
  );
});

test("a member sees the state and not one control", (t) => {
  const root = render(t, { canManage: false });
  const rendered = text(root);
  assert.match(rendered, /needs the owner or admin role/);
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).includes("Save and test")).length,
    0,
  );
  assert.equal(
    root.findAll((node) => node.props?.role === "switch").length,
    0,
    "the kill switch is not offered to a role that cannot throw it",
  );
  assert.ok(
    inputs(root).every((node) => node.props.disabled === true),
    "and the fields are read-only, so nothing invites a member to type a credential",
  );
});

test("testing what is in use is refused while nothing is configured", async (t) => {
  // The worker built a request out of empty values, and the `new URL("")` that
  // threw came back as "the provider is not answering, try again in a moment",
  // then stayed on the record as a failed verification.
  const sent = stubFetch(t, () => ({}));
  const root = render(t, {
    integration: integration({
      state: state({
        source: "environment",
        status: "not_connected",
        connection: "not_connected",
        usable: false,
        verification: { state: "never_tested" },
        stored: {
          latestVersion: 0,
          activeVersion: null,
          missingFields: [],
          complete: false,
          prepared: null,
        },
      }),
    }),
  });
  await press(button(root, "Test what is in use"));

  assert.equal(sent.length, 0, "nothing was asked, so nothing can be recorded as an answer");
  const rendered = text(root);
  assert.match(rendered, /there is nothing to test/);
  assert.match(rendered, /DEMO_BASE_URL is not set on this deployment/);
  assert.doesNotMatch(
    rendered,
    /try again in a moment/,
    "a retry can never work while nothing is configured",
  );
});

test("a refused switch says why instead of hiding behind the confirmation", async (t) => {
  const sent = stubReplies(t, () => ({
    status: 403,
    body: { error: "Integrations are managed by owners and admins." },
  }));
  const root = render(t);
  const toggle = root.find((node) => node.props?.role === "switch");
  await act(async () => {
    toggle.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });
  await press(button(root, "Turn it off"));

  assert.equal(sent.length, 1);
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).includes("Turn it off")).length,
    0,
    "the dialog is closed once the request settles, refused as well as done",
  );
  assert.match(text(root), /managed by owners and admins/);
});

test("a forwarded worker error reaches the admin as one sentence", async (t) => {
  const sent = stubReplies(t, () => ({
    status: 500,
    body: {
      error:
        "TypeError: fetch failed at proxyWorker (http://localhost:3110/api/v1/integrations/demo/test)\n    at async POST (/app/.next/server/app/api/route.js:1:1)",
    },
  }));
  const root = render(t);
  await press(button(root, "Test what is in use"));

  assert.equal(sent.length, 1);
  const rendered = text(root);
  assert.doesNotMatch(rendered, /localhost:3110/, "an internal hostname is not an admin's problem");
  assert.doesNotMatch(rendered, /at async POST/, "a stack frame is not a sentence");
  assert.match(rendered, /TypeError: fetch failed/);
});

test("the wait says how long the provider has, out loud", async (t) => {
  let resolve!: () => void;
  const blocked = new Promise<void>((done) => {
    resolve = done;
  });
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = init?.body === undefined ? null : JSON.parse(String(init.body) || "null");
    if ((body as { preview?: string } | null)?.preview === "save") {
      return Promise.resolve(
        new Response(JSON.stringify({
          changesFingerprint: false,
          enabledDefinitions: [],
          inFlightRuns: 0,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return blocked.then(
      () =>
        new Response(JSON.stringify({ integration: integration(), test: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const root = render(t);
  const save = button(root, "Save and test");
  await act(async () => {
    save.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });

  const live = root.findAll((node) => node.props?.["aria-live"] === "polite");
  assert.equal(live.length, 1, "a spinner on a button tells a screen reader nothing");
  assert.match(text(live[0]!), /20 seconds/);

  await act(async () => {
    resolve();
    await blocked;
  });
  assert.equal(
    root.findAll((node) => node.props?.["aria-live"] === "polite").length,
    0,
    "and it goes away when the answer arrives",
  );
});

test("turning the integration off asks first, and says what it costs", async (t) => {
  const sent = stubFetch(t, () => ({
    integration: integration({ state: state({ enabled: false, status: "disabled" }) }),
  }));
  const root = render(t);
  const toggle = root.find((node) => node.props?.role === "switch");
  await act(async () => {
    toggle.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });

  assert.equal(sent.length, 0, "nothing is switched off before the consequence is read");
  const rendered = text(root);
  assert.match(rendered, /fails naming Demo/);
  assert.match(rendered, /enabling it again finds exactly these values/);

  await press(button(root, "Turn it off"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "PATCH");
  assert.deepEqual(sent[0]!.body, { enabled: false });
});

test("turning it off names the workflows that use it and the runs that stop, though nothing is reconfigured", async (t) => {
  // Decision 9: impact before Disable. The dialog used to carry three fixed
  // sentences and no number, so an admin reaching for the kill switch
  // mid-afternoon could not see that it would stop eleven runs.
  const sent = stubReplies(t, (call) => {
    const body = call.body as { preview?: string } | null;
    if (body?.preview === "disable") {
      return {
        status: 200,
        body: {
          changesFingerprint: false,
          enabledDefinitions: [{ id: 7, name: "Deploy announcements" }],
          inFlightRuns: 11,
          repositories: [],
        },
      };
    }
    return {
      status: 200,
      body: { integration: integration({ state: state({ enabled: false, status: "disabled" }) }) },
    };
  }, false);
  const root = render(t);
  const toggle = root.find((node) => node.props?.role === "switch");
  await act(async () => {
    toggle.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });

  assert.equal(sent.length, 1, "only the impact is read before the switch is thrown");
  assert.deepEqual(sent[0]!.body, { preview: "disable" });
  const rendered = text(root);
  assert.match(rendered, /Enabled workflows using Demo: Deploy announcements/);
  assert.match(rendered, /11 runs in flight will stop/);
  assert.match(rendered, /fails naming Demo/);

  await press(button(root, "Turn it off and stop 11 runs"));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.body, { enabled: false });
});

test("a kill switch whose impact could not be read says so on the button", async (t) => {
  stubReplies(t, () => ({ status: 503, body: { error: "database unavailable" } }), false);
  const root = render(t);
  const toggle = root.find((node) => node.props?.role === "switch");
  await act(async () => {
    toggle.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });

  assert.match(text(root), /Runs in flight that would stop: unknown/);
  assert.ok(button(root, "Turn it off with unknown impact"));
});

test("switching to stored values that differ asks first and names the runs that stop", async (t) => {
  // The switch moves the pin whenever the two sources hold different values,
  // and it used to fire on one click.
  const sent = stubReplies(t, (call) => {
    const body = call.body as { preview?: string } | null;
    if (body?.preview === "source") {
      return {
        status: 200,
        body: {
          changesFingerprint: true,
          enabledDefinitions: [{ id: 4, name: "Nightly triage" }],
          inFlightRuns: 2,
          repositories: [],
        },
      };
    }
    return { status: 200, body: { integration: integration() } };
  }, false);
  const root = render(t, {
    integration: integration({
      state: state({
        source: "environment",
        environment: {
          setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
          missingVariables: [],
          complete: true,
        },
      }),
    }),
  });
  await press(button(root, "Use the stored values"));

  assert.equal(sent.length, 1, "nothing is switched before the impact is read and confirmed");
  assert.deepEqual(sent[0]!.body, { preview: "source", source: "stored" });
  const rendered = text(root);
  assert.match(rendered, /The two sources hold different values for Demo/);
  assert.match(rendered, /Nightly triage/);
  assert.match(rendered, /2 runs in flight will stop/);

  await press(button(root, "Switch and stop 2 runs"));
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.method, "PATCH");
  assert.deepEqual(sent[1]!.body, { source: "stored" });
});

test("disconnecting names affected repositories and what is erased", async (t) => {
  const sent = stubReplies(t, (call) => {
    const body = call.body as { preview?: string } | null;
    if (body?.preview === "disconnect") {
      return {
        status: 200,
        body: {
          changesFingerprint: true,
          enabledDefinitions: [],
          inFlightRuns: 0,
          repositories: [{ provider: "gitlab", path: "acme/api" }],
        },
      };
    }
    return { status: 200, body: { integration: integration() } };
  }, false);
  const root = render(t);
  await press(button(root, "Disconnect"));

  assert.equal(sent.length, 1, "only the impact preview runs before confirmation");
  const rendered = text(root);
  assert.match(rendered, /every stored secret in every past version, is erased/);
  assert.match(rendered, /becomes Not connected/);
  assert.match(rendered, /Repositories using Demo: acme\/api/);

  await press(button(root, "Erase the stored values"));
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.method, "DELETE");
});

test("saving a fingerprint change names the enabled definition and the runs that would stop", async (t) => {
  const sent = stubReplies(t, (call) => {
    const body = call.body as { preview?: string } | null;
    if (body?.preview === "save") {
      return {
        status: 200,
        body: {
          changesFingerprint: true,
          enabledDefinitions: [{ id: 7, name: "Deploy announcements" }],
          inFlightRuns: 11,
        },
      };
    }
    return { status: 200, body: { integration: integration(), test: { ok: true } } };
  }, false);
  const root = render(t);
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "https://new.example");
  await press(button(root, "Save and test"));

  assert.equal(sent.length, 1, "the impact is read before the configuration is saved");
  assert.match(text(root), /Deploy announcements/);
  assert.match(text(root), /11 runs in flight will stop/);
  assert.ok(button(root, "Save and stop 11 runs"));
});

test("a failed impact read says unknown and the destructive save button says so", async (t) => {
  const sent = stubReplies(t, () => ({
    status: 503,
    body: { error: "database unavailable" },
  }), false);
  const root = render(t);
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "https://new.example");
  await press(button(root, "Save and test"));

  assert.equal(sent.length, 1, "a failed read never falls through to the save");
  assert.match(text(root), /Enabled workflows: unknown/);
  assert.match(text(root), /Runs in flight that would stop: unknown/);
  assert.ok(button(root, "Save with unknown impact"));
  assert.doesNotMatch(text(root), /0 runs in flight/);
});

test("an integration whose values live in the environment is not offered Disconnect", (t) => {
  const root = render(t, {
    integration: integration({
      // Nothing was ever saved here, so no field carries a stored value.
      fields: [
        { ...URL_FIELD, storedValue: undefined },
        { ...TOKEN_FIELD, storedSecretSet: false },
      ],
      state: state({
        source: "environment",
        environment: {
          setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
          missingVariables: [],
          complete: true,
        },
        stored: {
          latestVersion: 0,
          activeVersion: null,
          missingFields: [],
          complete: false,
          prepared: null,
        },
      }),
    }),
  });
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).trim() === "Disconnect").length,
    0,
  );
  assert.match(text(root), /lives in the deployment's environment variables/);
});

test("after a disconnect the screen says nothing is stored, and offers nothing that needs values", (t) => {
  // The version counter survives a disconnect, because it is the token the
  // next save carries; the values do not. Read as "values are stored", it kept
  // a live Disconnect for erased values and told the admin that what was
  // stored "has not passed a test".
  const root = render(t, {
    integration: integration({
      fields: [
        { ...URL_FIELD, storedValue: undefined },
        { ...TOKEN_FIELD, storedSecretSet: false },
      ],
      state: state({
        source: "environment",
        status: "not_connected",
        connection: "not_connected",
        usable: false,
        verification: { state: "never_tested" },
        stored: {
          latestVersion: 5,
          activeVersion: null,
          missingFields: [],
          complete: false,
          prepared: null,
        },
      }),
    }),
  });
  const rendered = text(root);
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).trim() === "Disconnect").length,
    0,
    "there is nothing left to disconnect",
  );
  assert.doesNotMatch(rendered, /Saved 5 times/);
  assert.doesNotMatch(rendered, /has not passed a test/);
  assert.match(rendered, /Nothing is stored here/);
});

test("stored values can be prepared while the environment is still the source", async (t) => {
  const sent = stubFetch(t, () => ({ integration: integration(), test: { ok: true } }));
  const root = render(t, {
    integration: integration({
      state: state({
        source: "environment",
        environment: {
          setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
          missingVariables: [],
          complete: true,
        },
        stored: {
          latestVersion: 1,
          activeVersion: 1,
          missingFields: [],
          complete: true,
          prepared: null,
        },
      }),
    }),
  });
  assert.match(text(root), /Environment variables\s+· in use/);
  await press(button(root, "Use the stored values"));
  // The impact read found the same connection behind both sources, so the
  // switch goes ahead without a question nobody needs to answer.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body, { source: "stored" });
});

test("a double press sends one save", async (t) => {
  let resolve!: () => void;
  const blocked = new Promise<void>((done) => {
    resolve = done;
  });
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method, body: null });
    return blocked.then(
      () =>
        new Response(JSON.stringify({ integration: integration(), test: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const root = render(t);
  const save = button(root, "Save and test");
  await act(async () => {
    save.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
    save.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });
  assert.equal(sent.length, 1);
  await act(async () => {
    resolve();
    await blocked;
  });
});

test("another tab changing an integration makes this screen read the server again", async (t) => {
  // The gate found this screen still reading Connected, and still offering a
  // live Disconnect, 25 seconds after another tab had erased everything.
  let refreshes = 0;
  render(t, {}, { ...ROUTER, refresh: () => { refreshes += 1; } });

  const otherTab = new BroadcastChannel("ai-workflow:integrations");
  t.after(() => otherTab.close());
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- A BroadcastChannel message has no target origin; the rule is about window.postMessage.
  otherTab.postMessage("changed");
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 20));
  });

  assert.ok(refreshes > 0, "the screen asks the server what is true now");
});

test("a reload or a closed tab asks before it takes a half-typed value", (t) => {
  // The shell's own guard covers a move inside the cockpit; leaving the
  // document is the browser's, and only a beforeunload listener makes it ask.
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: new EventTarget(),
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const leave = () => {
    const event = new Event("beforeunload", { cancelable: true });
    (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  const root = render(t);
  assert.equal(leave(), false, "nothing typed, nothing to lose, no prompt");

  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "https://half.example");
  assert.equal(leave(), true, "the browser asks before the typed value is lost");
});

test("the way back to the list goes through the cockpit's guard, not around it", async (t) => {
  // A plain link is a full document navigation, which the shell never sees.
  const moves: string[] = [];
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={ROUTER as never}>
        <CockpitCtx.Provider
          value={{ navigate: (href: string) => (moves.push(href), false) } as never}
        >
          <ConnectionScreen integration={integration()} writes={{ allowed: true }} canManage />
        </CockpitCtx.Provider>
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  const back = renderer.root.find(
    (node) => node.type === "a" && text(node).includes("Integrations"),
  );
  let prevented = false;
  await act(async () => {
    back.props.onClick?.({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });
  });

  assert.deepEqual(moves, ["/integrations"]);
  assert.ok(prevented, "the browser's own navigation was handed to the guard");
  assert.equal(back.props.href, "/integrations", "still a real link for cmd-click and a new tab");
});

test("a change in another tab while the admin is typing keeps what was typed", async (t) => {
  // The refresh empties this form: the data is read in an async server
  // component under a Suspense boundary, and the boundary suspending again
  // takes the client tree with it. Walked on the running screen: a save from
  // the other tab wiped the field and the next save silently wrote the stale
  // value back with a version that no longer collided.
  let refreshes = 0;
  const root = render(t, {}, { ...ROUTER, refresh: () => { refreshes += 1; } });
  const url = inputs(root).find((node) => node.props.type === "url");
  assert.ok(url);
  type(url, "https://mine.example");

  const otherTab = new BroadcastChannel("ai-workflow:integrations");
  t.after(() => otherTab.close());
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- A BroadcastChannel message has no target origin; the rule is about window.postMessage.
  otherTab.postMessage("changed");
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 20));
  });

  assert.equal(refreshes, 0, "a refresh here would empty the form");
  assert.equal(
    inputs(root).find((node) => node.props.type === "url")?.props.value,
    "https://mine.example",
  );
  assert.match(text(root), /Somebody else changed this integration while you were typing/);
});
