// apps/dashboard/app/(cockpit)/ticket/[ticketKey]/page.test.tsx
//
// What this guards is a cost nobody sees on the screen: a second copy of the
// trace, mounted behind `display: none` for the width a person is not using.
// It fetches, polls and keeps its own caches all the same, so a phone pays for
// a desktop tree it can never look at and the worker serves everything twice.
// The page is allowed to render the trace exactly once.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React from "react";

// The page is transpiled to `React.createElement` here, with no import of its
// own; the runner has no bundler to provide one.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

/** Stand-ins for the three server components the page places, so the tree can
 *  be counted by identity without reaching the worker (their real module is
 *  server-only and fetches on import of its transport). */
function FakeShell() {
  return null;
}
function FakeMobileList() {
  return null;
}
function FakeDetail() {
  return null;
}

mock.module("../../../ticket-data.tsx", {
  exports: {
    TicketShellData: FakeShell,
    TicketMobileListData: FakeMobileList,
    RunDetailData: FakeDetail,
  },
} as unknown as Parameters<typeof mock.module>[1]);

// Loaded after the mock, so the page places the stand-ins above.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TicketPage = (require("./page") as typeof import("./page")).default;

/** How many times `type` is placed in the tree, counting every branch that
 *  renders, which is what a mount costs. */
function placed(node: unknown, type: unknown): number {
  if (Array.isArray(node)) return node.reduce((total: number, child) => total + placed(child, type), 0);
  if (!React.isValidElement(node)) return 0;
  const here = node.type === type ? 1 : 0;
  return here + placed((node.props as { children?: unknown }).children, type);
}

async function page(run?: string) {
  return TicketPage({
    params: Promise.resolve({ ticketKey: "AWP-235" }),
    searchParams: Promise.resolve(run === undefined ? {} : { run }),
  });
}

test("a run named in the URL is traced once, not once per layout", async () => {
  const tree = await page("wrun_fx_planning");
  // The one that matters: two copies is what a phone used to download and
  // poll while CSS hid one of them.
  assert.equal(placed(tree, FakeDetail), 1, "the trace is placed more than once");
  assert.equal(placed(tree, FakeShell), 1, "the rail and header are placed more than once");
  // The phone shows this run, not the runs list.
  assert.equal(placed(tree, FakeMobileList), 0);
});

test("with no run named, each width gets the one thing it shows", async () => {
  const tree = await page();
  // Here the two widths show different things rather than the same thing
  // twice: the desktop opens the newest run beside the rail, a phone shows
  // the list and no trace.
  assert.equal(placed(tree, FakeDetail), 1);
  assert.equal(placed(tree, FakeShell), 1);
  assert.equal(placed(tree, FakeMobileList), 1);
});
