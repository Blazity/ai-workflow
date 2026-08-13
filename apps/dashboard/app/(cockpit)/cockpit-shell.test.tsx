// apps/dashboard/app/(cockpit)/cockpit-shell.test.tsx
//
// Integration cover for the automatic run refresh (AIW-266). The unit tests
// around `createLivePoll` and the screen tests both passed while production was
// frozen, because neither wired a run screen to the shell that actually owns the
// `router.refresh()` loop: the screens render without a CockpitCtx provider, so
// their `registerRunRefresh` was the context default (a no-op). These tests
// mount the real shell around a real screen and count refreshes over time.
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { CockpitShell } from "./cockpit-shell";
import { RunsScreen } from "@/components/cockpit/screens/runs";
import { TraceDetail } from "@/components/cockpit/screens/trace";
import {
  TicketSelectionProvider,
  DetailArea,
} from "@/components/cockpit/screens/ticket-selection";
import type {
  Run,
  RunsResponse,
  RunDetailResponse,
  WorkflowRunReplayResponse,
} from "@shared/contracts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Environment: the shell is a browser component, so stub just enough DOM ───

const visibilityListeners = new Set<() => void>();
const focusListeners = new Set<() => void>();
let storedTweaks: string | null = null;

const doc = {
  visibilityState: "visible" as "visible" | "hidden",
  addEventListener: (_: string, cb: () => void) => visibilityListeners.add(cb),
  removeEventListener: (_: string, cb: () => void) => visibilityListeners.delete(cb),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { style: {}, appendChild: () => {}, removeChild: () => {} },
  documentElement: { style: {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
};
(globalThis as unknown as { document: typeof doc }).document = doc;
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: () => storedTweaks,
    setItem: () => {},
  },
  addEventListener: (event: string, cb: () => void) => {
    if (event === "focus") focusListeners.add(cb);
  },
  removeEventListener: (event: string, cb: () => void) => {
    if (event === "focus") focusListeners.delete(cb);
  },
  dispatchEvent: () => true,
};

/** Hide or show the tab the way Chrome does: flip the flag, then notify. */
function setVisibility(state: "visible" | "hidden"): void {
  doc.visibilityState = state;
  act(() => {
    for (const cb of [...visibilityListeners]) cb();
  });
}

function beginTest(t: TestContext, tweaks: Record<string, unknown> | null = null): void {
  storedTweaks = tweaks ? JSON.stringify(tweaks) : null;
  doc.visibilityState = "visible";
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response("{}", { status: 500 });
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  t.after(() => {
    mock.timers.reset();
    storedTweaks = null;
    doc.visibilityState = "visible";
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeRun(id: string, status: Run["status"]): Run {
  return {
    id,
    status,
    workflow: "wf_ticket",
    workflowName: "Ticket workflow",
    ticket: "AIW-1",
    actor: "ai-bot",
    model: "gpt-5.6",
    startedAtMin: 3,
    duration: null,
    tokens: null,
    cost: null,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: "Do the thing",
    prNumber: null,
    ticketUrl: "",
    prUrl: null,
    prs: null,
  };
}

function makeRunsData(rows: Run[]): RunsResponse {
  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  for (const r of rows) counts[r.status]++;
  return {
    generatedAt: "2026-08-10T00:00:00.000Z",
    available: true,
    rows,
    total: rows.length,
    counts,
  };
}

function makeDetail(status: Run["status"]): RunDetailResponse {
  return {
    generatedAt: "2026-08-10T00:00:00.000Z",
    available: true,
    run: {
      id: "run_1",
      workflow: "wf_ticket",
      workflowName: "Ticket workflow",
      status,
      ticket: "AIW-1",
      ticketTitle: "Do the thing",
      ticketUrl: "",
      prNumber: null,
      prUrl: null,
      prs: null,
      model: "gpt-5.6",
      createdAt: "2026-08-10T00:00:00.000Z",
      startedAt: "2026-08-10T00:00:00.000Z",
      completedAt: null,
      durationSec: null,
      error: null,
      deploymentId: null,
    },
    steps: [],
    clarification: null,
  };
}

const REPLAY: WorkflowRunReplayResponse = {
  availability: "not_captured",
  mayAdvance: true,
  snapshot: null,
  attempts: [],
  nextCursor: null,
};

// ── Harness ─────────────────────────────────────────────────────────────────

function mountShell(
  t: TestContext,
  pathname: string,
  child: React.ReactNode,
): { refreshes: string[]; root: ReactTestInstance } {
  const refreshes: string[] = [];
  const router = {
    refresh: () => refreshes.push("refresh"),
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
  const session = {
    organizationName: "Org",
    actorLabel: "me",
    role: "owner",
    canManageUsers: true,
    canEditChecks: true,
    canEditWorkflows: true,
    canDispatchWorkflows: true,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={router as never}>
        <PathnameContext.Provider value={pathname}>
          <SearchParamsContext.Provider value={new URLSearchParams() as never}>
            <CockpitShell session={session as never}>{child}</CockpitShell>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  return { refreshes, root: renderer.root };
}

function runsList(t: TestContext, rows: Run[], tweaks?: Record<string, unknown>) {
  beginTest(t, tweaks ?? null);
  return mountShell(
    t,
    "/runs",
    <RunsScreen data={makeRunsData(rows)} window="24h" q="" />,
  );
}

function runDetail(t: TestContext, status: Run["status"]) {
  beginTest(t);
  return mountShell(
    t,
    "/ticket/AIW-1",
    <TicketSelectionProvider ticketKey="AIW-1">
      <DetailArea>
        <TraceDetail
          runId="run_1"
          data={makeDetail(status)}
          replay={REPLAY}
          enableRunRefresh
        />
      </DetailArea>
    </TicketSelectionProvider>,
  );
}

function advance(ms: number): void {
  act(() => {
    mock.timers.tick(ms);
  });
}

/** The live-poll badge text, deduped: the control renders in both the desktop
 *  topbar and the mobile header, and both must say the same thing. */
function liveBadge(root: ReactTestInstance): string {
  const labels = root
    .findAll(
      (node) =>
        typeof node.type === "string" &&
        node.props.className?.includes?.("uppercase") &&
        typeof node.children[0] === "string" &&
        /^(Live|Live off|Paused|Watching)$/.test(node.children[0]),
    )
    .map((node) => node.children[0] as string);
  assert.ok(labels.length > 0, "expected the live-poll control to render a label");
  assert.equal(
    new Set(labels).size,
    1,
    `desktop and mobile live badges disagree: ${labels.join(", ")}`,
  );
  return labels[0];
}

// ── Runs list ───────────────────────────────────────────────────────────────

test("the runs list keeps refreshing for longer than a run actually takes", (t) => {
  // Real runs measured on production last 400-730s, so a refresh loop that dies
  // after five minutes abandons the user mid-run with no signal.
  const { refreshes } = runsList(t, [makeRun("run_1", "running")]);
  advance(5 * 60_000);
  const atFiveMinutes = refreshes.length;
  advance(7 * 60_000);
  assert.ok(
    refreshes.length > atFiveMinutes + 60,
    `the loop stalled after ${atFiveMinutes} refreshes; at 12 minutes it had ${refreshes.length}`,
  );
});

test("the runs list still polls when every visible run has finished, so new runs appear", (t) => {
  // The row set itself is what a live list is watching. Gating the loop on the
  // rows already rendered is a closed loop: a list of finished runs can never
  // learn that a new run started.
  const { refreshes } = runsList(t, [makeRun("run_1", "success")]);
  advance(2 * 60_000);
  assert.ok(
    refreshes.length >= 2,
    `a settled list never refreshed (${refreshes.length} in 2 minutes), so a new run could never show up`,
  );
});

// ── Single run view ─────────────────────────────────────────────────────────

test("a run parked on human input keeps refreshing", (t) => {
  // "awaiting" is the state where the user most needs to see movement: the
  // question arriving, and their answer restarting the run.
  const { refreshes } = runDetail(t, "awaiting");
  advance(60_000);
  assert.ok(refreshes.length >= 10, `expected a 5s cadence, got ${refreshes.length} in a minute`);
});

test("a parked run is still refreshing by the time the human answers", (t) => {
  // Parking is the longest-lived state there is, because it waits on a person.
  // The loop has to outlive however long they take to type an answer, and this
  // is the exact case production froze on: the trace stuck at
  // "waiting_for_clarification" while the answer had already restarted the run.
  const { refreshes } = runDetail(t, "awaiting");
  advance(5 * 60_000);
  const atFiveMinutes = refreshes.length;
  advance(5 * 60_000);
  assert.ok(
    refreshes.length > atFiveMinutes + 50,
    `the loop stalled after ${atFiveMinutes} refreshes, so a parked run stops updating ` +
      `while the user waits; at 10 minutes it had ${refreshes.length}`,
  );
});

test("the single run view keeps refreshing for longer than a run actually takes", (t) => {
  const { refreshes } = runDetail(t, "running");
  advance(5 * 60_000);
  const atFiveMinutes = refreshes.length;
  advance(7 * 60_000);
  assert.ok(
    refreshes.length > atFiveMinutes + 60,
    `the loop stalled after ${atFiveMinutes} refreshes; at 12 minutes it had ${refreshes.length}`,
  );
});

test("a finished run's view does not poll", (t) => {
  const { refreshes } = runDetail(t, "success");
  advance(2 * 60_000);
  assert.equal(refreshes.length, 0, "a terminal run's trace is immutable");
});

// ── Visibility: pause is intended, the resume must restore the whole cycle ───

test("returning to the tab restores the refresh cycle, not a single refresh", (t) => {
  // Pausing a hidden tab is deliberate. What must not happen is coming back to
  // a tab that refreshes once and then goes quiet again.
  const { refreshes } = runDetail(t, "running");
  advance(6 * 60_000);
  setVisibility("hidden");
  const whileHidden = refreshes.length;
  advance(60_000);
  assert.equal(refreshes.length, whileHidden, "a hidden tab must not poll");

  setVisibility("visible");
  const onReturn = refreshes.length;
  assert.ok(onReturn > whileHidden, "coming back must refresh immediately");
  advance(30_000);
  assert.ok(
    refreshes.length >= onReturn + 5,
    `the cycle did not resume: ${refreshes.length - onReturn} refreshes in the 30s after returning`,
  );
});

// ── The LIVE badge ──────────────────────────────────────────────────────────

test("the badge does not claim live data while the tab is hidden and nothing polls", (t) => {
  // The worst failure mode: a frozen screen that also tells the user it is
  // current, removing their only cue to reload.
  const { refreshes, root } = runsList(t, [makeRun("run_1", "running")], {
    livePolling: true,
  });
  setVisibility("hidden");
  const whileHidden = refreshes.length;
  advance(60_000);
  assert.equal(refreshes.length, whileHidden, "a hidden tab must not poll");
  assert.notEqual(
    liveBadge(root),
    "Live",
    "the badge promised live data while the loop was paused",
  );
});

test("the badge reports live data while the loop really is running", (t) => {
  const { refreshes, root } = runsList(t, [makeRun("run_1", "running")]);
  advance(30_000);
  assert.ok(refreshes.length > 0, "expected the loop to be running");
  assert.equal(liveBadge(root), "Live");
});
