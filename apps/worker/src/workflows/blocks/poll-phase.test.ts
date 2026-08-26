import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  delay: vi.fn().mockResolvedValue(undefined),
  checkPhaseDone: vi.fn(),
  sandboxGet: vi.fn(),
  getCommand: vi.fn(),
  kill: vi.fn().mockResolvedValue(undefined),
}));

// The poll tick is a sleeping step, not a Workflow wait (see poll-delay.ts).
// Substituting it keeps these tests instant and lets them assert the requested
// delay in milliseconds.
vi.mock("./poll-delay.js", () => ({ delayPhasePollStep: mocks.delay }));
vi.mock("../../sandbox/poll-agent.js", () => ({ checkPhaseDone: mocks.checkPhaseDone }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));

import {
  PHASE_POLL_TICK_MAX_MS,
  pollPhaseUntilDone,
  type PhasePollOutcome,
} from "./poll-phase.js";
import {
  createV2InvocationCancellationController,
  V2InvocationCancelledError,
} from "../../workflow-definition/invocation-context.js";

const ok = (remainingDurationMs: number) => ({
  check: { status: "ok" as const },
  remainingDurationMs,
});

const durationFailure = {
  status: "budget_exceeded" as const,
  metric: "duration" as const,
  limit: 10_000,
  consumed: 10_001,
  reason: "budget_exceeded: duration 10001 exceeds limit 10000",
};

describe("pollPhaseUntilDone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommand.mockResolvedValue({ kill: mocks.kill });
    mocks.sandboxGet.mockResolvedValue({ getCommand: mocks.getCommand });
  });

  it("caps each poll tick to the remaining active duration", async () => {
    const observeBudget = vi
      .fn()
      .mockResolvedValueOnce(ok(12_345))
      .mockResolvedValueOnce(ok(10_000));
    mocks.checkPhaseDone.mockResolvedValue(true);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-1", observeBudget),
    ).resolves.toBe(true);

    expect(mocks.delay).toHaveBeenCalledWith(12_345);
    expect(mocks.checkPhaseDone).toHaveBeenCalledWith("sbx-1", "/tmp/done");
    expect(observeBudget.mock.calls).toEqual([[true], [false]]);
  });

  it("accepts a phase that writes its sentinel exactly at the duration limit", async () => {
    const observeBudget = vi
      .fn()
      .mockResolvedValueOnce(ok(5_000))
      .mockResolvedValueOnce({
        check: { status: "ok" },
        remainingDurationMs: 0,
        durationLimitMs: 5_000,
        activeElapsedMs: 5_000,
      });
    mocks.checkPhaseDone.mockResolvedValue(true);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-exact", observeBudget),
    ).resolves.toBe(true);

    expect(observeBudget.mock.calls).toEqual([[true], [false]]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("kills a phase that remains active exactly at the duration limit", async () => {
    const observeBudget = vi
      .fn()
      .mockResolvedValueOnce(ok(5_000))
      .mockResolvedValueOnce({
        check: { status: "ok" },
        remainingDurationMs: 0,
        durationLimitMs: 5_000,
        activeElapsedMs: 5_000,
      });
    mocks.checkPhaseDone.mockResolvedValue(false);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-exact-active", observeBudget),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: {
        status: "budget_exceeded",
        metric: "duration",
        limit: 5_000,
        consumed: 5_000,
      },
    });

    expect(mocks.kill).toHaveBeenCalledOnce();
  });

  it("kills the detached command and throws the deterministic budget failure on expiry", async () => {
    const observeBudget = vi
      .fn()
      .mockResolvedValueOnce(ok(5_000))
      .mockResolvedValueOnce({ check: durationFailure, remainingDurationMs: 0 });

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-9", observeBudget),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: durationFailure,
    });

    expect(mocks.delay).toHaveBeenCalledWith(5_000);
    expect(mocks.sandboxGet).toHaveBeenCalledWith({ sandboxId: "sbx-1" });
    expect(mocks.getCommand).toHaveBeenCalledWith("cmd-9");
    expect(mocks.kill).toHaveBeenCalledOnce();
    expect(mocks.checkPhaseDone).toHaveBeenCalledWith("sbx-1", "/tmp/done");
  });

  it("kills the detached command when no active duration remains before sleeping", async () => {
    const observeBudget = vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 0,
      durationLimitMs: 100,
      activeElapsedMs: 100,
    });

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-0", observeBudget),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: {
        status: "budget_exceeded",
        metric: "duration",
        limit: 100,
        consumed: 100,
      },
    });

    expect(mocks.getCommand).toHaveBeenCalledWith("cmd-0");
    expect(mocks.kill).toHaveBeenCalledOnce();
    expect(mocks.delay).not.toHaveBeenCalled();
    expect(mocks.checkPhaseDone).not.toHaveBeenCalled();
  });

  it("ignores an exhausted run duration for a phase that spends its own budget", async () => {
    // The checks phase. Its time is charged to its own ceiling, so the run's
    // remaining duration says nothing about how long this poll may wait, and
    // letting it speak would halt the run as budget_exceeded instead of
    // reporting checks that outlived their bound with whatever they wrote.
    const observeBudget = vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 0,
      durationLimitMs: 100,
      activeElapsedMs: 100,
    });
    mocks.checkPhaseDone.mockResolvedValue(false);
    const outcome: PhasePollOutcome = { elapsedMs: 0, ticks: 0, reason: "finished" };

    const done = await pollPhaseUntilDone("sbx-1", "/tmp/done", 0, "cmd-0", observeBudget, undefined, {
      ignoreRemainingDuration: true,
      phaseLimitMs: 60_000,
      outcome,
    });

    expect(done).toBe(false);
    expect(outcome.reason).toBe("duration_cap");
    expect(outcome.elapsedMs).toBe(60_000);
    // And it does not even ask for the stricter reading, which would synthesize
    // a duration failure the moment the run's budget hit zero.
    expect(observeBudget).toHaveBeenCalledWith(false);
  });

  it("still stops a self-budgeted phase on a token failure", async () => {
    // Only the duration dimension is silenced. A run out of tokens is out of
    // tokens whoever is spending the clock.
    const observeBudget = vi.fn().mockResolvedValue({
      check: {
        status: "budget_exceeded",
        metric: "tokens",
        limit: 10,
        consumed: 11,
        reason: "budget_exceeded: tokens 11 reached limit 10",
      },
      remainingDurationMs: 600_000,
    });

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 0, "cmd-0", observeBudget, undefined, {
        ignoreRemainingDuration: true,
        phaseLimitMs: 60_000,
      }),
    ).rejects.toMatchObject({ name: "RunBudgetError", failure: { metric: "tokens" } });
    expect(mocks.kill).toHaveBeenCalledOnce();
  });

  it("kills the exact detached command before returning false at the normal phase cap", async () => {
    const observeBudget = vi.fn().mockResolvedValue(ok(60_000));
    mocks.checkPhaseDone.mockResolvedValue(false);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 0.0001, "cmd-normal-cap", observeBudget),
    ).resolves.toBe(false);

    expect(mocks.getCommand).toHaveBeenCalledWith("cmd-normal-cap");
    expect(mocks.kill).toHaveBeenCalledOnce();
  });

  it("kills the exact detached command when a sibling cancels the invocation", async () => {
    const controller = createV2InvocationCancellationController();
    const observeBudget = vi.fn().mockResolvedValue(ok(60_000));
    mocks.delay.mockImplementationOnce(async () => {
      controller.cancel("another block failed");
    });

    await expect(
      pollPhaseUntilDone(
        "sbx-1",
        "/tmp/done",
        25,
        "cmd-cancelled",
        observeBudget,
        controller.view,
      ),
    ).rejects.toMatchObject({
      name: "V2InvocationCancelledError",
      reason: "another block failed",
    } satisfies Partial<V2InvocationCancelledError>);

    expect(mocks.getCommand).toHaveBeenCalledWith("cmd-cancelled");
    expect(mocks.kill).toHaveBeenCalledOnce();
    expect(mocks.checkPhaseDone).not.toHaveBeenCalled();
  });

  it("keeps a caller that passes no tuning on today's behaviour", async () => {
    // Agent phases share this function and are not in scope for the check
    // batches: the flat 30s tick, no pre-check and one fatal stopped reading
    // must all survive untouched when the argument is omitted.
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone.mockResolvedValueOnce(false).mockResolvedValueOnce("stopped");

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-default", observeBudget),
    ).resolves.toBe(false);

    expect(mocks.delay).toHaveBeenCalledTimes(2);
    expect(mocks.delay).toHaveBeenNthCalledWith(1, PHASE_POLL_TICK_MAX_MS);
    // One stopped reading ends it, exactly as before this tuning existed.
    expect(mocks.checkPhaseDone).toHaveBeenCalledTimes(2);
  });

  it("returns a finished phase without sleeping when asked to check first", async () => {
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone.mockResolvedValue(true);
    const outcome: PhasePollOutcome = { elapsedMs: 0, ticks: 0, reason: "finished" };

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-quick", observeBudget, undefined, {
        checkBeforeFirstTick: true,
        outcome,
      }),
    ).resolves.toBe(true);

    expect(mocks.delay).not.toHaveBeenCalled();
    expect(outcome).toEqual({ elapsedMs: 0, ticks: 0, reason: "finished" });
  });

  it("ramps the tick toward the ceiling and never past it", async () => {
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone.mockResolvedValue(false);

    await pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-ramp", observeBudget, undefined, {
      initialTickMs: 2_000,
      tickGrowthFactor: 4,
      maxTicks: 5,
    });

    expect(mocks.delay.mock.calls.map((call) => call[0])).toEqual([
      2_000,
      8_000,
      30_000,
      30_000,
      30_000,
    ]);
  });

  it("stops appending ticks at the tick cap and says so", async () => {
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone.mockResolvedValue(false);
    const outcome: PhasePollOutcome = { elapsedMs: 0, ticks: 0, reason: "finished" };

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 600, "cmd-ticks", observeBudget, undefined, {
        maxTicks: 3,
        outcome,
      }),
    ).resolves.toBe(false);

    expect(mocks.delay).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({ elapsedMs: 90_000, ticks: 3, reason: "tick_cap" });
  });

  it("survives one unreachable reading but not two in a row", async () => {
    // checkPhaseDone reports "stopped" for any failure to reach the sandbox,
    // not only for a sandbox that is gone. A batch polled for tens of minutes
    // asks it dozens of times, so one blip may not abandon the run's checks.
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone
      .mockResolvedValueOnce("stopped")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce("stopped")
      .mockResolvedValueOnce(true);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-blip", observeBudget, undefined, {
        stoppedObservations: 2,
      }),
    ).resolves.toBe(true);

    const outcome: PhasePollOutcome = { elapsedMs: 0, ticks: 0, reason: "finished" };
    mocks.checkPhaseDone.mockResolvedValue("stopped");
    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-dead", observeBudget, undefined, {
        stoppedObservations: 2,
        outcome,
      }),
    ).resolves.toBe(false);

    expect(outcome.reason).toBe("sandbox_stopped");
  });

  it("reports the elapsed time a duration cap actually consumed", async () => {
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone.mockResolvedValue(false);
    const outcome: PhasePollOutcome = { elapsedMs: 0, ticks: 0, reason: "finished" };

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 2, "cmd-cap", observeBudget, undefined, {
        outcome,
      }),
    ).resolves.toBe(false);

    // Four 30s ticks fill the two minute cap exactly, and that is what the
    // caller reports, rather than the cap it asked for.
    expect(outcome).toEqual({ elapsedMs: 120_000, ticks: 4, reason: "duration_cap" });
  });

  it("takes its time bound in milliseconds when the caller has one", async () => {
    // A caller deriving its bound from the remaining duration budget cannot
    // express it in whole minutes: flooring makes the phase cap expire before
    // the budget does, so a run that ran out of time reports a timed-out phase
    // instead of halting as budget_exceeded.
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone.mockResolvedValue(false);
    const outcome: PhasePollOutcome = { elapsedMs: 0, ticks: 0, reason: "finished" };

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-ms", observeBudget, undefined, {
        phaseLimitMs: 45_000,
        outcome,
      }),
    ).resolves.toBe(false);

    // 45s of bound, not the 25 minutes the positional argument still carries.
    expect(mocks.delay.mock.calls.map((call) => call[0])).toEqual([30_000, 15_000]);
    expect(outcome).toEqual({ elapsedMs: 45_000, ticks: 2, reason: "duration_cap" });
  });

  it("reports what each completed tick consumed, for a caller that wants one", async () => {
    // The only seam a long phase has for saying anything while it is still
    // running. Opt-in per call site: an agent phase does not want one of these
    // per tick, the checks batch does.
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone.mockResolvedValue(false);
    const ticks: Array<{
      elapsedMs: number;
      ticks: number;
      sleepMs: number;
      remainingDurationMs: number;
    }> = [];

    await pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-tick", observeBudget, undefined, {
      phaseLimitMs: 45_000,
      onTick: (progress) => {
        ticks.push(progress);
      },
    });

    // sleepMs is the tick that just elapsed, and it shrinks when the phase
    // limit is closer than the interval. A caller throttling its own reports
    // needs it, and needs the duration budget too: for a setup batch that is
    // the bound that actually binds, not the phase limit.
    expect(ticks).toEqual([
      { elapsedMs: 30_000, ticks: 1, sleepMs: 30_000, remainingDurationMs: 600_000 },
      { elapsedMs: 45_000, ticks: 2, sleepMs: 15_000, remainingDurationMs: 600_000 },
    ]);
  });

  it("polls on without an onTick, which is what every phase did before it", async () => {
    const observeBudget = vi.fn().mockResolvedValue(ok(600_000));
    mocks.checkPhaseDone.mockResolvedValue(true);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-none", observeBudget),
    ).resolves.toBe(true);
  });
});
