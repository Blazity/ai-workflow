import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { Run, RunsResponse } from "@shared/contracts";
import { RunsScreen } from "./runs";
import { RunsMobileScreen } from "../mobile/screens/runs-mobile";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeRun(overrides: Partial<Run> & { id: string; status: Run["status"] }): Run {
  return {
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
    ticketUrl: "https://jira.example/browse/AIW-1",
    prUrl: null,
    prs: null,
    ...overrides,
  };
}

function makeData(rows: Run[]): RunsResponse {
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

function nodeText(node: ReactTestInstance): string {
  return node.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

// Exact match, not substring: the busy label "Cancelling…" would otherwise
// also match a lookup for "Cancel".
function buttons(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root
    .findAll((node) => node.type === "button")
    .filter((node) => nodeText(node) === text);
}

function button(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = buttons(root, text);
  assert.equal(matches.length, 1, `expected exactly one button with text ${text}`);
  return matches[0];
}

function screenText(root: ReactTestInstance): string {
  return nodeText(root);
}

type FetchCall = { url: string; init: RequestInit | undefined };

/** Minimal app router: the screen only calls refresh, and WindowSelector
 *  needs the context to exist at all (its useRouter() call throws otherwise). */
function stubRouter(refreshes: string[]) {
  return {
    refresh: () => refreshes.push("refresh"),
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
}

const CANCELLED_RESPONSE = () =>
  Response.json({ outcome: "cancelled", runId: "run_1", subjectKey: null }, { status: 200 });

type DesktopProps = Partial<React.ComponentProps<typeof RunsScreen>>;
type MobileProps = Partial<React.ComponentProps<typeof RunsMobileScreen>>;

function renderDesktop(
  t: TestContext,
  props: DesktopProps,
  respond: () => Response = CANCELLED_RESPONSE,
): { root: ReactTestInstance; calls: FetchCall[]; refreshes: string[] } {
  const calls: FetchCall[] = [];
  const refreshes: string[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  };

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter(refreshes) as never}>
        <RunsScreen data={makeData([])} window="24h" q="" {...props} />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
  });
  return { root: renderer.root, calls, refreshes };
}

function renderMobile(
  t: TestContext,
  props: MobileProps,
  respond: () => Response = CANCELLED_RESPONSE,
): { root: ReactTestInstance; calls: FetchCall[]; refreshes: string[] } {
  const calls: FetchCall[] = [];
  const refreshes: string[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  };

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={stubRouter(refreshes) as never}>
        <RunsMobileScreen data={makeData([])} window="24h" q="" {...props} />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
  });
  return { root: renderer.root, calls, refreshes };
}

// ── Desktop (RunsScreen) ────────────────────────────────────────────────────

test("the model column names the attributed model, and unknown when there is none", (t) => {
  // A run the API could not attribute a model to must read as explicitly
  // unknown; it must never be labelled with the organization default (AIW-253).
  const { root } = renderDesktop(t, {
    data: makeData([
      makeRun({ id: "run_attributed", status: "failed", model: "gpt-5.6-sol" }),
      makeRun({ id: "run_unknown", status: "failed", model: null }),
    ]),
  });
  const text = screenText(root);
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /model unknown/);
});

test("Cancel is absent for a row that is not running", (t) => {
  const row = makeRun({ id: "run_1", status: "success" });
  const { root } = renderDesktop(t, {
    data: makeData([row]),
    canCancel: true,
  });
  assert.equal(buttons(root, "Cancel").length, 0);
});

test("Cancel is absent from a running row without the dispatch role", (t) => {
  const row = makeRun({ id: "run_1", status: "running" });
  const { root } = renderDesktop(t, {
    data: makeData([row]),
    // canCancel omitted -> defaults to false, mirroring a member session.
  });
  assert.equal(buttons(root, "Cancel").length, 0);
});

test("Cancel is offered for a running row with the dispatch role and arms a confirmation without posting", (t) => {
  const row = makeRun({ id: "run_1", status: "running" });
  const { root, calls } = renderDesktop(t, {
    data: makeData([row]),
    canCancel: true,
  });
  assert.equal(buttons(root, "Cancel").length, 1);

  act(() => {
    button(root, "Cancel").props.onClick();
  });

  assert.match(screenText(root), /Cancel run\?/);
  assert.equal(buttons(root, "Confirm").length, 1);
  assert.equal(calls.length, 0, "arming the confirmation alone must not cancel anything");
});

test("confirming posts the cancel proxy for the exact run id", async (t) => {
  const row = makeRun({ id: "run_42", status: "running" });
  const { root, calls } = renderDesktop(t, {
    data: makeData([row]),
    canCancel: true,
  });

  act(() => {
    button(root, "Cancel").props.onClick();
  });
  await act(async () => {
    button(root, "Confirm").props.onClick();
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/runs/run_42/cancel");
  assert.equal(calls[0].init?.method, "POST");
});

test("a cancelled outcome shows success feedback and refreshes", async (t) => {
  const row = makeRun({ id: "run_1", status: "running" });
  const { root, refreshes } = renderDesktop(
    t,
    { data: makeData([row]), canCancel: true },
    () => Response.json({ outcome: "cancelled", runId: "run_1", subjectKey: null }, { status: 200 }),
  );

  act(() => {
    button(root, "Cancel").props.onClick();
  });
  await act(async () => {
    button(root, "Confirm").props.onClick();
  });

  assert.match(screenText(root), /Run cancelled\./);
  assert.doesNotMatch(screenText(root), /already ended/);
  assert.deepEqual(refreshes, ["refresh"]);
});

test("an already_terminal outcome is never shown as a fresh cancel, but still refreshes", async (t) => {
  // The load-bearing rule from the E4 security review: a 200 can carry
  // "already_terminal" and must not be read as a successful cancel.
  const row = makeRun({ id: "run_1", status: "running" });
  const { root, refreshes } = renderDesktop(
    t,
    { data: makeData([row]), canCancel: true },
    () =>
      Response.json(
        { outcome: "already_terminal", runId: "run_1", runStatus: "running" },
        { status: 200 },
      ),
  );

  act(() => {
    button(root, "Cancel").props.onClick();
  });
  await act(async () => {
    button(root, "Confirm").props.onClick();
  });

  assert.match(screenText(root), /Run had already ended\./);
  assert.doesNotMatch(screenText(root), /Run cancelled\./);
  assert.deepEqual(refreshes, ["refresh"]);
});

test("an unconfirmed (409) outcome offers a retry and does not refresh", async (t) => {
  const row = makeRun({ id: "run_1", status: "running" });
  const { root, refreshes } = renderDesktop(
    t,
    { data: makeData([row]), canCancel: true },
    () => Response.json({ outcome: "unconfirmed", runId: "run_1" }, { status: 409 }),
  );

  act(() => {
    button(root, "Cancel").props.onClick();
  });
  await act(async () => {
    button(root, "Confirm").props.onClick();
  });

  assert.match(screenText(root), /Could not confirm the cancel\. Try again\./);
  assert.deepEqual(refreshes, [], "an unconfirmed cancel has nothing for the server to catch up on");
  // The row is still "running", so Cancel stays offered as the retry
  // affordance.
  assert.equal(buttons(root, "Cancel").length, 1);
});

test("a resolving cancel on one row leaves another row's just-armed confirmation intact", async (t) => {
  const rowA = makeRun({ id: "run_a", status: "running" });
  const rowB = makeRun({ id: "run_b", status: "running" });
  let resolveFetch!: (value: Response) => void;
  const { root, calls } = renderDesktop(
    t,
    { data: makeData([rowA, rowB]), canCancel: true },
    () => new Promise<Response>((resolve) => { resolveFetch = resolve; }) as unknown as Response,
  );

  // Arm row A (both rows offer "Cancel" at this point; row A renders first).
  act(() => {
    buttons(root, "Cancel")[0].props.onClick();
  });
  // Confirm row A: its request hangs, not yet resolved.
  act(() => {
    button(root, "Confirm").props.onClick();
  });
  assert.equal(calls.length, 1, "row A's cancel is in flight");

  // Arm row B's confirmation while row A's cancel is still pending (row B is
  // the only row still offering a plain "Cancel" button at this point).
  act(() => {
    button(root, "Cancel").props.onClick();
  });
  assert.equal(buttons(root, "Confirm").length, 1, "row B is now armed");
  assert.equal(calls.length, 1, "arming row B must not post anything");

  // Row A's request resolves.
  await act(async () => {
    resolveFetch(Response.json({ outcome: "cancelled", runId: "run_a", subjectKey: null }, { status: 200 }));
  });

  assert.equal(calls.length, 1, "row A's resolve posts nothing new");
  // Row B's confirmation must still be armed, not collapsed by row A's resolve.
  assert.equal(buttons(root, "Confirm").length, 1, "row B's armed confirmation survives row A's resolve");
});

// ── Mobile (RunsMobileScreen) ───────────────────────────────────────────────

test("mobile: Cancel is absent for a row that is not running", (t) => {
  const row = makeRun({ id: "run_1", status: "success" });
  const { root } = renderMobile(t, {
    data: makeData([row]),
    canCancel: true,
  });
  assert.equal(buttons(root, "Cancel").length, 0);
});

test("mobile: Cancel is absent from a running row without the dispatch role", (t) => {
  const row = makeRun({ id: "run_1", status: "running" });
  const { root } = renderMobile(t, {
    data: makeData([row]),
    // canCancel omitted -> defaults to false.
  });
  assert.equal(buttons(root, "Cancel").length, 0);
});

test("mobile: confirming posts the cancel proxy and reports a cancelled outcome", async (t) => {
  const row = makeRun({ id: "run_7", status: "running" });
  const { root, calls, refreshes } = renderMobile(
    t,
    { data: makeData([row]), canCancel: true },
    () => Response.json({ outcome: "cancelled", runId: "run_7", subjectKey: null }, { status: 200 }),
  );

  act(() => {
    button(root, "Cancel").props.onClick({ stopPropagation: () => undefined });
  });
  await act(async () => {
    button(root, "Confirm").props.onClick();
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/runs/run_7/cancel");
  assert.equal(calls[0].init?.method, "POST");
  assert.match(screenText(root), /Run cancelled\./);
  assert.deepEqual(refreshes, ["refresh"]);
});
