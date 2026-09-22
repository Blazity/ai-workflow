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
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  };

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
  await act(async () => {
    button(root, "Confirm delete").props.onClick();
  });

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
  await act(async () => {
    button(root, "Confirm delete").props.onClick();
  });
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
  await act(async () => {
    button(root, "Confirm delete").props.onClick();
  });

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

test("a provider that could not be read never reads as an empty store", (t) => {
  // The one wrong answer this screen can give. Somebody opening it after a
  // provider went away must not be told the agent has forgotten everything:
  // they would go looking for a deletion nobody made.
  const { root } = renderScreen(t, {
    documents: [],
    selection: null,
    selected: null,
    unavailable: "Recall Engine could not answer: socket hang up",
  });

  const text = screenText(root);
  assert.match(text, /Recall Engine could not answer: socket hang up/);
  assert.match(text, /Memory could not be read/);
  assert.doesNotMatch(text, /Nothing remembered yet/);
});

test("an incomplete listing says so, so absence is not read as proof", (t) => {
  // A hosted engine pages and caps what it enumerates, so a document missing
  // from this table may still be stored. Somebody erasing on request has to
  // know that before they report the erasure done.
  const { root } = renderScreen(t, {
    selection: null,
    selected: null,
    complete: false,
  });

  assert.match(screenText(root), /cannot promise this is everything it\s+holds/);
});

test("a document the provider could not answer for is never reported as gone", (t) => {
  // The listing succeeded and one read did not, which is the only way to reach
  // this card with nothing to show. Reading "no longer stored" here sends
  // somebody looking for the deletion that took it, and there was none.
  const { root } = renderScreen(t, {
    selected: null,
    selectedUnavailable: "Built-in memory could not answer: socket hang up",
  });

  const text = screenText(root);
  assert.doesNotMatch(text, /This document is no longer stored/);
  assert.match(text, /could not be read/);
  assert.match(text, /nothing was deleted/);
  assert.match(text, /Built-in memory could not answer: socket hang up/);
});

test("a document that really is gone still says so", (t) => {
  // The other half of the pair: the 404 the worker answers for a pair that
  // names nothing has to keep its own sentence, or the fix above has only
  // traded one wrong answer for another.
  const { root } = renderScreen(t, { selected: null });

  const text = screenText(root);
  assert.match(text, /This document is no longer stored/);
  assert.doesNotMatch(text, /could not be read/);
});

test("a complete listing with nothing in it is still the empty state", (t) => {
  const { root } = renderScreen(t, {
    documents: [],
    selection: null,
    selected: null,
  });

  const text = screenText(root);
  assert.match(text, /Nothing remembered yet/);
  assert.doesNotMatch(text, /cannot promise this is everything/);
});

test("a document the provider could not answer for can still be erased, and a refusal says why", async (t) => {
  // Somebody opens this page to erase a document, not to read it. Taking the
  // action away because the preview is missing leaves them with no button and
  // no sentence, which reads as "you are not allowed to". The route refuses
  // honestly, so the button may stay and the refusal has to land on screen.
  const { root } = renderScreen(
    t,
    {
      canDelete: true,
      selected: null,
      selectedUnavailable: "Built-in memory could not answer: socket hang up",
    },
    () => Response.json({ statusMessage: "Acme Memory is away" }, { status: 503 }),
  );

  act(() => {
    button(root, "Delete").props.onClick();
  });
  await act(async () => {
    button(root, "Confirm delete").props.onClick();
  });

  const text = screenText(root);
  assert.match(text, /Acme Memory is away/);
  assert.doesNotMatch(text, /Deleted from the store/);
});
