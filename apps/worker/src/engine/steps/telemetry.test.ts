import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  captureRunSteps: vi.fn(),
  finalizeRunAnalysisUsage: vi.fn(),
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
vi.mock("../../run-analysis/persistence.js", () => ({
  finalizeConnectedRunAnalysisUsage: (...args: unknown[]) =>
    state.finalizeRunAnalysisUsage(...args),
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
  state.finalizeRunAnalysisUsage.mockResolvedValue(undefined);
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

  // The analysis snapshot stays a nice-to-have (the telemetry write above it
  // has already landed, and failing the step would retry that write for
  // nothing), but "swallowed" used to mean a console line nothing queries. The
  // run id is what makes it findable at all.
  it("logs a failed final usage snapshot at error level with the run id, and still resolves", async () => {
    state.recordRunUsage.mockResolvedValue(undefined);
    state.finalizeRunAnalysisUsage.mockRejectedValue(new Error("analysis store unavailable"));

    await expect(recordRunTelemetryStep(telemetryPayload())).resolves.toBeUndefined();

    expect(state.loggerError).toHaveBeenCalledWith(
      {
        runId: "wrun_completion_pending",
        ticketKey: "PROJ-1",
        error: "analysis store unavailable",
      },
      "run_analysis_final_usage_failed",
    );
  });
});

describe("the durable why a failed run records", () => {
  beforeEach(() => {
    state.recordRunUsage.mockResolvedValue(undefined);
  });

  /** The reason handed to the one write, whatever shape it took. */
  async function recordedReason(
    over: Partial<Parameters<typeof recordRunTelemetryStep>[0]>,
  ): Promise<unknown> {
    await recordRunTelemetryStep({ ...telemetryPayload(), ...over });
    const [usage] = state.recordRunUsage.mock.calls[0] as [{ statusReason: unknown }];
    return usage.statusReason;
  }

  it("records a plain sentence for a failure that carries no code", async () => {
    // Every failure in the product today, and every run that failed before the
    // column existed. The shape a reader sees must not change for them.
    expect(
      await recordedReason({
        status: "failed",
        executionError: { message: "The block timed out.", code: "diag-1" },
      }),
    ).toBe("The block timed out.");
  });

  it("records a plain sentence for a budget stop, which has no code either", async () => {
    expect(
      await recordedReason({
        status: "failed",
        executionError: null,
        budgetFailure: {
          status: "budget_exceeded",
          metric: "cost",
          limit: 0.3,
          consumed: 0.31,
          reason: "budget_exceeded: cost 0.31 exceeds limit 0.3",
        },
      }),
    ).toBe("Run stopped on budget: budget_exceeded: cost 0.31 exceeds limit 0.3");
  });

  it("records the sentence and the code together when the failure has one", async () => {
    // One value, one write. The sentence is unchanged: the code sits beside it
    // rather than replacing it, because the two answer different readers.
    expect(
      await recordedReason({
        status: "failed",
        executionError: {
          message: "Acme Notify was disabled while this run was in flight.",
          code: "diag-2",
          failureCode: "integration_unavailable.disabled",
        },
      }),
    ).toEqual({
      text: "Acme Notify was disabled while this run was in flight.",
      code: "integration_unavailable.disabled",
    });
  });

  it("records nothing on an outcome that is not a failure", async () => {
    expect(
      await recordedReason({
        status: "success",
        executionError: {
          message: "leftover",
          code: "diag-3",
          failureCode: "integration_unavailable.disabled",
        },
      }),
    ).toBeNull();
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
