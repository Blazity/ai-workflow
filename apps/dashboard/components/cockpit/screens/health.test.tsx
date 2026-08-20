import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { SystemHealthResponse } from "@shared/contracts";
import { HealthScreen } from "./health";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data: SystemHealthResponse = {
  generatedAt: "2026-08-20T12:00:00.000Z",
  summary: { total: 2, live: 1, down: 1, notConfigured: 0, criticalDown: 1 },
  integrations: [
    {
      id: "database",
      label: "Database",
      group: "core",
      envVars: ["DATABASE_URL"],
      critical: true,
      mode: "live",
      ping: { ok: true, latencyMs: 12 },
    },
    {
      id: "jira",
      label: "Jira",
      group: "core",
      envVars: ["JIRA_API_TOKEN"],
      critical: true,
      mode: "down",
      ping: { ok: false, latencyMs: 40, error: "Jira authentication check failed." },
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
  const router = { refresh() {} };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={router as never}>
        <HealthScreen data={data} />
      </AppRouterContext.Provider>,
    );
  });
  const text = textOf(renderer.toJSON());
  assert.match(text, /Action required/);
  assert.match(text, /Jira authentication check failed/);
  assert.match(text, /JIRA_API_TOKEN/);
  assert.match(text, /DATABASE_URL/);
  assert.doesNotMatch(text, /secret-value/);
  act(() => renderer.unmount());
});

test("scan again refreshes the server data", () => {
  let refreshes = 0;
  const router = { refresh: () => refreshes++ };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={router as never}>
        <HealthScreen data={{ ...data, alerts: [], summary: { ...data.summary, down: 0, criticalDown: 0 } }} />
      </AppRouterContext.Provider>,
    );
  });
  const button = renderer.root.findByProps({ children: "Scan again" });
  act(() => button.props.onClick());
  assert.equal(refreshes, 1);
  act(() => renderer.unmount());
});
