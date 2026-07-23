import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
    model: "gpt-5.6",
    createdAt: "2026-07-23T10:00:00.000Z",
    startedAt: "2026-07-23T10:00:00.000Z",
    completedAt: "2026-07-23T10:00:02.000Z",
    durationSec: 2,
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
  clarification: null,
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
