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

/** What `settle` watches: the requests this screen has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One render per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/**
 * Installs `handler` as the fetch for one test and returns the undo.
 *
 * Every answer lands a turn later, the way a response does: resolving in the
 * caller's own microtask is what let a counted wait look reliable.
 * `FIXTURE_SLOW_MS` delays every answer by that many milliseconds, which is how
 * this harness reproduces a runner slow enough to break a counted wait.
 */
function installFetch(
  calls: FetchCall[],
  respond: () => Response,
): () => void {
  const originalFetch = globalThis.fetch;
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  (globalThis as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    mine.inFlight += 1;
    mine.started += 1;
    // `respond` runs now, when the request goes out, because a test that holds
    // its own answer open takes the resolver from this very call.
    const answered = respond();
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      return answered;
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the requests a screen has out finish, and waits for exactly that.
 *
 * NEVER A COUNT OF TURNS. A cancel here is a POST whose body lands a turn or
 * more after the call, and the screen only then shows its outcome. How many
 * turns that costs is the runner's business, so a fixed count passes on an idle
 * machine and, on a loaded one, returns while the request is still in flight:
 * the assertion then reads a screen that has not heard back and the failure
 * looks like the product. Quiet is the condition those assertions mean, and it
 * is two things, because a request that lands can start the next one: nothing
 * in flight, and a turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of failing,
 * and a screen that never settles fails as a readable timeout rather than
 * hanging the suite.
 */
async function settle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await turn();
    if (reads.inFlight === 0) {
      const started = reads.started;
      await turn();
      if (reads.inFlight === 0 && reads.started === started) return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`the screen was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`);
    }
  }
}

/**
 * Waits for the thing the next assertion is about, and fails with what the
 * screen showed instead. For a state a person reaches through work the screen
 * does after its requests land, where "nothing in flight" is true too early.
 */
async function waitForText(root: ReactTestInstance, expected: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = screenText(root);
    if (expected.test(seen)) return seen;
    if (Date.now() >= deadline) {
      assert.fail(`waited ${timeoutMs} ms for ${expected}, and the screen showed: ${seen.slice(0, 900)}`);
    }
    await turn();
  }
}

/** Minimal app router: the screen only calls refresh, and WindowSelector
 *  needs the context to exist at all (its useRouter() call throws otherwise). */
function stubRouter(
  refreshes: string[],
  pushes: string[],
  replacements: string[],
  backs: string[],
) {
  return {
    refresh: () => refreshes.push("refresh"),
    push: (href: string) => pushes.push(href),
    replace: (href: string) => replacements.push(href),
    back: () => backs.push("back"),
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
): {
  root: ReactTestInstance;
  calls: FetchCall[];
  refreshes: string[];
  pushes: string[];
  replacements: string[];
  backs: string[];
  rerender: (next: DesktopProps) => void;
  goBack: (next: DesktopProps) => void;
} {
  const calls: FetchCall[] = [];
  const refreshes: string[] = [];
  const pushes: string[] = [];
  const replacements: string[] = [];
  const backs: string[] = [];
  const uninstallFetch = installFetch(calls, respond);

  const router = stubRouter(refreshes, pushes, replacements, backs);
  const tree = (next: DesktopProps) => (
    <AppRouterContext.Provider value={router as never}>
      <RunsScreen data={makeData([])} window="24h" q="" {...props} {...next} />
    </AppRouterContext.Provider>
  );
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(tree({}));
  });
  t.after(() => {
    act(() => renderer.unmount());
    uninstallFetch();
  });
  return {
    root: renderer.root,
    calls,
    refreshes,
    pushes,
    replacements,
    backs,
    rerender: (next) => act(() => renderer.update(tree(next))),
    goBack: (next) => act(() => {
      router.back();
      renderer.update(tree(next));
    }),
  };
}

function renderMobile(
  t: TestContext,
  props: MobileProps,
  respond: () => Response = CANCELLED_RESPONSE,
): {
  root: ReactTestInstance;
  calls: FetchCall[];
  refreshes: string[];
  pushes: string[];
  replacements: string[];
  backs: string[];
  rerender: (next: MobileProps) => void;
  goBack: (next: MobileProps) => void;
} {
  const calls: FetchCall[] = [];
  const refreshes: string[] = [];
  const pushes: string[] = [];
  const replacements: string[] = [];
  const backs: string[] = [];
  const uninstallFetch = installFetch(calls, respond);

  const router = stubRouter(refreshes, pushes, replacements, backs);
  const tree = (next: MobileProps) => (
    <AppRouterContext.Provider value={router as never}>
      <RunsMobileScreen data={makeData([])} window="24h" q="" {...props} {...next} />
    </AppRouterContext.Provider>
  );
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(tree({}));
  });
  t.after(() => {
    act(() => renderer.unmount());
    uninstallFetch();
  });
  return {
    root: renderer.root,
    calls,
    refreshes,
    pushes,
    replacements,
    backs,
    rerender: (next) => act(() => renderer.update(tree(next))),
    goBack: (next) => act(() => {
      router.back();
      renderer.update(tree(next));
    }),
  };
}

// ── Desktop (RunsScreen) ────────────────────────────────────────────────────

test("the model column names the attributed model, and unknown when there is none", (t) => {
  // A run the API could not attribute a model to must read as explicitly
  // unknown; it must never be labelled with the organization default (AIW-253).
  const { root } = renderDesktop(t, {
    data: makeData([
      makeRun({ id: "run_attributed", status: "failed", model: "gpt-5.6-sol" }),
      makeRun({ id: "run_unknown", status: "failed", model: undefined }),
    ]),
  });
  const text = screenText(root);
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /model unknown/);
});

test("the status URL drives the filtered count, rows, and pager", (t) => {
  const { root, pushes, replacements } = renderDesktop(t, {
    data: makeData([
      makeRun({ id: "run_ok", status: "success", ticketTitle: "Passed" }),
      makeRun({ id: "run_bad", status: "failed", ticketTitle: "Failed" }),
    ]),
    status: "failed",
  });

  const rendered = screenText(root);
  assert.match(rendered, /1 runs · last 24h/);
  assert.match(rendered, /1 to 1 of 1/);
  assert.match(rendered, /Failed/);
  assert.doesNotMatch(rendered, /Passed/);

  act(() => button(root, "SUCCESS").props.onClick());
  assert.deepEqual(pushes, ["/runs?status=success"]);
  assert.deepEqual(replacements, []);
});

test("desktop: Back restores the prior status after a URL rerender", (t) => {
  const data = makeData([
    makeRun({ id: "run_ok", status: "success" }),
    makeRun({ id: "run_bad", status: "failed" }),
  ]);
  const { root, pushes, backs, rerender, goBack } = renderDesktop(t, {
    data,
    status: "failed",
  });

  act(() => button(root, "SUCCESS").props.onClick());
  assert.deepEqual(pushes, ["/runs?status=success"]);
  rerender({ data, status: "success" });
  assert.equal(button(root, "SUCCESS").props["aria-pressed"], true);

  goBack({ data, status: "failed" });
  assert.deepEqual(backs, ["back"]);
  assert.equal(button(root, "FAILED").props["aria-pressed"], true);
  assert.equal(button(root, "SUCCESS").props["aria-pressed"], false);
});

test("desktop: the heading uses complete response counts when rows are capped", (t) => {
  const data = makeData([
    makeRun({ id: "run_ok", status: "success" }),
    makeRun({ id: "run_bad", status: "failed" }),
  ]);
  data.total = 700;
  data.counts.failed = 640;
  const { root, rerender } = renderDesktop(t, { data });

  assert.match(screenText(root), /700 runs · last 24h/);
  rerender({ data, status: "failed" });
  assert.match(screenText(root), /640 runs · last 24h/);
});

test("the actions column remains when no row can be cancelled", (t) => {
  const { root } = renderDesktop(t, {
    data: makeData([makeRun({ id: "run_1", status: "running" })]),
    canCancel: false,
  });
  assert.equal(
    root.findAll((node) => node.type === "th" && nodeText(node) === "Actions").length,
    1,
  );
});

test("failed usage distinguishes recorded zero from unknown", (t) => {
  const { root } = renderDesktop(t, {
    data: makeData([
      makeRun({ id: "run_zero", status: "failed", tokens: 0, cost: 0 }),
      makeRun({ id: "run_unknown", status: "failed", tokens: null, cost: null }),
    ]),
  });
  const rendered = screenText(root);
  assert.match(rendered, /0\.0k/);
  assert.match(rendered, /\$0\.00/);
});

test("Cancel is absent for a row that is not running", (t) => {
  const row = makeRun({ id: "run_1", status: "success" });
  const { root } = renderDesktop(t, {
    data: makeData([row]),
    canCancel: true,
  });
  assert.equal(buttons(root, "Cancel").length, 0);
});

test("manual refresh is available on the runs list", (t) => {
  const { root, refreshes } = renderDesktop(t, {
    data: makeData([makeRun({ id: "run_1", status: "success" })]),
  });
  act(() => {
    button(root, "Refresh").props.onClick();
  });
  assert.deepEqual(refreshes, ["refresh"]);
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
  act(() => {
    button(root, "Confirm").props.onClick();
  });
  await settle();

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
  act(() => {
    button(root, "Confirm").props.onClick();
  });
  await settle();

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
  act(() => {
    button(root, "Confirm").props.onClick();
  });
  await settle();

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
  act(() => {
    button(root, "Confirm").props.onClick();
  });
  await settle();

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

test("mobile: the status filter count and pager use the same row set", (t) => {
  const failed = Array.from({ length: 26 }, (_, index) =>
    makeRun({ id: `run_${index}`, status: "failed", ticketTitle: `Failure ${index}` }),
  );
  const { root } = renderMobile(t, { data: makeData(failed), status: "failed" });

  assert.match(screenText(root), /26 runs · last 24h/);
  assert.match(screenText(root), /1 to 25 of 26/);
});

test("mobile: Back restores the prior status after a URL rerender", (t) => {
  const data = makeData([
    makeRun({ id: "run_ok", status: "success" }),
    makeRun({ id: "run_bad", status: "failed" }),
  ]);
  const { root, pushes, replacements, backs, rerender, goBack } = renderMobile(t, {
    data,
    status: "failed",
  });

  act(() => button(root, "SUCCESS").props.onClick());
  assert.deepEqual(pushes, ["/runs?status=success"]);
  assert.deepEqual(replacements, []);
  rerender({ data, status: "success" });
  assert.equal(button(root, "SUCCESS").props["aria-pressed"], true);

  goBack({ data, status: "failed" });
  assert.deepEqual(backs, ["back"]);
  assert.equal(button(root, "FAILED").props["aria-pressed"], true);
  assert.equal(button(root, "SUCCESS").props["aria-pressed"], false);
});

test("mobile: the heading uses complete response counts when rows are capped", (t) => {
  const data = makeData([makeRun({ id: "run_bad", status: "failed" })]);
  data.total = 700;
  data.counts.failed = 640;
  const { root, rerender } = renderMobile(t, { data });

  assert.match(screenText(root), /700 runs · last 24h/);
  rerender({ data, status: "failed" });
  assert.match(screenText(root), /640 runs · last 24h/);
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
  act(() => {
    button(root, "Confirm").props.onClick();
  });
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/runs/run_7/cancel");
  assert.equal(calls[0].init?.method, "POST");
  // The mobile sheet swaps "Cancelling…" for the outcome through work it does
  // after the answer lands, so "nothing in flight" is true a moment too early.
  await waitForText(root, /Run cancelled\./);
  assert.deepEqual(refreshes, ["refresh"]);
});
