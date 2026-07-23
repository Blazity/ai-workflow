import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  WorkflowReplayAttemptSummary,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import {
  WorkflowReplay,
  compareReplayAttemptActivity,
  countReplayRetries,
  initialReplayNodeId,
  isLiveReplayAttempt,
  latestReplayAttempts,
  loadReplayAttemptSummaryTail,
  mergeReplayAttempts,
  replaySelectionForRun,
  selectReplayAttempt,
  shouldPollReplay,
} from "./workflow-replay";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const attempts: WorkflowReplayAttemptSummary[] = [
  {
    id: 1,
    nodeId: "trigger",
    attempt: 1,
    activationScopeId: "scope-root",
    state: "completed",
    outcome: { kind: "completed", status: "ok" },
    selectedTransition: { port: "out", edgeIds: ["edge-start"] },
    startedAt: "2026-07-23T10:00:00.000Z",
    completedAt: "2026-07-23T10:00:00.010Z",
    durationMs: 10,
    diagnosticId: null,
  },
  {
    id: 2,
    nodeId: "review",
    attempt: 1,
    activationScopeId: "scope-root",
    state: "failed",
    outcome: { kind: "failed", status: "execution_failure" },
    selectedTransition: null,
    startedAt: "2026-07-23T10:00:00.011Z",
    completedAt: "2026-07-23T10:00:02.011Z",
    durationMs: 2000,
    diagnosticId: "diag-1",
  },
];

const response: WorkflowRunReplayResponse = {
  availability: "available",
  mayAdvance: false,
  snapshot: {
    runId: "wrun_1",
    definitionId: 10,
    definitionVersion: 4,
    definitionSchemaVersion: 2,
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger_ticket_ai",
          name: "Ticket received",
          x: 0,
          y: 40,
        },
        {
          id: "review",
          type: "review_agent",
          name: "Review changes",
          x: 260,
          y: 40,
        },
      ],
      edges: [
        {
          id: "edge-start",
          from: "trigger",
          to: "review",
          fromPort: "out",
        },
      ],
    },
    layout: { nodes: {}, edges: {} },
    runtimeManifest: {
      value: { profile: "review-v2" },
      metadata: {
        redactions: {},
        truncated: false,
        originalBytes: 23,
        storedBytes: 23,
        unavailable: false,
        unavailableReason: null,
      },
    },
    captureStatus: "available",
    capturedAt: "2026-07-23T10:00:00.000Z",
    expiresAt: "2026-08-22T10:00:00.000Z",
  },
  attempts,
  nextCursor: null,
};

test("visual replay renders graph state, selected path, and read-only inspector", () => {
  const html = renderToStaticMarkup(
    <WorkflowReplay runId="wrun_1" initialResponse={response} />,
  );

  assert.match(html, /Visual replay · read-only/);
  assert.match(html, /aria-label="Workflow run replay"/);
  assert.match(html, /Ticket received: Completed/);
  assert.match(html, /Review changes: Failed/);
  assert.match(html, /stroke="#3C43E7"/);
  assert.match(html, /Input/);
  assert.match(html, /Output/);
  assert.match(html, /Logs/);
  assert.match(html, /Metadata/);
  assert.match(html, /Attempts \(1\)/);
  assert.doesNotMatch(html, /Rerun|Run step|Replay side effects/);
});

test("visual replay preserves persisted stable-edge geometry", () => {
  const withAuthoredBend: WorkflowRunReplayResponse = {
    ...response,
    snapshot: {
      ...response.snapshot!,
      layout: {
        ...response.snapshot!.layout,
        edges: {
          "edge-start": { bend: { x: 220, y: 160 } },
        },
      },
    },
  };
  const html = renderToStaticMarkup(
    <WorkflowReplay runId="wrun_1" initialResponse={withAuthoredBend} />,
  );

  assert.match(
    html,
    /M 240 132 C 260 132, 256 216, 276 216 C 296 216, 296 132, 316 132/,
  );
});

test("retry count is per node and activation scope rather than triangular", () => {
  const repeated = [
    attempts[0],
    ...[1, 2, 3].map(
      (attempt): WorkflowReplayAttemptSummary => ({
        ...attempts[1],
        id: 10 + attempt,
        attempt,
        activationScopeId: "scope-a",
      }),
    ),
    {
      ...attempts[1],
      id: 20,
      attempt: 4,
      activationScopeId: "scope-b",
    },
  ];

  assert.equal(countReplayRetries(repeated), 2);
});

test("completed replay initially selects the newest terminal node", () => {
  assert.equal(
    initialReplayNodeId({
      ...response,
      attempts: [
        {
          ...attempts[1],
          id: 3,
          nodeId: "publish",
          state: "completed",
          outcome: { kind: "completed", status: "ok" },
        },
        attempts[0],
      ],
    }),
    "publish",
  );
});

test("switching runs resets selection to the next definition", () => {
  const nextResponse: WorkflowRunReplayResponse = {
    ...response,
    snapshot: {
      ...response.snapshot!,
      runId: "wrun_2",
      graph: {
        nodes: [
          {
            id: "new-trigger",
            type: "trigger_ticket_ai",
            name: "New trigger",
            x: 0,
            y: 0,
          },
        ],
        edges: [],
      },
      layout: {
        nodes: { "new-trigger": { x: 0, y: 0 } },
        edges: {},
      },
    },
    attempts: [],
  };

  assert.deepEqual(replaySelectionForRun(response), {
    nodeId: "review",
    attemptId: 2,
  });
  assert.deepEqual(replaySelectionForRun(nextResponse), {
    nodeId: "new-trigger",
    attemptId: null,
  });
});

test("actively executing and clarification-waiting attempts auto-poll", () => {
  assert.equal(
    isLiveReplayAttempt({ ...attempts[0], state: "running" }),
    true,
  );
  assert.equal(
    isLiveReplayAttempt({ ...attempts[0], state: "waiting_loop" }),
    true,
  );
  assert.equal(
    isLiveReplayAttempt({
      ...attempts[0],
      state: "waiting_for_clarification",
    }),
    true,
  );
  assert.equal(
    isLiveReplayAttempt({ ...attempts[0], state: "completed" }),
    false,
  );
});

test("available zero-attempt replays poll until activity appears", () => {
  assert.equal(
    shouldPollReplay({
      ...response,
      attempts: [],
      mayAdvance: true,
    }),
    true,
  );
  assert.equal(
    shouldPollReplay({
      ...response,
      mayAdvance: true,
      attempts: [
        {
          ...attempts[0],
          state: "waiting_for_clarification",
        },
      ],
    }),
    true,
  );
  assert.equal(shouldPollReplay(response), false);
  assert.equal(
    shouldPollReplay({
      ...response,
      availability: "expired",
      mayAdvance: false,
      attempts: [],
    }),
    false,
  );
  assert.equal(
    shouldPollReplay({
      ...response,
      availability: "not_captured",
      mayAdvance: true,
      snapshot: null,
      attempts: [],
    }),
    true,
  );
  assert.equal(
    shouldPollReplay({ ...response, attempts: [], mayAdvance: false }),
    false,
  );
});

test("a freshly loaded terminal row replaces a stale running summary", () => {
  const running = {
    ...attempts[0],
    state: "running" as const,
  };
  const completed = {
    ...running,
    state: "completed" as const,
    completedAt: "2026-07-23T10:02:00.000Z",
    durationMs: 120_000,
  };
  const merged = mergeReplayAttempts([running], [completed]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.state, "completed");
  assert.equal(shouldPollReplay(response), false);
});

test("older summary pages are loaded for complete graph state", async () => {
  const requests: string[] = [];
  const olderRetry: WorkflowReplayAttemptSummary = {
    ...attempts[1],
    id: 3,
    attempt: 2,
    startedAt: "2026-07-23T09:58:00.000Z",
  };
  const loaded = await loadReplayAttemptSummaryTail({
    runId: "wrun_1",
    cursor: "page-2",
    fetchPage: async (input) => {
      requests.push(input);
      if (input.includes("cursor=page-2")) {
        return {
          ok: true,
          json: async () => ({
            ...response,
            attempts: [attempts[0]],
            nextCursor: "page-3",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ...response,
          attempts: [olderRetry, attempts[0]],
          nextCursor: null,
        }),
      };
    },
  });

  assert.deepEqual(loaded.attempts.map((attempt) => attempt.id), [1, 3]);
  assert.equal(loaded.remainingCursor, null);
  assert.equal(requests.length, 2);
  assert.match(requests[0], /limit=200&cursor=page-2/);
  assert.match(requests[1], /limit=200&cursor=page-3/);
  assert.deepEqual(
    mergeReplayAttempts(attempts, loaded.attempts).map(
      (attempt) => attempt.id,
    ),
    [1, 2, 3],
  );
});

test("background graph history loading is bounded", async () => {
  let page = 0;
  const loaded = await loadReplayAttemptSummaryTail({
    runId: "wrun_1",
    cursor: "page-1",
    maxPages: 2,
    fetchPage: async () => {
      page += 1;
      return {
        ok: true,
        json: async () => ({
          ...response,
          attempts: [{ ...attempts[0], id: page + 10 }],
          nextCursor: `page-${page + 1}`,
        }),
      };
    },
  });

  assert.equal(page, 2);
  assert.equal(loaded.attempts.length, 2);
  assert.equal(loaded.remainingCursor, "page-3");
});

test("nodes absent from a partial first page are not labeled unreached", () => {
  const html = renderToStaticMarkup(
    <WorkflowReplay
      runId="wrun_1"
      initialResponse={{
        ...response,
        attempts: [attempts[1]],
        nextCursor: "page-2",
      }}
    />,
  );

  assert.match(html, /loading recent history/);
  assert.match(html, /Ticket received: Loading history/);
  assert.doesNotMatch(html, /Ticket received: Not reached/);
});

test("older retries cannot downgrade a node's latest graph state", () => {
  const newerCompletion: WorkflowReplayAttemptSummary = {
    ...attempts[1],
    id: 30,
    attempt: 1,
    state: "completed",
    outcome: { kind: "completed", status: "ok" },
    startedAt: "2026-07-23T11:00:00.000Z",
    completedAt: "2026-07-23T11:00:01.000Z",
  };
  const olderRetry: WorkflowReplayAttemptSummary = {
    ...attempts[1],
    id: 20,
    attempt: 4,
    state: "failed",
    startedAt: "2026-07-23T10:00:00.000Z",
  };

  assert.equal(
    latestReplayAttempts([newerCompletion, olderRetry]).get("review")
      ?.state,
    "completed",
  );
});

test("a live loop owner outranks later terminal iteration attempts", () => {
  const owner = {
    ...attempts[0],
    id: 40,
    nodeId: "loop",
    activationScopeId: "scope-root",
    state: "waiting_loop" as const,
    startedAt: "2026-07-23T10:00:00.000Z",
    completedAt: null,
    durationMs: null,
  };
  const iteration = {
    ...owner,
    id: 41,
    activationScopeId: "scope-root/iteration-1",
    state: "completed" as const,
    startedAt: "2026-07-23T10:00:01.000Z",
    completedAt: "2026-07-23T10:00:02.000Z",
    durationMs: 1_000,
  };
  const clarification = {
    ...owner,
    state: "waiting_for_clarification" as const,
  };

  assert.equal(compareReplayAttemptActivity(owner, iteration) > 0, true);
  assert.equal(
    latestReplayAttempts([iteration, owner]).get("loop")?.id,
    owner.id,
  );
  assert.equal(
    latestReplayAttempts([iteration, clarification]).get("loop")?.state,
    "waiting_for_clarification",
  );
});

test("latest selection follows a clarification resume until history is chosen", () => {
  const clarification = {
    ...attempts[1],
    state: "waiting_for_clarification" as const,
  };
  const resumed = {
    ...clarification,
    id: 99,
    attempt: 2,
    state: "running" as const,
    startedAt: "2026-07-23T10:03:00.000Z",
  };
  const ordered = [resumed, clarification];

  assert.equal(selectReplayAttempt(ordered, clarification.id, true)?.id, 99);
  assert.equal(
    selectReplayAttempt(ordered, clarification.id, false)?.id,
    clarification.id,
  );
});
