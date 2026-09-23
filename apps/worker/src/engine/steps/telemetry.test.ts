import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  captureRunSteps: vi.fn(),
  finalizeRunAnalysisUsage: vi.fn(),
  loggerError: vi.fn(),
  recordRunUsage: vi.fn(),
  knownSecrets: vi.fn(),
  replaced: [] as unknown[],
  markedUnavailable: vi.fn(),
}));

// The replay store, at the statement boundary: one attempt that exists, and
// every replacement kept so a test can read exactly what would be written.
vi.mock("../../db/repositories/runs/run-observability.js", () => ({
  getConnectedWorkflowBlockAttemptPersistence: async () => ({
    state: "running",
    outcome: null,
    selectedTransition: null,
    diagnosticId: null,
    inputEnvelope: null,
    outputEnvelope: null,
    logEnvelope: null,
    metadataEnvelope: null,
    observationRevision: 0,
    startedAt: new Date("2026-09-22T10:00:00.000Z"),
    completedAt: null,
    durationMs: null,
  }),
  replaceConnectedWorkflowBlockAttemptPersistence: async (prepared: unknown) => {
    state.replaced.push(prepared);
    return true;
  },
  markConnectedRunReplayCaptureUnavailable: (...args: unknown[]) =>
    state.markedUnavailable(...args),
}));

// Every secret the deployment knows. The step asks this source and no other,
// so a value handed back here and set in no environment variable is what a
// token an admin stored in the dashboard looks like to it.
vi.mock("../../services/integrations/runtime.js", () => ({
  knownSecretValues: () => state.knownSecrets(),
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
  logger: { error: (...args: unknown[]) => state.loggerError(...args), warn: vi.fn() },
}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ world: true }) }));

import {
  flushV2RunObservationsStep,
  persistRunTelemetryBestEffort,
  recordRunTelemetryStep,
} from "./telemetry.js";
import { sanitizeReplayValue } from "../../run-observability/sanitizer.js";

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
  state.replaced.length = 0;
  state.knownSecrets.mockResolvedValue([]);
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

  // Red when: the failure sentence, composed in workflow scope with only the
  // environment's secrets, is written as it arrived. An agent that echoed a
  // token an admin stored in the dashboard puts it in exactly this sentence,
  // and this row is what the trace screen and runs.get show.
  it("redacts a secret stored in the dashboard out of the sentence it keeps", async () => {
    const stored = "plainvalue5530stored";
    state.knownSecrets.mockResolvedValue([stored]);

    const reason = await recordedReason({
      status: "failed",
      executionError: {
        message: `The CLI exited with code 1 (printed ${stored} on the way out).`,
        code: "diag-4",
      },
    });

    expect(JSON.stringify(reason)).not.toContain(stored);
    expect(reason).toContain("[REDACTED:configured_secret]");
  });

  // Red when: a set that cannot be read is treated as an empty one and the
  // sentence is written anyway. The attempt fails instead and the durable
  // retry asks again.
  it("writes nothing when the secrets cannot be read", async () => {
    state.knownSecrets.mockRejectedValue(new Error("integration settings unreadable"));

    await expect(
      recordRunTelemetryStep({
        ...telemetryPayload(),
        status: "failed",
        executionError: { message: "The block timed out.", code: "diag-5" },
      }),
    ).rejects.toThrow("integration settings unreadable");
    expect(state.recordRunUsage).not.toHaveBeenCalled();
    // Still a line per failed attempt, which is what this step promises.
    expect(state.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "wrun_completion_pending" }),
      "run_completion_telemetry_persist_failed",
    );
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

describe("a replay observation on its way to the store", () => {
  const stored = "plainvalue6618stored";
  // What workflow scope hands the step: already sanitized, but with the
  // environment's secrets only, because that is all workflow scope can see.
  const observation = {
    kind: "log" as const,
    envelope: sanitizeReplayValue(`agent printed ${stored} while running tests`, {
      secrets: [],
      retain: "tail",
    }),
  };
  const flush = () =>
    flushV2RunObservationsStep({
      runId: "wrun_replay",
      organizationId: "org-1",
      attemptId: 7,
      observations: [observation],
    });

  // Red when: the step writes the envelope as workflow scope sent it, which is
  // how a token an admin stored in the dashboard reached a replay in the clear.
  it("is written with every secret the deployment knows redacted, a stored one included", async () => {
    state.knownSecrets.mockResolvedValue([stored]);

    expect(await flush()).toBe(true);

    const written = JSON.stringify(state.replaced);
    expect(written).not.toContain(stored);
    expect(written).toContain("[REDACTED:configured_secret]");
  });

  // Red when: a set that cannot be read lets the observation through unredacted
  // instead of marking the replay unavailable.
  it("is not written when the secrets cannot be read, and the replay says it is unavailable", async () => {
    state.knownSecrets.mockRejectedValue(new Error("integration settings unreadable"));

    expect(await flush()).toBe(false);

    expect(state.replaced).toEqual([]);
    expect(state.markedUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "wrun_replay" }),
    );
  });
});
