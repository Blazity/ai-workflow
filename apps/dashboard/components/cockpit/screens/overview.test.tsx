import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { Run } from "@/lib/types";
import type { DispatchCapacityResponse } from "@shared/contracts";
import {
  AwaitingInputPanel,
  NowRunningPanel,
  OverviewScreen,
  type OverviewScreenData,
} from "./overview";
import { OverviewMobileScreen } from "../mobile/screens/overview-mobile";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// next/link schedules its prefetch through an idle callback that reads `self`,
// which node does not define. Without it every render of a row link throws.
(globalThis as { self?: unknown }).self = globalThis;

const BASE_RUN: Run = {
  id: "run_1",
  workflow: "wf_agent",
  workflowName: "Agent",
  status: "awaiting",
  ticket: "AWT-1",
  actor: "ai-bot",
  model: "claude-opus-4-8",
  startedAtMin: 30,
  duration: null,
  tokens: null,
  cost: null,
  spans: null,
  evalScore: null,
  guardrailHits: null,
  ticketTitle: "Ship it",
  prNumber: null,
  ticketUrl: "https://blazity.atlassian.net/browse/AWT-1",
  prUrl: null,
  prs: null,
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

/** Minimal app router: AwaitingInputPanel never navigates through it directly
 *  (the approval CTA is a next/link `<Link>`), but next/link needs the context
 *  to exist at all. */
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

function renderPanel(t: TestContext, rows: Run[]): { root: ReactTestInstance; opened: Run[] } {
  const opened: Run[] = [];
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter() as never}>
        <AwaitingInputPanel rows={rows} onOpenRun={(r) => opened.push(r)} />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
  });
  return { root: renderer.root, opened };
}

function capacity(
  over: Partial<DispatchCapacityResponse> = {},
): DispatchCapacityResponse {
  return {
    generatedAt: "2026-08-16T12:00:00.000Z",
    occupiedSlots: 0,
    maxSlots: 3,
    queued: [],
    ...over,
  };
}

function renderNowRunning(
  t: TestContext,
  rows: Run[],
  cap: DispatchCapacityResponse,
): ReactTestInstance {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter() as never}>
        <NowRunningPanel rows={rows} capacity={cap} onOpenRun={() => {}} />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

/** What the Overview receives: one list, the store's runs for the window plus
 *  the open runs the live board adds, the same list the Runs page shows. */
function overviewData(rows: Run[], cap: DispatchCapacityResponse = capacity()): OverviewScreenData {
  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  for (const run of rows) counts[run.status]++;
  return {
    kpis: {
      generatedAt: "2026-08-10T00:00:00.000Z",
      runs24h: null,
      p95: null,
      errors24h: null,
      cost24h: null,
    },
    runs: {
      generatedAt: "2026-08-10T00:00:00.000Z",
      available: true,
      rows,
      total: rows.length,
      counts,
    },
    capacity: cap,
    workflows: { generatedAt: "2026-08-10T00:00:00.000Z", rows: [], total: 0 },
  };
}

test("a full pool with zero executing runs shows it is full and lists the waiting tickets", (t) => {
  // The bug AIW-277 fixes: parked claims fill every slot, nothing is "running",
  // and the panel used to read as idle. It must now show the occupied count and
  // the at-capacity queue.
  const root = renderNowRunning(t, [], capacity({
    occupiedSlots: 3,
    maxSlots: 3,
    queued: [
      { ticketKey: "AWT-9", queuedAt: new Date(Date.now() - 5 * 60_000 - 5_000).toISOString() },
    ],
  }));

  const text = nodeText(root);
  assert.match(text, /3\/3 slots/);
  assert.match(text, /waiting for capacity/);
  assert.match(text, /AWT-9/);
  assert.match(text, /waiting 5m/);
});

test("an idle pool shows free slots and no waiting queue", (t) => {
  const root = renderNowRunning(t, [], capacity({ occupiedSlots: 0, maxSlots: 3 }));

  const text = nodeText(root);
  assert.match(text, /0\/3 slots/);
  assert.doesNotMatch(text, /waiting for capacity/);
});

test("the worker-unavailable fallback (maxSlots 0) reads as unknown, never full", (t) => {
  const root = renderNowRunning(t, [], capacity({ occupiedSlots: 0, maxSlots: 0 }));

  const text = nodeText(root);
  assert.match(text, /slots N\/A/);
  // The 0/0 fallback must not render as "0/0" nor claim the pool is full.
  assert.doesNotMatch(text, /0\/0/);
});

test("a running ticket is excluded from the waiting-for-capacity list", (t) => {
  // A ticket stays in the AI column while it runs, so its stale queue row could
  // leak into the waiting list. The panel must drop any ticket already live.
  const runningRow: Run = { ...BASE_RUN, id: "run_live", status: "running", ticket: "AWT-9" };
  const root = renderNowRunning(
    t,
    [runningRow],
    capacity({
      occupiedSlots: 3,
      maxSlots: 3,
      queued: [{ ticketKey: "AWT-9", queuedAt: new Date(Date.now() - 3 * 60_000).toISOString() }],
    }),
  );

  const text = nodeText(root);
  assert.doesNotMatch(text, /waiting for capacity/);
});

test("a clarification row keeps its Answer CTA to the run trace, unchanged", (t) => {
  const row: Run = {
    ...BASE_RUN,
    question: "1. Which environment?",
    suggestedAnswers: ["staging"],
    askedAtMin: 5,
  };
  const { root, opened } = renderPanel(t, [row]);

  const links = root.findAll((n) => n.type === "a").map((n) => String(n.props.href ?? ""));
  assert.deepEqual(links.filter((href) => href === "/approvals"), []);

  const answerButtons = root
    .findAll((n) => n.type === "button")
    .filter((n) => nodeText(n).includes("Answer"));
  assert.equal(answerButtons.length, 1);

  act(() => {
    answerButtons[0].props.onClick();
  });
  assert.deepEqual(opened, [row]);
  assert.match(nodeText(root), /Which environment\?/);
});

// Red when: a screen prints a run's age as a raw minute count. QA read
// "6998m ago" on the desktop Overview beside "4d ago" on the phone for the same
// run; this test used to pin the desktop to "125m ago".
test("desktop overview dates clarification and run ages in hours and days", (t) => {
  const awaiting: Run = { ...BASE_RUN, askedAtMin: 125 };
  const recent: Run = { ...BASE_RUN, id: "run_recent", status: "success", startedAtMin: 6998 };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter() as never}>
        <OverviewScreen data={overviewData([awaiting, recent])} window="24h" />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));

  const text = nodeText(renderer.root);
  assert.match(text, /2h ago/);
  assert.match(text, /4d ago/);
  assert.doesNotMatch(text, /125m ago|6998m ago/);
});

test("mobile overview formats a 60-plus-minute clarification age", (t) => {
  const awaiting: Run = { ...BASE_RUN, askedAtMin: 125 };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter() as never}>
        <OverviewMobileScreen
          window="24h"
          data={overviewData([awaiting])}
        />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));

  assert.match(nodeText(renderer.root), /2h ago/);
  assert.doesNotMatch(nodeText(renderer.root), /125m ago/);
});

test("an approval-parked row gets a Review plan link to /approvals, not the Answer dead end", (t) => {
  const row: Run = {
    ...BASE_RUN,
    awaitingKind: "approval",
    approvalId: "ap_1",
  };
  const { root } = renderPanel(t, [row]);

  const text = nodeText(root);
  assert.match(text, /Review plan/);
  assert.doesNotMatch(text, /Answer →/);

  const approvalLinks = root
    .findAll((n) => n.type === "a")
    .filter((n) => n.props.href === "/approvals");
  assert.equal(approvalLinks.length, 1);

  // The null question must never render as if it were a clarification.
  assert.doesNotMatch(text, /undefined/);
});

// ── One count per question ───────────────────────────────────────────────────
//
// QA at one moment: "Input needed · 3 paused" above "Recent runs · 0 awaiting",
// and "0 executing · 4/20 slots · No runs in flight" with nothing saying what
// held the four slots. The three were runs parked days ago; parked runs keep
// their slot until they are answered or cancelled.

function parkedDaysAgo(): Run[] {
  return [6998, 7040, 5800].map((startedAtMin, index): Run =>
    Object.assign({}, BASE_RUN, {
      id: `run_parked_${index}`,
      ticket: `AWP-24${index}`,
      startedAtMin,
      askedAtMin: startedAtMin - 5,
    }),
  );
}

test("the Overview's awaiting count is one number in every card that shows it", (t) => {
  const today: Run[] = [
    { ...BASE_RUN, id: "run_ok", status: "success", startedAtMin: 30 },
    { ...BASE_RUN, id: "run_ok2", status: "success", startedAtMin: 90 },
  ];
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter() as never}>
        <OverviewScreen data={overviewData([...parkedDaysAgo(), ...today])} window="24h" />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));

  const text = nodeText(renderer.root);
  assert.match(text, /3 paused/);
  assert.match(text, /3 awaiting/);
  assert.doesNotMatch(text, /0 awaiting/);
  assert.match(text, /Also listed: 3 older runs still waiting for input\./);
});

test("slots taken with nothing executing say what holds them", (t) => {
  const root = renderNowRunning(t, parkedDaysAgo(), capacity({ occupiedSlots: 4, maxSlots: 20 }));
  const text = nodeText(root);
  assert.match(text, /4\/20 slots/);
  assert.match(text, /No runs executing\./);
  assert.match(
    text,
    /3 slots held by parked runs until answered or cancelled, 1 by a run starting or finishing\./,
  );
  assert.doesNotMatch(text, /No runs in flight/);
});

test("the slot sentence never claims more parked holders than slots are taken", (t) => {
  // An approval parked on the Approvals page need not hold a slot at all, so
  // the count of awaiting rows can exceed the slots taken.
  const root = renderNowRunning(t, parkedDaysAgo(), capacity({ occupiedSlots: 2, maxSlots: 20 }));
  const text = nodeText(root);
  assert.match(text, /2 slots held by parked runs until answered or cancelled\./);
  assert.doesNotMatch(text, /starting or finishing/);
});

test("slots held beside executing runs are named under them", (t) => {
  const running: Run = { ...BASE_RUN, id: "run_exec", status: "running", ticket: "AWP-1", startedAtMin: 2 };
  const root = renderNowRunning(t, [running, ...parkedDaysAgo().slice(0, 1)], capacity({ occupiedSlots: 2, maxSlots: 20 }));
  const text = nodeText(root);
  assert.match(text, /1 slot held by a parked run until answered or cancelled\./);
});

test("an idle pool still says nothing is in flight", (t) => {
  const root = renderNowRunning(t, [], capacity({ occupiedSlots: 0, maxSlots: 20 }));
  assert.match(nodeText(root), /No runs in flight/);
});
