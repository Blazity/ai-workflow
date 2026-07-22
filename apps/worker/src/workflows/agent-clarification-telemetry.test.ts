import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordRunUsage: vi.fn(),
  getClarification: vi.fn(),
  captureRunSteps: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../lib/telemetry/run-telemetry.js", () => ({
  recordRunUsage: (...args: unknown[]) => mocks.recordRunUsage(...args),
}));
vi.mock("../clarifications/store.js", () => ({
  getClarification: (...args: unknown[]) => mocks.getClarification(...args),
}));
vi.mock("../lib/overview/collect-run-detail.js", () => ({
  captureRunStepsBestEffort: (...args: unknown[]) => mocks.captureRunSteps(...args),
  sanitizeRunStepsForDiagnosticError: (steps: unknown) => steps,
}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ world: true }) }));

import { recordRunTelemetryStep } from "./agent.js";

describe("clarification terminal telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureRunSteps.mockResolvedValue(null);
    mocks.getClarification.mockResolvedValue({ status: "answered" });
    mocks.recordRunUsage.mockResolvedValue(undefined);
  });

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
      { db: true },
      expect.objectContaining({ runId: "run-asking", status: "awaiting" }),
    );
  });
});
