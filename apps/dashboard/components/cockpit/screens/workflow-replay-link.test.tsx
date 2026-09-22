// apps/dashboard/components/cockpit/screens/workflow-replay-link.test.tsx
//
// A link to a briefing is the point of the feature: "look at what pass 2 was
// given, section 2". The replay finds the attempt a link names only after its
// page of attempts has loaded, and that arrival used to be read as a person
// moving to another attempt, which threw the send and the section away and
// rewrote the URL. These are the two halves of that: the link survives its own
// landing, and moving to another attempt still clears it.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { WorkflowRunReplayResponse } from "@shared/contracts";

import {
  PLANNING_RUN,
  buildFixtureStore,
  serveFixture,
  type FixtureStore,
} from "@/lib/agent-visibility/test-support/fixtures";

import { WorkflowReplay } from "./workflow-replay";

// The primitives are transpiled to `React.createElement` here, with no import
// of their own; the runner has no bundler to provide it.
(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

let store: FixtureStore;
test.before(async () => {
  store = await buildFixtureStore();
});

function served(path: string): { status: number; body: unknown } {
  const asked = new URL(path, "http://dashboard.test");
  const answer = serveFixture(
    store,
    "GET",
    new URL(`/api/v1${asked.pathname.slice("/api".length)}${asked.search}`, "http://worker.test"),
  );
  return answer ?? { status: 404, body: { error: "not served" } };
}

/** What `settle` watches: the reads this screen has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One render per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

function render(t: TestContext, search: string): { root: ReactTestInstance; requests: string[]; urls: string[] } {
  const requests: string[] = [];
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  globalThis.fetch = ((input: string) => {
    const path = String(input);
    requests.push(path);
    mine.inFlight += 1;
    mine.started += 1;
    // Every answer lands a turn later, the way a response does: resolving in
    // the caller's own microtask is what let a counted wait look reliable.
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      const body = served(path);
      return Response.json(body.body, { status: body.status });
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  }) as typeof globalThis.fetch;

  const previousWindow = (globalThis as { window?: unknown }).window;
  const location = { search, pathname: `/ticket/AWP-235`, hash: "" };
  (globalThis as { window?: unknown }).window = {
    location,
    history: {
      replaceState: (_state: unknown, _unused: string, url: string) => {
        urls.push(url);
        location.search = url.slice(url.indexOf("?"));
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const initial = served(`/api/runs/${PLANNING_RUN}/replay`).body as WorkflowRunReplayResponse;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<WorkflowReplay runId={PLANNING_RUN} initialResponse={initial} />);
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  return { root: renderer.root, requests, urls };
}

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the chain of loads the replay starts finish, and waits for exactly
 * that.
 *
 * NEVER A COUNT OF TURNS. The replay loads in a chain (attempts, then the
 * attempt the link names, then that send's section), each hop a fetch whose
 * body lands a turn or more after the call. How many turns that costs is the
 * runner's business, so a fixed count passes on an idle machine and, on a
 * loaded one, returns while the attempts page is still in flight: the
 * assertion then reads a screen that never got as far as the link and the
 * failure looks like the product. Quiet is the condition those assertions
 * mean, and it is two things, because a read that lands starts the next one:
 * nothing in flight, and a turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of
 * failing. `FIXTURE_SLOW_MS` delays every fixture answer by that many
 * milliseconds, which is how this harness reproduces a runner slow enough to
 * break a counted wait.
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
      assert.fail(`the replay was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`);
    }
  }
}

function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((entry): entry is string => typeof entry === "string"))
    .join(" ")
    .replace(/\s+/g, " ");
}

test("a link to a send and a section lands on that send and that section", async (t) => {
  // attempt 3 is the planning attempt (the fixture run numbers its attempts in
  // the order it lists them), `brf_plan_3` its second pass, and
  // section 1 that send's AGENTS.md.
  const harness = render(t, "?run=wrun_fx_planning&node=planning&attempt=3&tab=briefing&send=brf_plan_3&section=1");
  await settle();

  assert.ok(
    harness.requests.some((path) => path.includes("briefings/brf_plan_3/sections/1?offset=0")),
    `the section the link named was never read: ${harness.requests.filter((p) => p.includes("sections")).join(", ")}`,
  );
  assert.equal(
    harness.urls.some((url) => !url.includes("send=brf_plan_3")),
    false,
    `the link was rewritten: ${harness.urls.join(" | ")}`,
  );
  const pressed = harness.root
    .findAll((node) => node.props["aria-pressed"] === true)
    .map((node) => text(node));
  assert.ok(
    pressed.some((label) => label.includes("Agent pass: expansion round 1")),
    `the send the link named is not the open one: ${pressed.join(" | ")}`,
  );
});

test("moving to another attempt clears the send and the section from the link", async (t) => {
  const harness = render(t, "?run=wrun_fx_planning&node=planning&attempt=3&tab=briefing&send=brf_plan_3&section=1");
  await settle();

  const implementation = harness.root
    .findAll((node) => node.type === "button")
    .find((node) => String(node.props["aria-label"] ?? "").startsWith("Implement"));
  assert.ok(implementation, "the other block has no button to click");
  await act(async () => {
    implementation.props.onClick();
  });
  await settle();

  const last = harness.urls.at(-1) ?? "";
  assert.doesNotMatch(last, /send=/);
  assert.doesNotMatch(last, /section=/);
  assert.match(last, /node=implementation/);
});
