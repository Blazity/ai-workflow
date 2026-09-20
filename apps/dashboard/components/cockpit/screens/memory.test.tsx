import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { MemoryDocumentDto, MemoryDocumentSummaryDto } from "@shared/contracts";
import { MemoryScreen, memoryDeleteUrl } from "./memory";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// next/link schedules its prefetch through an idle callback that reads `self`,
// which node does not define. Without it every render of a row link throws.
(globalThis as { self?: unknown }).self = globalThis;

const SUBJECT_KEY = "ticket:jira:AIW-177";
const DOC_PATH = "blazebot/memory/AIW-177.md";

const DOCUMENTS: MemoryDocumentSummaryDto[] = [
  {
    subjectKey: SUBJECT_KEY,
    docPath: DOC_PATH,
    ticketKey: "AIW-177",
    bytes: 12,
    sourceRunId: "run_1",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
  },
  {
    subjectKey: "pr:github:acme/web#12",
    docPath: "blazebot/memory/pr-12.md",
    ticketKey: null,
    bytes: 8,
    sourceRunId: "run_2",
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
  },
];

const SELECTED: MemoryDocumentDto = {
  subjectKey: SUBJECT_KEY,
  docPath: DOC_PATH,
  bytes: 12,
  sourceRunId: "run_1",
  updatedAt: "2026-07-20T10:00:00.000Z",
  content: "the agent remembered something false",
};

/** The second row, for asserting that an armed confirmation belongs to the one
 *  document it was armed on. */
const OTHER_SELECTION = {
  subjectKey: DOCUMENTS[1].subjectKey,
  docPath: DOCUMENTS[1].docPath,
};

const OTHER_SELECTED: MemoryDocumentDto = {
  ...OTHER_SELECTION,
  bytes: 8,
  sourceRunId: "run_2",
  updatedAt: "2026-07-19T10:00:00.000Z",
  content: "an unrelated pull request note",
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

function buttons(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root
    .findAll((node) => node.type === "button")
    .filter((node) => nodeText(node).includes(text));
}

function button(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = buttons(root, text);
  assert.equal(matches.length, 1, `expected exactly one button containing ${text}`);
  return matches[0];
}

function rowPaths(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => node.type === "a")
    .map((node) => String(node.props.href ?? ""))
    .filter((href) => href.startsWith("/memory?subject="));
}

function screenText(root: ReactTestInstance): string {
  return nodeText(root);
}

type FetchCall = { url: string; init: RequestInit | undefined };
type ScreenProps = Partial<React.ComponentProps<typeof MemoryScreen>>;

/** What `settle` watches: the requests this screen has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One render per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/**
 * Installs the stubbed fetch for one test and returns the undo.
 *
 * Every answer lands a turn later, the way a response does: resolving in the
 * caller's own microtask is what let a counted wait look reliable.
 * `FIXTURE_SLOW_MS` delays every answer by that many milliseconds, which is how
 * this harness reproduces a runner slow enough to break a counted wait.
 */
function installFetch(calls: FetchCall[], respond: () => Response): () => void {
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
    // `respond` runs now, when the request goes out, so a test that holds its
    // own answer open still takes the resolver from this very call.
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
 * Lets the requests this screen has out finish, and waits for exactly that.
 *
 * NEVER A COUNT OF TURNS. A delete here is a request whose body lands a turn or
 * more after the call, and the screen only then says what became of the
 * document. How many turns that costs is the runner's business, so a fixed
 * count passes on an idle machine and, on a loaded one, returns while the
 * request is still in flight: the assertion then reads a screen that has not
 * heard back and the failure looks like the product. Quiet is the condition
 * those assertions mean, and it is two things, because a request that lands can
 * start the next one: nothing in flight, and a turn that started nothing new.
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

/** Minimal app router: the screen only calls refresh, and next/link needs the
 *  context to exist at all. */
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

/** Renders the screen with a stubbed global fetch so the delete request is
 *  observable without a browser. Unmounting after the test lets next/link
 *  cancel its deferred prefetch instead of updating a finished test. */
function renderScreen(
  t: TestContext,
  props: ScreenProps,
  respond: () => Response = () => Response.json({ deleted: true }, { status: 200 }),
): {
  root: ReactTestInstance;
  calls: FetchCall[];
  refreshes: string[];
  rerender: (next: ScreenProps) => void;
} {
  const calls: FetchCall[] = [];
  const refreshes: string[] = [];
  const uninstallFetch = installFetch(calls, respond);

  const tree = (extra: ScreenProps) => (
    <AppRouterContext.Provider value={stubRouter(refreshes) as never}>
      <MemoryScreen
        documents={DOCUMENTS}
        selection={{ subjectKey: SUBJECT_KEY, docPath: DOC_PATH }}
        selected={SELECTED}
        {...props}
        {...extra}
      />
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
    rerender: (next) => {
      act(() => renderer.update(tree(next)));
    },
  };
}

test("the delete endpoint encodes both halves of the document key", () => {
  assert.equal(
    memoryDeleteUrl({ subjectKey: "a&b=c", docPath: "x/y.md" }),
    "/api/memory?subjectKey=a%26b%3Dc&docPath=x%2Fy.md",
  );
});

test("a member never sees the delete action", (t) => {
  const { root } = renderScreen(t, { canDelete: false });
  assert.equal(buttons(root, "Delete").length, 0);
  assert.doesNotMatch(screenText(root), /Review what the agent remembered/);
});

test("delete is omitted by default when the caller passes no capability", (t) => {
  const { root } = renderScreen(t, {});
  assert.equal(buttons(root, "Delete").length, 0);
});

test("memory timestamps use the baseline abbreviated date-time format", (t) => {
  const { root } = renderScreen(t, {});
  const expected = new Date(DOCUMENTS[0].updatedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  assert.ok(screenText(root).includes(expected));
  assert.doesNotMatch(screenText(root), /2026/);
});

test("delete is offered only on an open document", (t) => {
  const { root } = renderScreen(t, { canDelete: true, selection: null, selected: null });
  assert.equal(buttons(root, "Delete").length, 0);
});

test("delete asks for confirmation before calling the worker", (t) => {
  const { root, calls } = renderScreen(t, { canDelete: true });

  act(() => {
    button(root, "Delete").props.onClick();
  });

  const text = screenText(root);
  assert.match(text, /Delete from the store\?/);
  // The prompt must not promise permanence it cannot keep.
  assert.doesNotMatch(text, /permanent/i);
  assert.match(text, /A later run can learn this again/);
  assert.equal(buttons(root, "Confirm delete").length, 1);
  assert.equal(calls.length, 0, "confirmation alone must not delete anything");
});

test("an armed confirmation does not carry over to another document", (t) => {
  const { root, calls, rerender } = renderScreen(t, { canDelete: true });

  act(() => {
    button(root, "Delete").props.onClick();
  });
  assert.equal(buttons(root, "Confirm delete").length, 1);

  // Opening a different document is a re-render, not a remount, so a click
  // armed for the first document must not stay armed over the second one.
  rerender({ selection: OTHER_SELECTION, selected: OTHER_SELECTED });

  const text = screenText(root);
  assert.equal(buttons(root, "Confirm delete").length, 0);
  assert.doesNotMatch(text, /Delete from the store\?/);
  assert.equal(buttons(root, "Delete").length, 1, "the unarmed delete action stays available");
  assert.match(text, /an unrelated pull request note/);
  assert.equal(calls.length, 0);
});

test("confirming deletes through the proxy route and drops the row from the listing", async (t) => {
  const { root, calls, refreshes } = renderScreen(t, { canDelete: true });
  assert.equal(rowPaths(root).length, 2);

  act(() => {
    button(root, "Delete").props.onClick();
  });
  act(() => {
    button(root, "Confirm delete").props.onClick();
  });
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "/api/memory?subjectKey=ticket%3Ajira%3AAIW-177&docPath=blazebot%2Fmemory%2FAIW-177.md",
  );
  assert.equal(calls[0].init?.method, "DELETE");
  // The optimistic filter must not be the only mechanism: the server-rendered
  // listing has to be told to catch up.
  assert.deepEqual(refreshes, ["refresh"]);

  const text = screenText(root);
  assert.match(text, /Deleted from the store\. A later run can learn this again\./);
  assert.doesNotMatch(text, /the agent remembered something false/);
  assert.equal(rowPaths(root).length, 1);
  assert.match(text, /1 document/);
});

test("a fresh server render supersedes the local post-delete state", async (t) => {
  const { root, rerender } = renderScreen(t, { canDelete: true });

  act(() => {
    button(root, "Delete").props.onClick();
  });
  act(() => {
    button(root, "Confirm delete").props.onClick();
  });
  await settle();
  assert.match(screenText(root), /Deleted from the store/);

  // What router.refresh() eventually delivers: the row is gone server-side and
  // the key no longer resolves.
  rerender({ documents: [DOCUMENTS[1]], selected: null });

  const text = screenText(root);
  assert.doesNotMatch(text, /Deleted from the store/);
  assert.match(text, /This document is no longer stored/);
  assert.equal(rowPaths(root).length, 1);
});

test("a rejected delete keeps the document and shows the worker message", async (t) => {
  const { root, refreshes } = renderScreen(t, { canDelete: true }, () =>
    Response.json({ statusMessage: "Forbidden" }, { status: 403 }),
  );

  act(() => {
    button(root, "Delete").props.onClick();
  });
  act(() => {
    button(root, "Confirm delete").props.onClick();
  });
  await settle();

  const text = screenText(root);
  assert.match(text, /Forbidden/);
  assert.match(text, /the agent remembered something false/);
  assert.equal(rowPaths(root).length, 2);
  assert.deepEqual(refreshes, [], "a failed delete has nothing for the server to catch up on");
});

test("cancelling the confirmation deletes nothing", (t) => {
  const { root, calls } = renderScreen(t, { canDelete: true });

  act(() => {
    button(root, "Delete").props.onClick();
  });
  act(() => {
    button(root, "Cancel").props.onClick();
  });

  assert.equal(calls.length, 0);
  assert.equal(buttons(root, "Confirm delete").length, 0);
  assert.equal(rowPaths(root).length, 2);
});
