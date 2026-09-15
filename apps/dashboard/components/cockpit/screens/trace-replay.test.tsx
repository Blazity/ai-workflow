import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AGENT_WORKFLOW_ID, RUN_COMPLETION_GRACE_MS } from "@shared/contracts";
import type {
  RunDetailResponse,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import { replayForRunLifecycle, TraceDetail } from "./trace";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const detail: RunDetailResponse = {
  generatedAt: "2026-07-23T10:00:02.000Z",
  available: true,
  run: {
    id: "wrun_1",
    workflow: "ticket",
    workflowName: "Ticket workflow",
    status: "failed",
    ticket: "AIW-134",
    ticketTitle: "Replay a workflow",
    ticketUrl: "https://jira.example/browse/AIW-134",
    prNumber: null,
    prUrl: null,
    prs: null,
    model: "gpt-5.6",
    createdAt: "2026-07-23T10:00:00.000Z",
    startedAt: "2026-07-23T10:00:00.000Z",
    completedAt: "2026-07-23T10:00:02.000Z",
    durationSec: 2,
    usageRecorded: true,
    error: {
      code: "AIW-DIAG-123",
      message: "Workflow execution failed. Diagnostic ID: AIW-DIAG-123",
      stack: "SECRET_INTERNAL_STACK_FRAME",
    },
    deploymentId: "dpl_1",
  },
  steps: [
    {
      stepId: "step_1",
      name: "Review",
      rawName: "reviewStep",
      status: "failed",
      attempt: 1,
      createdAt: "2026-07-23T10:00:00.000Z",
      startedAt: "2026-07-23T10:00:00.000Z",
      completedAt: "2026-07-23T10:00:02.000Z",
      startOffsetMs: 0,
      durationMs: 2000,
      error: { message: "Review failed" },
    },
  ],
  analysisReport: null,
  clarification: null,
};

const router = {
  refresh: () => {},
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

test("historical runs fall back to the legacy trace without rendering stacks", () => {
  const replay: WorkflowRunReplayResponse = {
    availability: "not_captured",
    mayAdvance: false,
    snapshot: null,
    attempts: [],
    nextCursor: null,
  };
  const html = renderToStaticMarkup(
    <TraceDetail runId="wrun_1" data={detail} replay={replay} />,
  );

  assert.match(html, /Visual replay was not captured/);
  assert.match(html, /Step timeline · phases/);
  assert.match(html, /AIW-DIAG-123/);
  assert.doesNotMatch(html, /SECRET_INTERNAL_STACK_FRAME/);
});

test("expired observations explain the fallback explicitly", () => {
  const replay: WorkflowRunReplayResponse = {
    availability: "expired",
    mayAdvance: false,
    snapshot: null,
    attempts: [],
    nextCursor: null,
  };
  const html = renderToStaticMarkup(
    <TraceDetail runId="wrun_1" data={detail} replay={replay} />,
  );

  assert.match(html, /replay observation expired/);
  assert.match(html, /Showing the legacy step trace/);
});

test("an active run waits for replay capture instead of freezing on fallback", () => {
  const replay: WorkflowRunReplayResponse = {
    availability: "not_captured",
    mayAdvance: false,
    snapshot: null,
    attempts: [],
    nextCursor: null,
  };
  const runningDetail: RunDetailResponse = {
    ...detail,
    run: {
      ...detail.run!,
      status: "running",
      completedAt: null,
      durationSec: null,
    },
  };
  const html = renderToStaticMarkup(
    <TraceDetail
      runId="wrun_live"
      data={runningDetail}
      replay={replay}
    />,
  );

  assert.match(html, /Preparing replay/);
  assert.match(html, /Waiting for the sanitized workflow snapshot/);
  assert.doesNotMatch(html, /Visual replay was not captured/);
});

test("terminal run state stops a stale not-captured replay poll", () => {
  const replay: WorkflowRunReplayResponse = {
    availability: "not_captured",
    mayAdvance: true,
    snapshot: null,
    attempts: [],
    nextCursor: null,
  };
  const html = renderToStaticMarkup(
    <TraceDetail runId="wrun_terminal" data={detail} replay={replay} />,
  );

  assert.match(html, /Visual replay was not captured/);
  assert.doesNotMatch(html, /Preparing replay/);
});

test("terminal run state also stops stale polling for available replay", () => {
  const replay: WorkflowRunReplayResponse = {
    availability: "available",
    mayAdvance: true,
    snapshot: {
      runId: "wrun_terminal",
      definitionId: 1,
      definitionVersion: 1,
      definitionSchemaVersion: 2,
      captureStatus: "available",
      graph: { nodes: [], edges: [] },
      layout: { nodes: {}, edges: {} },
      runtimeManifest: {
        value: {},
        metadata: {
          redactions: {},
          truncated: false,
          originalBytes: 2,
          storedBytes: 2,
          unavailable: false,
          unavailableReason: null,
        },
      },
      capturedAt: "2026-07-23T10:00:00.000Z",
      expiresAt: "2026-08-22T10:00:00.000Z",
    },
    attempts: [],
    nextCursor: null,
  };

  assert.equal(replayForRunLifecycle(replay, false).mayAdvance, false);
});

test("a completed run renders an answered clarification as plain text", () => {
  const replay: WorkflowRunReplayResponse = {
    availability: "not_captured",
    mayAdvance: false,
    snapshot: null,
    attempts: [],
    nextCursor: null,
  };
  const answered: RunDetailResponse = {
    ...detail,
    run: { ...detail.run!, status: "success", error: null },
    clarification: {
      id: "clarification-1",
      ticketKey: "AIW-134",
      runId: "wrun_1",
      blockId: null,
      definitionId: null,
      definitionVersion: null,
      questions: ["Should `facts` be retained?"],
      suggestedAnswers: null,
      status: "answered",
      askedAt: "2026-07-23T10:00:00.000Z",
      answer: "Keep `facts`.",
      answeredById: "user-1",
      answeredByLabel: "Ada",
      answeredAt: "2026-07-23T10:00:01.000Z",
      dispatchedRunId: null,
    },
  };
  const html = renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <TraceDetail runId="wrun_1" data={answered} replay={replay} />
    </AppRouterContext.Provider>,
  );

  assert.match(html, />Answered</);
  assert.doesNotMatch(html, /Input needed/);
  assert.doesNotMatch(html, /<code[^>]*>facts<\/code>/);
  assert.match(html, /`facts`/);
});

const notCaptured: WorkflowRunReplayResponse = {
  availability: "not_captured",
  mayAdvance: false,
  snapshot: null,
  attempts: [],
  nextCursor: null,
};

/** A successful agent run missing its end-of-run write, finished `agoMs` ago. */
function pendingUsageDetail(agoMs: number): RunDetailResponse {
  return {
    ...detail,
    run: {
      ...detail.run!,
      workflow: AGENT_WORKFLOW_ID,
      status: "success",
      error: null,
      usageRecorded: false,
      completedAt: new Date(Date.now() - agoMs).toISOString(),
    },
  };
}

// A successful agent run gets its duration from the statement that flips its
// status, minutes before the write that records cost and pull requests. The
// header must not read as finished while that is still outstanding.
test("a successful agent run whose end-of-run write is still expected says pending beside Duration", () => {
  const html = renderToStaticMarkup(
    <TraceDetail runId="wrun_1" data={pendingUsageDetail(60_000)} replay={notCaptured} />,
  );

  assert.match(html, /completion data pending/);
});

// Same run, past the window runs.result publishes as pendingUntil: the write is
// not late any more, it is not coming, and the caption has to stop promising it.
test("a successful agent run past the grace says the completion data was not recorded", () => {
  const html = renderToStaticMarkup(
    <TraceDetail
      runId="wrun_1"
      data={pendingUsageDetail(RUN_COMPLETION_GRACE_MS + 60_000)}
      replay={notCaptured}
    />,
  );

  assert.match(html, /completion data not recorded/);
  assert.doesNotMatch(html, />completion data pending</);
});

test("a run whose end-of-run write has landed keeps the plain Duration caption", () => {
  const settled: RunDetailResponse = {
    ...detail,
    run: {
      ...detail.run!,
      workflow: AGENT_WORKFLOW_ID,
      status: "success",
      error: null,
      usageRecorded: true,
    },
  };

  const html = renderToStaticMarkup(
    <TraceDetail runId="wrun_1" data={settled} replay={notCaptured} />,
  );

  assert.doesNotMatch(html, /completion data/);
  assert.match(html, />elapsed</);
});
