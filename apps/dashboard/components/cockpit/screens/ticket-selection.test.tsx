// apps/dashboard/components/cockpit/screens/ticket-selection.test.tsx
//
// The detail column is the desktop's alone when the URL names no run: a phone
// shows the runs list, and this column sits behind `display: none`. A trace
// left mounted there fetches and polls every five seconds for as long as the
// page is open, which every phone would pay on every ticket for something
// nobody can look at. So: a column nobody can see holds no trace.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { installBrowser } from "@/lib/agent-visibility/test-support/browser";

import { DetailArea, TicketSelectionProvider } from "./ticket-selection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

const router = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

function Trace() {
  return React.createElement("div", { "data-trace": "true" }, "the trace");
}

/** Renders the detail column with `onScreen` decided by what the column's
 *  own node reports: no rectangles is what `display: none` looks like from
 *  JavaScript. */
function render(t: TestContext, options: { visible: boolean; run: string | null }) {
  const originalFetch = globalThis.fetch;
  // The repository panel above the trace reads the record; it is not what this
  // is about, and it must not reach the network from a test.
  globalThis.fetch = (() => Promise.resolve(Response.json({ error: "not served" }, { status: 503 }))) as typeof fetch;
  const uninstallBrowser = installBrowser();
  const search = new URLSearchParams(options.run === null ? "" : `run=${options.run}`);
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={router as never}>
        <SearchParamsContext.Provider value={search}>
          <TicketSelectionProvider ticketKey="AWP-235">
            <DetailArea>
              <Trace />
            </DetailArea>
          </TicketSelectionProvider>
        </SearchParamsContext.Provider>
      </AppRouterContext.Provider>,
      {
        createNodeMock: () => ({
          getClientRects: () => (options.visible ? [{ width: 940 }] : []),
        }),
      },
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    uninstallBrowser();
    globalThis.fetch = originalFetch;
  });
  return renderer.root;
}

function traces(root: ReactTestInstance): number {
  return root.findAll((node) => node.type === Trace).length;
}

test("a detail column nobody can see holds no trace", (t) => {
  const hidden = render(t, { visible: false, run: null });
  assert.equal(traces(hidden), 0, "a hidden column mounted the trace, which then fetches and polls unseen");
});

test("the column a person is looking at holds the trace", (t) => {
  assert.equal(traces(render(t, { visible: true, run: null })), 1);
});

test("the phone's run view is that same column, and never loses its trace to the gate", (t) => {
  // Below `lg` with a run named, this column IS the page: what a person came
  // for. Gating must never take the trace away from a column they can see.
  assert.equal(traces(render(t, { visible: true, run: "wrun_fx_planning" })), 1);
});
