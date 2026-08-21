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
    total: 3,
    live: 1,
    down: 1,
    notConfigured: 0,
    criticalDown: 1,
    checksTotal: 6,
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
    {
      id: "vercel",
      label: "Vercel deployment",
      group: "platform",
      envVars: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
      critical: false,
      mode: "live",
      ping: { ok: true, latencyMs: 80 },
      checks: [
        {
          id: "project",
          label: "Project access",
          description: "Verified independently.",
          critical: true,
          mode: "live",
          envVars: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
          evidenceSource: "live-probe",
        },
        {
          id: "production-deployment",
          label: "Production deployment",
          description: "Verified independently.",
          critical: false,
          mode: "live",
          envVars: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
          evidenceSource: "live-probe",
        },
      ],
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
  assert.match(text, /No scan has run in this session/);
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
  assert.match(text, /3 live · 1 down/);
  assert.match(text, /GitHub/);
  assert.doesNotMatch(text, /Action required|Needs attention|Unverified/);
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
    "aria-controls": "health-checks-vercel",
  });
  act(() => button.props.onClick());

  const text = textOf(renderer.toJSON());
  assert.match(text, /Production deployment/);
  assert.equal(count(text, "VERCEL_TOKEN"), 1);
  assert.equal(count(text, "VERCEL_PROJECT_ID"), 1);
  act(() => renderer.unmount());
});
