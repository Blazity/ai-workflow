import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import type { SystemHealthIntegration, SystemHealthResponse } from "@shared/contracts";
import { HealthScreen } from "./health";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data: SystemHealthResponse = {
  generatedAt: "2026-08-20T12:00:00.000Z",
  summary: {
    total: 2,
    live: 1,
    down: 1,
    notConfigured: 0,
    criticalDown: 1,
    checksTotal: 4,
    checksLive: 3,
    checksDown: 1,
    checksDegraded: 0,
  },
  integrations: [
    {
      id: "database",
      label: "Database",
      group: "core",
      envVars: ["DATABASE_URL"],
      critical: true,
      mode: "live",
      ping: { ok: true, latencyMs: 12 },
      checks: [
        {
          id: "connectivity",
          label: "Connection and query",
          description: "Verified independently.",
          critical: true,
          mode: "live",
          envVars: ["DATABASE_URL"],
          evidenceSource: "live-probe",
        },
        {
          id: "migrations",
          label: "Schema migrations",
          description: "Verified independently.",
          critical: true,
          mode: "live",
          envVars: ["DATABASE_URL"],
          evidenceSource: "live-probe",
        },
      ],
    },
    {
      id: "github",
      label: "GitHub",
      group: "core",
      envVars: ["GITHUB_APP_ID", "GITHUB_WEBHOOK_SECRET"],
      critical: true,
      mode: "down",
      ping: { ok: false, latencyMs: 40, error: "Latest GitHub delivery failed with HTTP 401." },
      checks: [
        {
          id: "app-installation",
          label: "App installation",
          description: "Verified independently.",
          critical: true,
          mode: "live",
          envVars: ["GITHUB_APP_ID"],
          evidenceSource: "live-probe",
        },
        {
          id: "webhook-delivery",
          label: "App webhook configuration and deliveries",
          description: "Verified independently.",
          critical: true,
          mode: "down",
          envVars: ["GITHUB_WEBHOOK_SECRET"],
          evidenceSource: "provider-delivery",
          message: "Latest GitHub delivery failed with HTTP 401.",
        },
      ],
    },
  ],
};

/** A section as an integration contributes it: its own name, its own
 *  description, the connection row core adds and the checks it declared. */
function integrationSection(
  overrides: Partial<SystemHealthIntegration> = {},
): SystemHealthIntegration {
  return {
    id: "demo",
    label: "Demo",
    description: "A self-contained provider used for demos.",
    group: "integrations",
    envVars: ["DEMO_BASE_URL"],
    critical: false,
    mode: "live",
    ping: { ok: true, latencyMs: 31 },
    checks: [
      {
        id: "connection",
        label: "Connection",
        description: "Where this integration's values come from.",
        critical: true,
        mode: "configured",
        envVars: ["DEMO_BASE_URL"],
        evidenceSource: "configuration",
        message: "Connected from this deployment's environment. No connection test has been run.",
      },
      {
        id: "auth",
        label: "Token accepted",
        description: "The demo provider accepts the API token.",
        critical: true,
        mode: "live",
        envVars: [],
        evidenceSource: "live-probe",
      },
    ],
    ...overrides,
  };
}

function withIntegrations(
  ...sections: SystemHealthIntegration[]
): SystemHealthResponse {
  return { ...data, integrations: [...data.integrations, ...sections] };
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object" && "children" in value) {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("mounting the screen issues no request; the first scan is the Scan button", async (t) => {
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json(data));
  t.after(() => mock.restoreAll());

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen />);
  });
  assert.equal(fetchMock.mock.callCount(), 0);
  let text = textOf(renderer.toJSON());
  assert.match(text, /No scan has been recorded yet/);
  assert.doesNotMatch(text, /Scanned/);

  const button = renderer.root.findByProps({ children: "Scan" });
  let scan!: Promise<void>;
  await act(async () => {
    scan = button.props.onClick();
    await scan;
  });
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(fetchMock.mock.calls[0]?.arguments[1]?.method, "POST");
  text = textOf(renderer.toJSON());
  assert.match(text, /Scanned/);
  assert.match(text, /3 live\s+·\s+1 down/);
  assert.match(text, /GitHub/);
  assert.doesNotMatch(text, /Action required|Needs attention|Unverified/);
  act(() => renderer.unmount());
});

test("a stored scan renders on load with its time and no request", (t) => {
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json(data));
  t.after(() => mock.restoreAll());

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={data} />);
  });
  assert.equal(fetchMock.mock.callCount(), 0);
  const text = textOf(renderer.toJSON());
  assert.match(text, /Scanned\s+Aug 20, 2026/);
  assert.match(text, /3 live\s+·\s+1 down/);
  assert.match(text, /This scan is older than 24 hours/);
  assert.doesNotMatch(text, /No scan has been recorded/);
  assert.doesNotMatch(text, /Values saved here/);
  renderer.root.findByProps({ children: "Scan again" });
  act(() => renderer.unmount());
});

test("scan again runs one active scan at a time and renders its fresh result", async (t) => {
  let resolveFetch!: (response: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const fetchMock = mock.method(globalThis, "fetch", () => pendingResponse);
  t.after(() => mock.restoreAll());

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={data} />);
  });
  const button = renderer.root.findByProps({ children: "Scan again" });
  let scan!: Promise<void>;
  act(() => {
    scan = button.props.onClick();
    button.props.onClick();
  });
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(
    renderer.root.findByProps({ children: "Scanning…" }).props.disabled,
    true,
  );

  await act(async () => {
    resolveFetch(
      Response.json({
        ...data,
        generatedAt: "2026-08-20T12:00:01.000Z",
      }),
    );
    await scan;
  });
  assert.equal(
    renderer.root.findByProps({ children: "Scan again" }).props.disabled,
    false,
  );
  act(() => renderer.unmount());
});

test("scan aborts and recovers when the worker times out", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  mock.method(globalThis, "fetch", (...args: Parameters<typeof fetch>) => {
    const init = args[1];
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  });
  t.after(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={data} />);
  });
  let scan!: Promise<void>;
  act(() => {
    scan = renderer.root.findByProps({ children: "Scan again" }).props.onClick();
  });
  assert.equal(
    renderer.root.findByProps({ children: "Scanning…" }).props.disabled,
    true,
  );

  await act(async () => {
    mock.timers.tick(15_000);
    await scan;
  });

  assert.equal(
    renderer.root.findByProps({ children: "Scan again" }).props.disabled,
    false,
  );
  assert.match(textOf(renderer.toJSON()), /System health scan timed out/);
  act(() => renderer.unmount());
});

test("expanding a provider moves variable names to the checks that differ", () => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={data} />);
  });
  const button = renderer.root.findByProps({
    "aria-controls": "health-checks-github",
  });
  assert.equal(button.props["aria-expanded"], false);
  let text = textOf(renderer.toJSON());
  assert.equal(count(text, "GITHUB_APP_ID"), 1);
  assert.equal(count(text, "GITHUB_WEBHOOK_SECRET"), 1);

  act(() => button.props.onClick());

  assert.equal(button.props["aria-expanded"], true);
  text = textOf(renderer.toJSON());
  assert.match(text, /App installation/);
  assert.match(text, /Latest GitHub delivery failed with HTTP 401/);
  assert.equal(count(text, "GITHUB_APP_ID"), 1);
  assert.equal(count(text, "GITHUB_WEBHOOK_SECRET"), 1);
  act(() => renderer.unmount());
});

test("checks that all need the same variables leave them on the provider row", () => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={data} />);
  });
  const button = renderer.root.findByProps({
    "aria-controls": "health-checks-database",
  });
  act(() => button.props.onClick());

  const text = textOf(renderer.toJSON());
  assert.match(text, /Schema migrations/);
  assert.equal(count(text, "DATABASE_URL"), 1);
  act(() => renderer.unmount());
});

test("an integration gets its own section, described by its own manifest", () => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={withIntegrations(integrationSection())} />);
  });

  const text = textOf(renderer.toJSON());
  assert.match(text, /Integrations/);
  assert.match(text, /Demo/);
  // Core knows nothing about this provider, so the line under its name can only
  // have come from the scan.
  assert.match(text, /A self-contained provider used for demos/);
  assert.doesNotMatch(text, /Deployment integration\./);

  act(() =>
    renderer.root.findByProps({ "aria-controls": "health-checks-demo" }).props.onClick(),
  );
  const expanded = textOf(renderer.toJSON());
  assert.match(expanded, /Token accepted/);
  assert.match(expanded, /No connection test has been run/);
  act(() => renderer.unmount());
});

test("a disabled integration reads as disabled, not as an outage", () => {
  const disabled = integrationSection({
    id: "demo",
    mode: "disabled",
    envVars: [],
    ping: null,
    checks: [
      {
        id: "connection",
        label: "Connection",
        description: "Where this integration's values come from.",
        critical: true,
        mode: "disabled",
        envVars: [],
        evidenceSource: "configuration",
        message: "Demo is turned off on the Integrations page.",
      },
    ],
  });
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={withIntegrations(disabled)} />);
  });

  const text = textOf(renderer.toJSON());
  assert.match(text, /Disabled/);
  assert.doesNotMatch(text, /Demo[\s\S]{0,400}?(Down|Needs configuration)/);
  act(() => renderer.unmount());
});

test("nothing connected leaves the integrations section off the page entirely", () => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={data} />);
  });
  // A deployment that ships no integration reads exactly as it did before.
  assert.doesNotMatch(textOf(renderer.toJSON()), /Integrations/);
  act(() => renderer.unmount());
});

test("a section in a group this build does not know still reaches the screen", () => {
  const future = integrationSection({
    id: "future",
    label: "Future",
    description: "Contributed by a build that knew a group this one does not.",
    group: "storage" as SystemHealthIntegration["group"],
  });
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={withIntegrations(future)} />);
  });
  const text = textOf(renderer.toJSON());
  assert.match(text, /Future/);
  assert.match(text, /Contributed by a build that knew a group this one does not/);
  act(() => renderer.unmount());
});

test("a row that needs something says what, without being expanded", () => {
  const partial = integrationSection({
    mode: "misconfigured",
    envVars: ["DEMO_API_TOKEN"],
    ping: null,
    checks: [
      {
        id: "connection",
        label: "Connection",
        description: "Where this integration's values come from.",
        critical: true,
        mode: "misconfigured",
        envVars: ["DEMO_API_TOKEN"],
        evidenceSource: "configuration",
        message: "Set DEMO_API_TOKEN on this deployment, or store the values from the dashboard",
      },
    ],
  });
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={withIntegrations(partial)} />);
  });

  const text = textOf(renderer.toJSON());
  // The whole point of the state: the variable to set is on the row, not two
  // clicks away, and the reason came with the scan rather than from core.
  assert.match(text, /Set DEMO_API_TOKEN on this deployment/);
  // A healthy row says nothing extra.
  assert.equal(count(text, "Verified independently."), 0);
  act(() => renderer.unmount());
});

test("a mode this build has no entry for renders instead of breaking the page", () => {
  const future = integrationSection({
    mode: "flapping" as SystemHealthIntegration["mode"],
    checks: [
      {
        id: "auth",
        label: "Token accepted",
        description: "The provider accepts the token.",
        critical: true,
        mode: "flapping" as SystemHealthIntegration["mode"],
        envVars: [],
        evidenceSource: "live-probe",
        message: "The provider answered twice with two different answers.",
      },
    ],
  });
  let renderer!: ReturnType<typeof create>;
  // An operator expanding a row mid-incident is the worst moment for a throw.
  act(() => {
    renderer = create(<HealthScreen initialData={withIntegrations(future)} />);
  });
  act(() =>
    renderer.root.findByProps({ "aria-controls": "health-checks-demo" }).props.onClick(),
  );

  const text = textOf(renderer.toJSON());
  assert.match(text, /Unknown/);
  assert.match(text, /The provider answered twice/);
  act(() => renderer.unmount());
});

test("a degraded row names the check that made it degraded", () => {
  const degraded = integrationSection({
    mode: "degraded",
    checks: [
      {
        id: "connection",
        label: "Connection",
        description: "Where this integration's values come from.",
        critical: true,
        mode: "configured",
        envVars: ["DEMO_BASE_URL"],
        evidenceSource: "configuration",
        message: "Connected from this deployment's environment.",
      },
      {
        id: "delivery",
        label: "Message delivered",
        description: "The last message was recorded.",
        critical: false,
        mode: "down",
        envVars: [],
        evidenceSource: "live-probe",
        message: "The provider rejected the last message.",
      },
    ],
  });
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen initialData={withIntegrations(degraded)} />);
  });

  const text = textOf(renderer.toJSON());
  // Degraded and nothing else leaves an operator with nothing to do; the check
  // that decided the row is the one with something to act on.
  assert.match(text, /The provider rejected the last message/);
  act(() => renderer.unmount());
});
