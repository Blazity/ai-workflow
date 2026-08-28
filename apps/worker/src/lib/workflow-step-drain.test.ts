import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSteps: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("workflow/runtime", () => ({
  getWorld: () => ({ steps: { list: mocks.listSteps } }),
}));
vi.mock("./logger.js", () => ({
  logger: { warn: mocks.warn, info: mocks.info, error: vi.fn(), debug: vi.fn() },
}));

const { confirmWorkflowStepsDrained, DEAD_STEP_AFTER_MS, isDeadRunningStep } =
  await import("./workflow-step-drain.js");

// The UP-4765 shape (2026-08-21): one checkPhaseDone whose invocation hung
// until the 800 s kill, redelivered twice more into the same hang, then the
// operator cancelled the run. The step stayed "running" in the event log.
const stepCreatedAt = new Date("2026-08-21T11:57:54.679Z");
const firstAttemptAt = new Date("2026-08-21T11:57:54.845Z");
const runCancelledAt = new Date("2026-08-21T12:48:34.490Z");

function page(data: unknown[]) {
  return { data, cursor: null, hasMore: false };
}

function hungStep(overrides: Record<string, unknown> = {}) {
  return {
    stepId: "step_01M0J1WXT6K5Q6Q9T3DJED252E",
    stepName: "step//./src/sandbox/poll-agent//checkPhaseDone",
    status: "running",
    attempt: 3,
    createdAt: stepCreatedAt,
    startedAt: firstAttemptAt,
    updatedAt: runCancelledAt,
    ...overrides,
  };
}

describe("confirmWorkflowStepsDrained", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listSteps.mockReset();
    mocks.warn.mockReset();
    mocks.info.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a freshly cancelled run pending while its last attempt could still be executing", async () => {
    vi.setSystemTime(new Date(runCancelledAt.getTime() + 60_000));
    mocks.listSteps.mockResolvedValue(page([hungStep()]));

    await expect(confirmWorkflowStepsDrained("ticket:jira:UP-4765", "wrun_1")).resolves.toBe(false);
    expect(mocks.info).toHaveBeenCalledWith(
      { subjectKey: "ticket:jira:UP-4765", runId: "wrun_1" },
      "workflow_step_drain_pending",
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("keeps a step just past the Enterprise ceiling pending", async () => {
    vi.setSystemTime(new Date(runCancelledAt.getTime() + 900_000 + 1));
    mocks.listSteps.mockResolvedValue(page([hungStep()]));

    await expect(confirmWorkflowStepsDrained("ticket:jira:UP-4765", "wrun_1")).resolves.toBe(false);
    expect(mocks.info).toHaveBeenCalledWith(
      { subjectKey: "ticket:jira:UP-4765", runId: "wrun_1" },
      "workflow_step_drain_pending",
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("treats a running step past the safety margin as drained", async () => {
    vi.setSystemTime(new Date(runCancelledAt.getTime() + DEAD_STEP_AFTER_MS + 1_000));
    mocks.listSteps.mockResolvedValue(page([hungStep()]));

    await expect(confirmWorkflowStepsDrained("ticket:jira:UP-4765", "wrun_1")).resolves.toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKey: "ticket:jira:UP-4765",
        runId: "wrun_1",
        steps: [
          expect.objectContaining({
            stepId: "step_01M0J1WXT6K5Q6Q9T3DJED252E",
            attempt: 3,
          }),
        ],
      }),
      "workflow_step_drain_ignored_dead_steps",
    );
  });

  it("measures the ceiling from the later of startedAt and updatedAt", async () => {
    // startedAt is the first attempt, long dead; updatedAt was bumped by the
    // cancel, so an attempt started just before it could still be alive.
    vi.setSystemTime(new Date(runCancelledAt.getTime() + DEAD_STEP_AFTER_MS - 1_000));
    mocks.listSteps.mockResolvedValue(page([hungStep()]));

    await expect(confirmWorkflowStepsDrained("ticket:jira:UP-4765", "wrun_1")).resolves.toBe(false);
  });

  it("keeps a running step without timestamps live", async () => {
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    mocks.listSteps.mockResolvedValue(page([{ status: "running" }]));

    await expect(confirmWorkflowStepsDrained("subject", "wrun_1")).resolves.toBe(false);
  });

  it("keeps a running step with an invalid timestamp live", async () => {
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    mocks.listSteps.mockResolvedValue(
      page([hungStep({ updatedAt: "not-a-timestamp" })]),
    );

    await expect(confirmWorkflowStepsDrained("subject", "wrun_1")).resolves.toBe(false);
  });

  it("still drains a run with only completed steps", async () => {
    vi.setSystemTime(runCancelledAt);
    mocks.listSteps.mockResolvedValue(
      page([hungStep({ status: "completed", completedAt: firstAttemptAt })]),
    );

    await expect(confirmWorkflowStepsDrained("subject", "wrun_1")).resolves.toBe(true);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("isDeadRunningStep", () => {
  it("never reports a non-running step", () => {
    expect(
      isDeadRunningStep(
        hungStep({ status: "completed" }),
        runCancelledAt.getTime() + 10 * DEAD_STEP_AFTER_MS,
      ),
    ).toBe(false);
  });

  it("accepts ISO strings as well as Date instances", () => {
    const now = runCancelledAt.getTime() + DEAD_STEP_AFTER_MS + 1;
    expect(
      isDeadRunningStep(
        hungStep({
          startedAt: firstAttemptAt.toISOString(),
          updatedAt: runCancelledAt.toISOString(),
        }),
        now,
      ),
    ).toBe(true);
  });
});
