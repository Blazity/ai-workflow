import { describe, expect, it } from "vitest";
import type {
  ReplayRedactionClass,
  ReplaySanitizedEnvelope,
  WorkflowReplayAttemptDetail,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import {
  assertReplayCanaryEvidence,
  createReplayCanaryFixture,
  parseReplayCanaryEnv,
  type ReplayCanaryEvidence,
} from "../e2e/replay/canary-contract.js";

const replayEnv = {
  REPLAY_CANARY_DASHBOARD_BASE_URL: "https://dashboard-preview.example.test",
  REPLAY_CANARY_DASHBOARD_EXPECTED_HOST:
    "dashboard-preview.example.test",
  REPLAY_CANARY_DASHBOARD_AUTOMATION_BYPASS_SECRET:
    "dashboard-preview-bypass",
  REPLAY_CANARY_LOG_EXPORT_PATH: "/tmp/replay-preview-canary.log",
};

const fixture = createReplayCanaryFixture("0123456789abcdef01234567");

function envelope(
  value: string,
  redactions: ReplayRedactionClass[] = [],
): ReplaySanitizedEnvelope {
  return {
    value,
    metadata: {
      redactions: Object.fromEntries(
        redactions.map((redaction) => [redaction, 1]),
      ),
      truncated: false,
      originalBytes: value.length,
      storedBytes: value.length,
      unavailable: false,
      unavailableReason: null,
    },
  };
}

function evidence(): ReplayCanaryEvidence {
  const attempt: WorkflowReplayAttemptDetail = {
    id: 41,
    nodeId: "agent",
    attempt: 1,
    activationScopeId: "root",
    state: "completed",
    outcome: { kind: "completed", status: "success" },
    selectedTransition: null,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    durationMs: 1,
    diagnosticId: null,
    input: envelope("sanitized", [
      "hard_exclusion",
      "token",
      "email",
      "phone",
      "payment_card",
      "iban",
    ]),
    output: envelope("safe"),
    logs: envelope("safe log tail"),
    metadata: null,
  };
  const summary: WorkflowRunReplayResponse = {
    availability: "available",
    mayAdvance: false,
    snapshot: {
      runId: "wrun_canary",
      definitionId: 7,
      definitionVersion: 2,
      definitionSchemaVersion: 2,
      graph: {
        nodes: [
          {
            id: "agent",
            type: "generic_agent",
            name: "Agent",
            x: 0,
            y: 0,
          },
        ],
        edges: [],
      },
      layout: { nodes: {} },
      runtimeManifest: envelope("safe manifest"),
      captureStatus: "available",
      capturedAt: new Date(0).toISOString(),
      expiresAt: new Date(2).toISOString(),
    },
    attempts: [
      {
        id: attempt.id,
        nodeId: attempt.nodeId,
        attempt: attempt.attempt,
        activationScopeId: attempt.activationScopeId,
        state: attempt.state,
        outcome: attempt.outcome,
        selectedTransition: attempt.selectedTransition,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        durationMs: attempt.durationMs,
        diagnosticId: attempt.diagnosticId,
      },
    ],
    nextCursor: null,
  };
  return {
    runId: "wrun_canary",
    databaseRows: {
      observation: { run_id: "wrun_canary", runtime_manifest: envelope("safe") },
      attempts: [
        {
          id: 41,
          input_envelope: attempt.input,
          log_envelope: attempt.logs,
        },
      ],
    },
    apiSummary: summary,
    apiDetails: [attempt],
    dashboardHtml:
      '<main><h2>Visual replay</h2><div data-replay-canvas="true"></div></main>',
    appendedLogExport:
      '{"workflow_run_id":"wrun_canary","message":"completed"}',
  };
}

describe("Replay preview canary dry checks", () => {
  it("requires an exact HTTPS dashboard host and absolute log path", () => {
    expect(parseReplayCanaryEnv(replayEnv)).toMatchObject({
      REPLAY_CANARY_LOG_WAIT_MS: 120_000,
      REPLAY_CANARY_LOG_SETTLE_MS: 15_000,
      REPLAY_CANARY_LOG_MAX_BYTES: 33_554_432,
    });
    expect(() =>
      parseReplayCanaryEnv({
        ...replayEnv,
        REPLAY_CANARY_DASHBOARD_BASE_URL:
          "http://dashboard-preview.example.test",
      }),
    ).toThrow();
    expect(() =>
      parseReplayCanaryEnv({
        ...replayEnv,
        REPLAY_CANARY_DASHBOARD_EXPECTED_HOST: "production.example.test",
      }),
    ).toThrow();
    expect(() =>
      parseReplayCanaryEnv({
        ...replayEnv,
        REPLAY_CANARY_LOG_EXPORT_PATH: "relative.log",
      }),
    ).toThrow();
  });

  it("builds a bounded fixture with all required sensitive-data classes", () => {
    expect(fixture.ticketDescription).toContain("token:");
    expect(fixture.ticketDescription).toContain("Authorization: Basic");
    expect(fixture.forbiddenValues.length).toBeGreaterThanOrEqual(10);
    expect(() => createReplayCanaryFixture("not-a-valid-nonce")).toThrow();
  });

  it("accepts complete sanitized DB, API, log, and rendered UI evidence", () => {
    expect(() =>
      assertReplayCanaryEvidence(evidence(), fixture),
    ).not.toThrow();
  });

  it.each([
    "database",
    "summary",
    "detail",
    "dashboard",
    "log",
  ] as const)("fails closed when the %s surface leaks a canary value", (surface) => {
    const candidate = evidence();
    const leaked = fixture.forbiddenValues[0]!;
    if (surface === "database") {
      candidate.databaseRows.observation = { leaked };
    } else if (surface === "summary") {
      candidate.apiSummary.attempts[0]!.outcome = {
        kind: "completed",
        status: leaked,
      };
    } else if (surface === "detail") {
      candidate.apiDetails[0]!.output = envelope(leaked);
    } else if (surface === "dashboard") {
      candidate.dashboardHtml += leaked;
    } else {
      candidate.appendedLogExport += leaked;
    }
    let message = "";
    try {
      assertReplayCanaryEvidence(candidate, fixture);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/contains a replay canary value/);
    expect(message).not.toContain(leaked);
  });

  it("requires API/DB log envelopes and run-scoped settled log evidence", () => {
    const noApiLog = evidence();
    noApiLog.apiDetails[0]!.logs = null;
    expect(() =>
      assertReplayCanaryEvidence(noApiLog, fixture),
    ).toThrow(/log envelope/);

    const noDbLog = evidence();
    (
      noDbLog.databaseRows.attempts[0] as Record<string, unknown>
    ).log_envelope = null;
    expect(() =>
      assertReplayCanaryEvidence(noDbLog, fixture),
    ).toThrow(/log envelope/);

    const unrelatedLogs = evidence();
    unrelatedLogs.appendedLogExport = '{"message":"another run"}';
    expect(() =>
      assertReplayCanaryEvidence(unrelatedLogs, fixture),
    ).toThrow(/does not prove coverage/);
  });

  it("requires redaction proof for every injected sensitive-data class", () => {
    const candidate = evidence();
    candidate.apiDetails[0]!.input = envelope("sanitized", ["token"]);
    expect(() =>
      assertReplayCanaryEvidence(candidate, fixture),
    ).toThrow(/expected hard_exclusion redaction/);
  });
});
