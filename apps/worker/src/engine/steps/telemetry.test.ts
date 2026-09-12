import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  captureRunSteps: vi.fn(),
  loggerError: vi.fn(),
  recordRunUsage: vi.fn(),
}));

vi.mock("../internal/ports.js", () => ({
  loadRunTelemetryPort: async () => ({
    recordConnectedRunUsage: (...args: unknown[]) => state.recordRunUsage(...args),
  }),
}));
vi.mock("../support/collect-run-detail.js", () => ({
  captureRunStepsBestEffort: (...args: unknown[]) => state.captureRunSteps(...args),
  sanitizeRunStepsForDiagnosticError: (steps: unknown) => steps,
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { error: (...args: unknown[]) => state.loggerError(...args) },
}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ world: true }) }));

import { persistRunTelemetryBestEffort, recordRunTelemetryStep } from "./telemetry.js";

const telemetryPayload = (): Parameters<typeof recordRunTelemetryStep>[0] => ({
  runId: "wrun_completion_pending",
  subjectKey: "ticket:jira:PROJ-1",
  status: "success",
  ticketKey: "PROJ-1",
  ticketTitle: "Telemetry regression",
  ticketUrl: "https://jira.example/browse/PROJ-1",
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
  prs: null,
  executionError: null,
});

const expectedLog = [
  {
    runId: "wrun_completion_pending",
    ticketKey: "PROJ-1",
    error: "database unavailable",
  },
  "run_completion_telemetry_persist_failed",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  state.captureRunSteps.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordRunTelemetryStep", () => {
  it("logs a rejected completion write with the run id and ticket key, then rethrows", async () => {
    const error = new Error("database unavailable");
    state.recordRunUsage.mockRejectedValue(error);

    await expect(recordRunTelemetryStep(telemetryPayload())).rejects.toBe(error);

    expect(state.loggerError).toHaveBeenCalledWith(...expectedLog);
  });

  // The guard covers the whole step body, not just the upsert: the dynamic
  // imports and this world capture can reject too, and those failures used to
  // produce no log at all.
  it("logs a failure raised before the upsert is even reached", async () => {
    const error = new Error("database unavailable");
    state.captureRunSteps.mockRejectedValue(error);

    await expect(recordRunTelemetryStep(telemetryPayload())).rejects.toBe(error);

    expect(state.recordRunUsage).not.toHaveBeenCalled();
    expect(state.loggerError).toHaveBeenCalledWith(...expectedLog);
  });
});

describe("persistRunTelemetryBestEffort", () => {
  it("resolves when the step gives up, and leaves a last-resort line behind", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    state.recordRunUsage.mockRejectedValue(new Error("database unavailable"));

    await expect(persistRunTelemetryBestEffort(telemetryPayload())).resolves.toBeUndefined();

    // console and not the pino logger: this runs in the workflow bundle, which
    // rejects any module reaching a Node builtin.
    expect(consoleError).toHaveBeenCalledWith(
      "run_completion_telemetry_persist_exhausted",
      "wrun_completion_pending",
      "PROJ-1",
      "database unavailable",
    );
  });
});
