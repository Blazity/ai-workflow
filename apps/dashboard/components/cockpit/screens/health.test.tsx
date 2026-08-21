import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import type { SystemHealthResponse } from "@shared/contracts";
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
    checksTotal: 2,
    checksLive: 1,
    checksDown: 1,
    checksUnverified: 0,
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
      checks: [{
        id: "connectivity",
        label: "Connection and query",
        description: "Verified independently.",
        critical: true,
        mode: "live",
        envVars: ["DATABASE_URL"],
        evidenceSource: "live-probe",
      }],
    },
    {
      id: "jira",
      label: "Jira",
      group: "core",
      envVars: ["JIRA_API_TOKEN"],
      critical: true,
      mode: "down",
      ping: { ok: false, latencyMs: 40, error: "Jira authentication check failed." },
      checks: [{
        id: "api",
        label: "Account and project",
        description: "Verified independently.",
        critical: true,
        mode: "down",
        envVars: ["JIRA_API_TOKEN"],
        evidenceSource: "live-probe",
        message: "Jira authentication check failed.",
      }],
    },
  ],
  alerts: [
    {
      severity: "critical",
      integrationId: "jira",
      message: "Jira: Jira authentication check failed.",
      fixHint: "Check JIRA_API_TOKEN and the provider setup.",
    },
  ],
};

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object" && "children" in value) {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

test("health screen exposes the failed service, fix hint, and safe env names", () => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen data={data} />);
  });
  const text = textOf(renderer.toJSON());
  assert.match(text, /Action required/);
  assert.match(text, /Jira authentication check failed/);
  assert.match(text, /JIRA_API_TOKEN/);
  assert.match(text, /DATABASE_URL/);
  assert.doesNotMatch(text, /secret-value/);
  act(() => renderer.unmount());
});

test("critical unverified evidence is not presented as operational", () => {
  const unverified = structuredClone(data);
  unverified.alerts = [];
  unverified.summary.criticalDown = 0;
  unverified.integrations[1]!.mode = "unverified";
  unverified.integrations[1]!.ping = null;
  unverified.integrations[1]!.checks![0]!.mode = "unverified";

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen data={unverified} />);
  });
  const text = textOf(renderer.toJSON());
  assert.match(text, /Verification incomplete/);
  assert.doesNotMatch(text, /Operational/);
  act(() => renderer.unmount());
});

test("an optional unverified child does not block critical readiness", () => {
  const optionalWebhook = structuredClone(data);
  optionalWebhook.alerts = [];
  optionalWebhook.summary.criticalDown = 0;
  optionalWebhook.integrations[1]!.mode = "unverified";
  optionalWebhook.integrations[1]!.ping = null;
  optionalWebhook.integrations[1]!.checks![0]!.critical = false;
  optionalWebhook.integrations[1]!.checks![0]!.mode = "unverified";

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen data={optionalWebhook} />);
  });
  assert.match(textOf(renderer.toJSON()), /Operational/);
  act(() => renderer.unmount());
});

test("scan again runs one active scan and renders its fresh result", async (t) => {
  let resolveFetch!: (response: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const fetchMock = mock.method(globalThis, "fetch", () => pendingResponse);
  t.after(() => mock.restoreAll());

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen data={data} />);
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

test("scan again aborts and recovers when the worker times out", async (t) => {
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
    renderer = create(<HealthScreen data={data} />);
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

test("integration rows expand into independently reported checks", () => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<HealthScreen data={data} />);
  });
  const button = renderer.root.findByProps({
    "aria-controls": "health-checks-database",
  });
  assert.equal(button.props["aria-expanded"], false);

  act(() => button.props.onClick());

  assert.equal(button.props["aria-expanded"], true);
  assert.match(textOf(renderer.toJSON()), /Connection and query/);
  assert.match(textOf(renderer.toJSON()), /Live probe/);
  act(() => renderer.unmount());
});
