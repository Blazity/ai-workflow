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
import { RepositoryScriptsScreen } from "@/components/cockpit/screens/repository-scripts";
import { RunsScreen } from "@/components/cockpit/screens/runs";
import { TraceDetail, TraceScreen } from "@/components/cockpit/screens/trace";
import {
  TicketSelectionProvider,
  DetailArea,
} from "@/components/cockpit/screens/ticket-selection";
import type {
  PrePrCheckConfig,
  PrePrChecksResponse,
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
/** What window.confirm answers, and what it was asked. The nav guard is the
 *  only caller: a screen holding unsaved edits is asked about before the shell
 *  navigates away from it. */
let confirmAnswer = true;
const confirmPrompts: string[] = [];
/** Every request the mounted tree made, so a guard that has to run BEFORE one
 *  can be shown to have done so. */
const fetched: string[] = [];

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
  confirm: (message: string) => {
    confirmPrompts.push(message);
    return confirmAnswer;
  },
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
  confirmAnswer = true;
  confirmPrompts.length = 0;
  fetched.length = 0;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    fetched.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response("{}", { status: 500 });
  };
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
): {
  refreshes: string[];
  pushes: string[];
  root: ReactTestInstance;
  rerender: (next: React.ReactNode) => void;
} {
  const refreshes: string[] = [];
  const pushes: string[] = [];
  const router = {
    refresh: () => refreshes.push("refresh"),
    push: (href: string) => pushes.push(href),
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
  const tree = (inner: React.ReactNode) => (
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <CockpitShell session={session as never}>{inner}</CockpitShell>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(tree(child));
  });
  t.after(() => act(() => renderer.unmount()));
  return {
    refreshes,
    pushes,
    root: renderer.root,
    // Stands in for what a refresh delivers: the server component re-renders and
    // the screen receives new data.
    rerender: (next) => act(() => renderer.update(tree(next))),
  };
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

test("a list holding only a parked run polls at the live cadence, not the idle one", (t) => {
  // Parking must never be filed under "nothing in flight". Someone is watching
  // that screen waiting for their answer to land, so 30s is far too slow exactly
  // where it hurts most.
  const { refreshes } = runsList(t, [makeRun("run_1", "awaiting")]);
  advance(60_000);
  assert.ok(
    refreshes.length >= 10,
    `a parked run was put on the slow cadence: ${refreshes.length} refreshes in a minute`,
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

test("the standalone trace page refreshes itself too", (t) => {
  // /trace/<id> is the screen an audience watches while a run moves, so it must
  // not be the one surface left frozen.
  beginTest(t);
  const { refreshes } = mountShell(
    t,
    "/trace/run_1",
    <TraceScreen runId="run_1" data={makeDetail("running")} replay={REPLAY} />,
  );
  advance(60_000);
  assert.ok(refreshes.length >= 10, `expected a 5s cadence, got ${refreshes.length}`);
});

test("the loop is bounded by the run finishing, not by a tick count", (t) => {
  // Replaces #253's tick budget: ticking still has to end, but the thing that
  // ends it is the run reaching a durable outcome, which a counter cannot know.
  const { refreshes, rerender } = runDetail(t, "running");
  advance(30_000);
  const whileRunning = refreshes.length;
  assert.ok(whileRunning > 0, "expected the loop to be running");

  rerender(
    <TicketSelectionProvider ticketKey="AIW-1">
      <DetailArea>
        <TraceDetail
          runId="run_1"
          data={makeDetail("success")}
          replay={REPLAY}
          enableRunRefresh
        />
      </DetailArea>
    </TicketSelectionProvider>,
  );
  advance(5 * 60_000);
  assert.equal(
    refreshes.length,
    whileRunning,
    "the loop kept ticking after the run reached a terminal status",
  );
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

test("health never joins global polling, even when Live was persisted", (t) => {
  beginTest(t, { livePolling: true });
  const { refreshes, root } = mountShell(t, "/health", <div>Health</div>);

  advance(60_000);

  assert.equal(refreshes.length, 0, "health probes ran without a manual scan");
  assert.equal(
    root.findAllByProps({ "aria-label": "Toggle live updates" }).length,
    0,
    "health showed a Live control that cannot safely apply to this screen",
  );
});

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

// ── Navigating away from unsaved edits ──────────────────────────────────────
//
// The cockpit never reloads the document: every nav item is a router.push, and
// beforeunload (which the scripts screen also installs) is never consulted for
// one. Without the guard below, a sidebar click throws away an edit silently.

const SCRIPTS_CONFIG: PrePrCheckConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      groups: { checks: { commands: ["pnpm test"] } },
    },
  ],
  batchTimeoutMinutes: 45,
};

const SCRIPTS_INITIAL: PrePrChecksResponse = {
  current: {
    version: 1,
    config: SCRIPTS_CONFIG,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdById: "u1",
    createdByLabel: "Filip",
    restoredFromVersion: null,
  },
  versions: [
    {
      version: 1,
      config: SCRIPTS_CONFIG,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdById: "u1",
      createdByLabel: "Filip",
      restoredFromVersion: null,
    },
  ],
};

function scriptsScreen(t: TestContext) {
  beginTest(t);
  return mountShell(
    t,
    "/scripts",
    <RepositoryScriptsScreen initial={SCRIPTS_INITIAL} canEdit />,
  );
}

/** The sidebar's own nav callback, which is what a click on a nav item runs. */
function navigateTo(root: ReactTestInstance, id: string): void {
  const sidebar = root.findAll(
    (node) => typeof node.type === "function" && (node.type as { name?: string }).name === "CkSidebar",
  )[0];
  assert.ok(sidebar, "expected the desktop sidebar");
  act(() => {
    sidebar.props.onNav(id);
  });
}

/** Makes the screen dirty the cheapest way there is: the one top-level field. */
function editBatchTimeout(root: ReactTestInstance): void {
  const field = root.findAll(
    (node) => node.type === "input" && node.props.type === "number" && node.props.value === 45,
  )[0];
  assert.ok(field, "expected the batch timeout field");
  act(() => {
    field.props.onChange({ target: { value: "60" } });
  });
}

test("navigating away from a clean screen is not interrupted", (t) => {
  const { root, pushes } = scriptsScreen(t);
  navigateTo(root, "runs");
  assert.deepEqual(pushes, ["/runs"]);
  assert.deepEqual(confirmPrompts, [], "nothing was unsaved, so nothing should have been asked");
});

test("navigating away from unsaved repository scripts asks first and can be called off", (t) => {
  const { root, pushes } = scriptsScreen(t);
  editBatchTimeout(root);

  confirmAnswer = false;
  navigateTo(root, "runs");
  assert.deepEqual(confirmPrompts, ["Discard unsaved changes?"]);
  assert.deepEqual(pushes, [], "the edit would have been thrown away by that navigation");

  confirmAnswer = true;
  navigateTo(root, "runs");
  assert.deepEqual(pushes, ["/runs"], "confirming still navigates");
});

test("the guard is dropped when the screen holding the edit unmounts", (t) => {
  const { root, pushes, rerender } = scriptsScreen(t);
  editBatchTimeout(root);
  // Whatever the shell renders next has no unsaved edits of its own, and the
  // flag is the screen's, not the shell's.
  rerender(<div>Something else</div>);

  confirmAnswer = false;
  navigateTo(root, "runs");
  assert.deepEqual(confirmPrompts, []);
  assert.deepEqual(pushes, ["/runs"]);
});

/** How the Spotlight overlay leaves the current screen. The palette itself
 *  renders through a portal (react-test-renderer has no DOM for one), so the
 *  seam under test is the navigator the shell hands it, which is the same one
 *  the sidebar uses. */
function spotlightNavigate(root: ReactTestInstance): (href: string) => boolean {
  const spotlight = root.findAll(
    (node) =>
      typeof node.type === "function" && (node.type as { name?: string }).name === "SpotlightSearch",
  )[0];
  assert.ok(spotlight, "expected the Spotlight overlay to be mounted by the shell");
  assert.equal(
    typeof spotlight.props.navigate,
    "function",
    "Spotlight was mounted without a navigator, so Cmd+K would push straight past the guard",
  );
  return spotlight.props.navigate;
}

test("Cmd+K navigation goes through the same guard as the sidebar", (t) => {
  const { root, pushes } = scriptsScreen(t);
  editBatchTimeout(root);

  confirmAnswer = false;
  let jumped = true;
  act(() => {
    jumped = spotlightNavigate(root)("/ticket/AIW-1");
  });
  assert.equal(jumped, false, "a called-off jump has to report that it did not happen");
  assert.deepEqual(confirmPrompts, ["Discard unsaved changes?"]);
  assert.deepEqual(pushes, [], "Cmd+K would have thrown the edit away silently");

  confirmAnswer = true;
  act(() => {
    jumped = spotlightNavigate(root)("/ticket/AIW-1");
  });
  assert.equal(jumped, true);
  assert.deepEqual(pushes, ["/ticket/AIW-1"], "confirming still opens the ticket");
});

test("re-selecting the screen already open is not a departure and asks nothing", (t) => {
  const { root, pushes } = scriptsScreen(t);
  editBatchTimeout(root);

  confirmAnswer = false;
  navigateTo(root, "scripts");

  assert.deepEqual(confirmPrompts, [], "nothing is being left, so nothing can be lost");
  assert.deepEqual(pushes, ["/scripts"]);
});

test("an accepted discard is not asked about again while the push is still landing", (t) => {
  // router.push is not instant, and the screen stays mounted (and dirty) until
  // the new route renders. A second nav click in that window used to re-ask,
  // which reads as the app not having heard the first answer.
  const { root, pushes } = scriptsScreen(t);
  editBatchTimeout(root);

  confirmAnswer = true;
  navigateTo(root, "runs");
  navigateTo(root, "approvals");

  assert.deepEqual(confirmPrompts, ["Discard unsaved changes?"]);
  assert.deepEqual(pushes, ["/runs", "/approvals"]);
});

test("signing out asks before the session is gone, and a declined answer keeps it", async (t) => {
  const { root } = scriptsScreen(t);
  editBatchTimeout(root);

  const signOut = root
    .findAll((node) => node.type === "button")
    .find((node) => node.children.includes("Sign out"));
  assert.ok(signOut, "expected the Sign out button in the shell");

  confirmAnswer = false;
  await act(async () => {
    signOut.props.onClick();
  });
  assert.deepEqual(confirmPrompts, ["Discard unsaved changes?"]);
  assert.deepEqual(
    fetched.filter((call) => call.includes("/api/auth/logout")),
    [],
    "the session must still be there to come back to",
  );

  confirmAnswer = true;
  await act(async () => {
    signOut.props.onClick();
  });
  assert.deepEqual(fetched.filter((call) => call.includes("/api/auth/logout")), [
    "POST /api/auth/logout",
  ]);
});
