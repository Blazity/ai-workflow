import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { CostResponse } from "@shared/contracts";
import { CostScreen } from "./cost";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubRouter() {
  return {
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
}

function data(daily: CostResponse["daily"]): CostResponse {
  return {
    generatedAt: "2026-08-02T00:00:00.000Z",
    available: true,
    window: {
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-02T23:59:59.999Z",
    },
    totals: {
      totalTokenCost: daily.reduce((sum, day) => sum + day.cost, 0),
      totalTokens: daily.reduce((sum, day) => sum + day.tokens, 0),
      traceCount: daily.length,
      costPerRun: daily.length === 0 ? 0 : 1,
    },
    byWorkflow: [],
    daily,
  };
}

function renderCost(t: TestContext, daily: CostResponse["daily"]): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter() as never}>
        <CostScreen data={data(daily)} window="24h" />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

test("a one-day spend chart renders no synthetic rising point", (t) => {
  const root = renderCost(t, [
    { date: "2026-08-01T00:00:00.000Z", cost: 3.39, tokens: 1200 },
  ]);
  const line = root.findAll(
    (node) => node.type === "path" && node.props.fill === "none",
  )[0];

  assert.ok(line);
  assert.doesNotMatch(String(line.props.d), /L/);
});

test("the final spend label belongs to the real last day", (t) => {
  const root = renderCost(t, [
    { date: "2026-08-01T00:00:00.000Z", cost: 1, tokens: 100 },
    { date: "2026-08-02T00:00:00.000Z", cost: 2, tokens: 200 },
  ]);
  const labels = new Set(
    root
      .findAll((node) => node.type === "text")
      .map((node) => node.children.join("")),
  );

  assert.ok(labels.has("Aug 2"));
  assert.ok(!labels.has(""));
});
