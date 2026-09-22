// apps/dashboard/lib/agent-visibility/replay-link.test.ts
//
// The URL is the link a person sends a colleague ("look at what pass 3 was
// given"). The mistakes: dropping the query the page already carried (the
// ticket page's `run`), letting a value out of a URL become a path or a
// script, and rewriting the URL when nothing moved, which on the App Router
// costs a render for every poll tick.
import assert from "node:assert/strict";
import test from "node:test";

import { currentReplayLink, readReplayLink, withReplayLink, writeReplayLink } from "./replay-link";

test("a link carries the block, the attempt, the tab, the send and the section", () => {
  // The send is a briefing id: a record this build cannot read has no sequence
  // number of its own, and inventing one collides with a real send.
  assert.deepEqual(readReplayLink("?node=planning&attempt=42&tab=briefing&send=brf_9&section=4"), {
    node: "planning",
    attempt: 42,
    tab: "briefing",
    send: "brf_9",
    section: "4",
  });
  assert.deepEqual(readReplayLink("?tab=briefing&section=map"), {
    node: null,
    attempt: null,
    tab: "briefing",
    send: null,
    section: "map",
  });
});

test("a value nobody would have written is read as absent", () => {
  const link = readReplayLink("?node=%3Cscript%3E&attempt=-1&send=%3Cscript%3E&section=../../etc&tab=");
  assert.deepEqual(link, { node: null, attempt: null, tab: null, send: null, section: null });
});

test("writing one field keeps every other parameter the page carried", () => {
  assert.equal(withReplayLink("?run=wrun_7&tab=input", { tab: "briefing" }), "?run=wrun_7&tab=briefing");
  assert.equal(withReplayLink("?run=wrun_7&send=brf_2", { send: null }), "?run=wrun_7");
  assert.equal(withReplayLink("", { node: "planning", attempt: 8 }), "?node=planning&attempt=8");
  // A field not named is left as it is, so changing the section keeps the send.
  assert.equal(withReplayLink("?send=brf_3&section=4", { section: "map" }), "?send=brf_3&section=map");
});

test("the URL is written in place, and not at all when nothing moved", () => {
  const calls: { state: unknown; url: string }[] = [];
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    location: { search: "?run=wrun_7&tab=briefing", pathname: "/runs/wrun_7", hash: "" },
    history: {
      replaceState: (state: unknown, _unused: string, url: string) => calls.push({ state, url }),
    },
  };
  try {
    writeReplayLink({ tab: "briefing" });
    assert.equal(calls.length, 0, "the same tab was written again");

    writeReplayLink({ send: "brf_3" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "/runs/wrun_7?run=wrun_7&tab=briefing&send=brf_3");
    // Null state: the App Router syncs the new URL from it. Its own state
    // object carries a marker that would make the router skip the sync.
    assert.equal(calls[0]!.state, null);
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});

test("a window that is not a browser's costs nothing", () => {
  // Screens render in places with no location: the server, and a test
  // renderer whose `window` is whatever that test needed. Reading the link
  // must not take the page down with it.
  const previous = (globalThis as { window?: unknown }).window;
  try {
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    assert.deepEqual(currentReplayLink(), { node: null, attempt: null, tab: null, send: null, section: null });
    assert.doesNotThrow(() => writeReplayLink({ tab: "briefing" }));

    // A location without a history to write to is just as harmless.
    (globalThis as { window?: unknown }).window = { location: { search: "?tab=input", pathname: "/", hash: "" } };
    assert.equal(currentReplayLink().tab, "input");
    assert.doesNotThrow(() => writeReplayLink({ tab: "briefing" }));
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});
