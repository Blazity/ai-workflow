// apps/dashboard/components/cockpit/flow-editor/last-briefing-view.test.tsx
//
// One mistake would undo this whole view: telling an operator that a block has
// never sent anything when the truth is that the read failed, or that the
// worker is older than this dashboard. "Nothing was sent" is a fact about the
// workflow; "we could not ask" is a fact about us, and an operator who cannot
// tell them apart goes and debugs the wrong thing.
//
// The others: losing the run and the version a briefing came from, so a prompt
// from an older workflow reads as the one on the canvas, and rendering sends
// here in some way of its own instead of the run replay's.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import {
  FIXTURE_DEFINITION,
  STATES_RUN,
  buildFixtureStore,
  serveFixture,
  type FixtureStore,
} from "@/lib/agent-visibility/test-support/fixtures";

import { PagedCacheProvider } from "../agent-visibility/paged";
import { LastBriefingView } from "./last-briefing-view";

// The primitives are transpiled to `React.createElement` here, with no import
// of their own; the runner has no bundler to provide it.
(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

let store: FixtureStore;
test.before(async () => {
  store = await buildFixtureStore();
});

function render(
  t: TestContext,
  nodeId: string,
  options: { fail?: { pattern: RegExp; status: number } } = {},
): { root: ReactTestInstance; requests: string[] } {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string) => {
    const path = String(input);
    requests.push(path);
    if (options.fail?.pattern.test(path)) {
      return Promise.resolve(Response.json({ error: "on purpose" }, { status: options.fail.status }));
    }
    const asked = new URL(path, "http://dashboard.test");
    // The proxy forwards `/api/...` to the worker's `/api/v1/...`.
    const served = serveFixture(
      store,
      "GET",
      new URL(`/api/v1${asked.pathname.slice("/api".length)}${asked.search}`, "http://worker.test"),
    );
    if (!served) return Promise.resolve(Response.json({ error: "not served" }, { status: 404 }));
    return Promise.resolve(Response.json(served.body, { status: served.status }));
  }) as typeof globalThis.fetch;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <PagedCacheProvider>
        <LastBriefingView definitionId={FIXTURE_DEFINITION} nodeId={nodeId} />
      </PagedCacheProvider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  });
  return { root: renderer.root, requests };
}

async function settle(times = 8) {
  for (let turn = 0; turn < times; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((entry): entry is string => typeof entry === "string"))
    .join(" ")
    .replace(/\s+/g, " ");
}

test("a block that ran names the run and the workflow version, and shows its sends", async (t) => {
  const { root } = render(t, "research");
  await settle();
  const shown = text(root);
  assert.match(shown, new RegExp(`run ${STATES_RUN}`));
  // The run executed version 9; an operator editing the canvas needs to know
  // the prompt below is not necessarily the one in front of them.
  assert.match(shown, /workflow version 9/);
  // And exactly once: the same number twice, two lines apart, is noise.
  assert.equal(shown.match(/workflow version 9/g)?.length, 1);
  assert.match(shown, /Sends of this attempt, in order/);
  // The run replay's own renderer, so the send picker is the same one.
  assert.ok(root.findAll((node) => node.type === "button" && text(node).includes("Model call")).length > 0);
});

test("a block nobody has run says so, and offers what to do about it", async (t) => {
  const { root } = render(t, "cleanup");
  await settle();
  const shown = text(root);
  assert.match(shown, /has not run yet/);
  assert.match(shown, /Dispatch the workflow/);
  assert.doesNotMatch(shown, /Sends of this attempt/);
});

test("a read that failed is never told as a block that has sent nothing", async (t) => {
  // A worker older than this dashboard answers 404 for a route it does not
  // serve. That is us being unable to ask, not the workflow having sent
  // nothing, and the two must never share a sentence.
  const { root } = render(t, "research", { fail: { pattern: /last-briefing/, status: 404 } });
  await settle();
  const shown = text(root);
  assert.doesNotMatch(shown, /has not run yet/);
  assert.match(shown, /could not be loaded/);
});

test("the editor asks the block's own route, and asks it once", async (t) => {
  const { requests } = render(t, "research");
  await settle();
  const asked = requests.filter((path) => path.includes("last-briefing"));
  assert.equal(asked.length, 1);
  assert.equal(
    asked[0],
    `/api/workflow-definitions/${FIXTURE_DEFINITION}/nodes/research/last-briefing`,
  );
});

test("the workflow version that ran is a sentence, not a number to compare", async (t) => {
  const { root } = render(t, "research");
  await settle();
  const shown = text(root);
  // An operator reading a prompt on a canvas must not have to work out that
  // version 9 is not the version in front of them.
  assert.match(shown, /This went out from workflow version 9/);
  assert.match(shown, /not what the canvas in front of you would send/);
});

test("a run that refused to record some of its sends says so without anything being opened", async (t) => {
  const { root } = render(t, "research");
  await settle();
  const shown = text(root);
  // The fixture run made seven sends and kept three.
  assert.match(shown, /7 sends/);
  assert.match(shown, /2 refused/);
  assert.match(shown, /Not every send of this run was recorded/);
});

test("opening the run does not take an unsaved workflow with it", async (t) => {
  // The editor guards a dirty draft with a browser prompt on unload. A link
  // that navigated away would put that prompt between an operator and their
  // own work, for what is only a reference.
  const { root } = render(t, "research");
  await settle();
  const link = root.findAll((node) => node.type === "a").find((node) => text(node).includes("Open this run"));
  assert.ok(link, "no link to the run");
  assert.equal(link.props.target, "_blank");
  assert.match(
    String(link.props.href),
    new RegExp(`^/trace/${STATES_RUN}\\?node=research&tab=briefing$`),
  );
});
