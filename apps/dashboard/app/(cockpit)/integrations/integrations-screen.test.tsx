// The states of the Integrations list an operator can land on: a build that
// ships nothing, a fresh deployment, a production deployment configured through
// its environment, an integration whose last test failed, one somebody switched
// off, a role that may only read, and a deployment that does not own its
// database. From docs/qa/integrations-scenarios.md J1 and J2.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { IntegrationDto, IntegrationState } from "@shared/contracts";

import { IntegrationsScreen } from "./integrations-screen";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The list refreshes itself when another tab changes an integration, so it
// holds a router the way the real cockpit does.
const ROUTER = {
  refresh: () => {},
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

function state(overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: "demo",
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
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
    fields: [
      {
        key: "baseUrl",
        label: "Site URL",
        env: "DEMO_BASE_URL",
        secret: false,
        optional: false,
        format: "url",
        envSet: true,
        storedSecretSet: false,
      },
    ],
    state: state(),
    ...overrides,
  };
}

function render(
  t: TestContext,
  props: Partial<React.ComponentProps<typeof IntegrationsScreen>> = {},
): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={ROUTER as never}>
        <IntegrationsScreen
          integrations={[integration()]}
          writes={{ allowed: true }}
          canManage
          available
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

function links(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => node.type === "a")
    .map((node) => String(node.props.href ?? ""));
}

test("a build that ships no integrations explains itself instead of showing an empty list", () => {
  // Every deployment alive today is in this state: the providers are still
  // configured through environment variables and none of them is an
  // integration yet, so "nothing here" has to be an explanation.
  let root!: ReactTestInstance;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={ROUTER as never}>
        <IntegrationsScreen integrations={[]} writes={{ allowed: true }} canManage available />
      </AppRouterContext.Provider>,
    );
  });
  root = renderer.root;
  assert.match(text(root), /This build ships no integrations yet/);
  act(() => renderer.unmount());
});

test("an environment-configured deployment is told so and asked to do nothing", (t) => {
  const root = render(t);
  const rendered = text(root);
  assert.match(rendered, /Connected/);
  assert.match(rendered, /Values come from this deployment's environment variables/);
  assert.match(rendered, /Nothing has ever tested these values/);
  assert.doesNotMatch(
    rendered,
    /\bNot connected\b/,
    "a complete environment is connected, whether or not anybody ever tested it",
  );
});

test("a fresh deployment is told what each integration needs and offered Connect", (t) => {
  const root = render(t, {
    integrations: [
      integration({
        state: state({
          status: "not_connected",
          connection: "not_connected",
          usable: false,
          environment: { setVariables: [], missingVariables: ["DEMO_BASE_URL"], complete: false },
        }),
      }),
    ],
  });
  const rendered = text(root);
  assert.match(rendered, /Not connected/);
  assert.match(rendered, /Nothing configures it on this deployment yet/);
  assert.match(rendered, /It needs Site URL/);
  assert.ok(rendered.includes("Connect"), "the card offers the action that fixes it");
});

test("a failing integration shows the provider's own reason and when it was checked", (t) => {
  const root = render(t, {
    integrations: [
      integration({
        state: state({
          status: "failing",
          connection: "failing",
          usable: false,
          failure: { reason: "credential_rejected", message: "401 unauthorised" },
          verification: {
            state: "failed",
            at: "2026-09-18T10:00:00.000Z",
            failure: { reason: "credential_rejected", message: "401 unauthorised" },
          },
        }),
      }),
    ],
  });
  const rendered = text(root);
  assert.match(rendered, /Failing/);
  assert.match(rendered, /401 unauthorised/);
  assert.match(rendered, /The last test failed on/);
});

test("an integration somebody switched off reads as switched off, not as broken", (t) => {
  const root = render(t, {
    integrations: [
      integration({ state: state({ enabled: false, status: "disabled", usable: false }) }),
    ],
  });
  const rendered = text(root);
  assert.match(rendered, /Disabled/);
  assert.match(rendered, /Turned off here on purpose/);
  assert.doesNotMatch(rendered, /Failing/);
});

test("a member reads every status and is offered no control that would fail", (t) => {
  // The fresh-deployment card is the one that carries an action, so a member
  // meets it here rather than on the connected card, which has only a link
  // whatever the role.
  const root = render(t, {
    canManage: false,
    integrations: [
      integration(),
      integration({
        id: "other",
        name: "Other",
        state: state({
          status: "not_connected",
          connection: "not_connected",
          usable: false,
          environment: { setVariables: [], missingVariables: ["OTHER_URL"], complete: false },
        }),
      }),
    ],
  });
  const rendered = text(root);
  assert.match(rendered, /Connected/);
  assert.match(rendered, /needs the owner or admin role/);
  assert.equal(
    root.findAll((node) => node.type === "button").length,
    0,
    "a member must not be offered a button at all, including on a card nobody has connected",
  );
  assert.ok(rendered.includes("View connection"));
  assert.ok(!rendered.includes("Manage connection"));
  // The Connect action is an anchor styled as a button, so counting <button>
  // nodes would never have seen it. What matters is that a member is never
  // offered the primary action for a card nobody has connected.
  assert.deepEqual(
    root
      .findAll((node) => node.type === "a")
      .map((node) => text(node).trim())
      .filter((label) => label === "Connect"),
    [],
    "a member must not be offered Connect on a card nobody has connected",
  );
});

test("a deployment that does not own its database says so before anything is clicked", (t) => {
  const root = render(t, {
    writes: {
      allowed: false,
      reason:
        "This deployment runs as preview and the database belongs to production, so integration changes here would change production's.",
    },
  });
  assert.match(text(root), /the database belongs to production/);
});

test("a worker that did not answer says so instead of showing an empty list", (t) => {
  const root = render(t, { available: false, integrations: [] });
  const rendered = text(root);
  assert.match(rendered, /The worker did not answer/);
  assert.doesNotMatch(rendered, /This build ships no integrations yet/);
});

test("every card links to the one screen where its connection is changed", (t) => {
  const root = render(t);
  assert.ok(links(root).includes("/integrations/demo/connection"));
});

test("the card promises the blocks this build can run, and says why about the rest", (t) => {
  // Seen at the gate: "Adds the Demo echo and Demo lookup blocks" on a card
  // whose second block the palette refuses, because core still owns the
  // capability it needs.
  const demo = integration({
    blocks: [
      { type: "demo_echo", label: "Demo echo" },
      { type: "demo_lookup", label: "Demo lookup" },
    ],
  });
  const root = render(t, {
    integrations: [demo],
    availability: new Map([
      ["demo_echo", { available: true, unavailableReason: null }],
      [
        "demo_lookup",
        {
          available: false,
          unavailableReason:
            "This build cannot yet run a block on the messaging capability served by an integration; core still owns it.",
        },
      ],
    ]),
  });
  const rendered = text(root);
  assert.match(rendered, /Adds the Demo echo block to the workflow editor\./);
  assert.doesNotMatch(rendered, /Adds the Demo echo and Demo lookup/);
  assert.match(rendered, /Demo lookup stays unavailable in the editor: This build cannot yet run/);
});
