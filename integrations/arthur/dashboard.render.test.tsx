// The Evals page, rendered once for each answer a reader has to tell apart.
//
// "Nothing graded", "our worker could not answer", "the engine could not be
// read" and "here are real failures" send a person to four different places,
// so each is asserted on the words it puts on screen and on the words it must
// not borrow from its neighbours.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { IntegrationPageProps } from "@integrations/host-ui";
import { dashboard } from "./dashboard";

// tsx compiles each file with the tsconfig of the directory it runs in, and
// this package's does not include `@integrations/host-ui`, so the primitives
// come out as classic `React.createElement` calls. The dashboard's own build
// compiles them properly; a test only has to make `React` findable.
(globalThis as { React?: typeof React }).React = React;

const Evals = dashboard.pages.evals as (props: IntegrationPageProps) => React.ReactElement;

function screen(data: IntegrationPageProps["data"]): string {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Evals integrationId="arthur" data={data} />);
  });
  const root: ReactTestInstance = renderer.root;
  return root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join("");
}

const graded = {
  windowHours: 24,
  spansGraded: 20,
  spansFailed: 2,
  traceCount: 25,
  score: 90,
  tasksRead: 12,
  truncated: false,
};

test("our worker not answering is ours, and says nothing about the engine", () => {
  const text = screen({ status: "unavailable", cause: "worker", reason: "timeout" });
  assert.match(text, /Our worker could not answer/);
  assert.doesNotMatch(text, /could not be read/);
  assert.doesNotMatch(text, /Nothing was graded/);
});

test("an engine that could not be read is the engine, with its reason", () => {
  const text = screen({ status: "unavailable", cause: "provider", reason: "503 from the engine" });
  assert.match(text, /was asked and could not be read/);
  assert.match(text, /503 from the engine/);
  assert.doesNotMatch(text, /Our worker/);
});

test("an engine that graded nothing says so, and is not an outage", () => {
  const text = screen({ status: "ok", value: { ...graded, spansGraded: 0, spansFailed: 0, score: 0 } });
  assert.match(text, /Nothing was graded in the last 24 hours/);
  assert.doesNotMatch(text, /could not be read|did not answer/);
});

// Red when: the sentence renders in pieces and a reader sees "received1
// trace" (QA, production).
test("the count of traces reads as one sentence, singular for one", () => {
  const text = screen({
    status: "ok",
    value: { ...graded, traceCount: 1, spansGraded: 0, spansFailed: 0, score: 0 },
  });
  assert.match(text, /The engine received 1 trace; grading it is configured on the engine, not here\./);
});

test("real failures show as failures next to the pass rate", () => {
  const text = screen({ status: "ok", value: graded });
  assert.match(text, /90\.0%/);
  assert.match(text, /2 failed/);
  assert.doesNotMatch(text, /Nothing was graded/);
});

test("a first page that was full is shown as a lower bound, never as a quiet engine", () => {
  const text = screen({
    status: "ok",
    value: { ...graded, spansGraded: 0, spansFailed: 0, score: 0, tasksRead: 1000, truncated: true },
  });
  assert.match(text, /more tasks than it returns in one read/);
  assert.match(text, /1,000 were read/);
});

test("a worker one deploy behind still renders, without the fields it does not send", () => {
  const text = screen({
    status: "ok",
    value: { windowHours: 24, spansGraded: 5, traceCount: 9, score: 80 },
  });
  assert.match(text, /80\.0%/);
  assert.doesNotMatch(text, /failed/);
});
