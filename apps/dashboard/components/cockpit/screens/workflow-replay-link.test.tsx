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

function render(t: TestContext, search: string): { root: ReactTestInstance; requests: string[]; urls: string[] } {
  const requests: string[] = [];
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string) => {
    const path = String(input);
    requests.push(path);
    const answer = served(path);
    return Promise.resolve(Response.json(answer.body, { status: answer.status }));
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

async function settle(times = 10) {
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

test("a link to a send and a section lands on that send and that section", async (t) => {
  // attempt 2 is the planning attempt, `brf_plan_3` its second pass, and
  // section 1 that send's AGENTS.md.
  const harness = render(t, "?run=wrun_fx_planning&node=planning&attempt=2&tab=briefing&send=brf_plan_3&section=1");
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
  const harness = render(t, "?run=wrun_fx_planning&node=planning&attempt=2&tab=briefing&send=brf_plan_3&section=1");
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
