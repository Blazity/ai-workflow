import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordRunUsage: vi.fn(),
  getClarification: vi.fn(),
  captureRunSteps: vi.fn(),
}));

vi.mock("../../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../../db/repositories/runs/telemetry.js", () => ({
  markRunFailedOnSelfMove: vi.fn(),
  markRunSucceededOnSelfMove: vi.fn(),
  recordBlockStatuses: vi.fn(),
  recordRunStatusReason: vi.fn(),
  recordRunUsage: (...args: unknown[]) => mocks.recordRunUsage(...args),
  recordConnectedRunUsage: (...args: unknown[]) => mocks.recordRunUsage(...args),
}));
vi.mock("../../db/repositories/clarifications.js", () => ({
  getClarification: (...args: unknown[]) => mocks.getClarification(...args),
}));
vi.mock("../../services/overview/collect-run-detail.js", () => ({
  captureRunStepsBestEffort: (...args: unknown[]) => mocks.captureRunSteps(...args),
  sanitizeRunStepsForDiagnosticError: (steps: unknown) => steps,
}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ world: true }) }));

import { recordRunTelemetryStep } from "../steps/telemetry.js";
import { durationBudgetFailure } from "../helpers/run-budget.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.captureRunSteps.mockResolvedValue(null);
  mocks.getClarification.mockResolvedValue({ status: "answered" });
  mocks.recordRunUsage.mockResolvedValue(undefined);
});

describe("clarification terminal telemetry", () => {
  it("always records the asking run as awaiting even when the answer raced its finally", async () => {
    await recordRunTelemetryStep({
      runId: "run-asking",
      subjectKey: "ticket:jira:AWT-1",
      status: "awaiting",
      ticketKey: "AWT-1",
      ticketTitle: "Ticket",
      ticketUrl: "https://jira.example/browse/AWT-1",
      model: null,
      totals: {
        costUsd: 0,
        costKnown: true,
        tokensInput: 0,
        tokensCached: 0,
        tokensOutput: 0,
        phases: {},
      },
      budgetFailure: null,
      pr: null,
      executionError: null,
      awaitingClarificationId: "clarification-answered",
    } as never);

    expect(mocks.getClarification).not.toHaveBeenCalled();
    expect(mocks.recordRunUsage).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-asking", status: "awaiting" }),
    );
  });
});

describe("duration terminal telemetry", () => {
  it("keeps the telemetry prefix in front of the actionable duration message", async () => {
    const failure = durationBudgetFailure({
      durationLimitMs: 1_800_000,
      activeElapsedMs: 1_872_999,
      maxDurationSource: "env",
    });

    await recordRunTelemetryStep({
      runId: "run-duration-budget",
      subjectKey: "ticket:jira:AWT-1",
      status: "failed",
      ticketKey: "AWT-1",
      ticketTitle: "Ticket",
      ticketUrl: "https://jira.example/browse/AWT-1",
      model: null,
      totals: {
        costUsd: 0,
        costKnown: true,
        tokensInput: 0,
        tokensCached: 0,
        tokensOutput: 0,
        phases: {},
      },
      budgetFailure: failure,
      pr: null,
      prs: null,
      executionError: null,
    });

    expect(mocks.recordRunUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        statusReason:
          "Run stopped on budget: budget_exceeded: the run took 31 min 12 s, over the " +
          "30 min limit from JOB_TIMEOUT_MS (this workflow sets no budgets.maxDurationMs). " +
          "Raise budgets.maxDurationMs on the workflow definition, or JOB_TIMEOUT_MS, to allow longer runs.",
      }),
    );
  });
});
