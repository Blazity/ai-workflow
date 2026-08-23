import { describe, expect, it } from "vitest";
import type { PhaseUsage } from "../sandbox/agents/types.js";
import { mergeBudgetObservations } from "./agent.js";
import type { RunBudgetObservation } from "./run-budget.js";
import {
  addActiveElapsed,
  addChecksElapsed,
  addElapsed,
  checkRunBudget,
  checksElapsedOf,
  createRunBudgetState,
  observeRunBudget,
  recordBudgetUsage,
  remainingChecksMs,
  totalBudgetTokens,
} from "./run-budget.js";

const usage = (over: Partial<PhaseUsage> = {}): PhaseUsage => ({
  cost_usd: null,
  tokens: { input: 10, cached_input: 20, output: 30 },
  duration_ms: 1_000,
  duration_api_ms: 900,
  num_turns: 1,
  ...over,
});

describe("mergeBudgetObservations", () => {
  const observation = (over: Partial<RunBudgetObservation> = {}): RunBudgetObservation => ({
    check: { status: "ok" },
    remainingDurationMs: 600_000,
    durationLimitMs: 1_800_000,
    activeElapsedMs: 1_200_000,
    checksElapsedMs: 0,
    ...over,
  });

  it("carries the LARGER checks total, not the tighter one", () => {
    // A profile context is created when its block starts, so it has not seen
    // the checks other blocks already spent. Taking its smaller total would
    // hand every profile block a fresh ceiling and let one run spend the
    // ceiling several times over.
    const merged = mergeBudgetObservations(
      observation({ checksElapsedMs: 900_000 }),
      observation({ checksElapsedMs: 0 }),
    );

    expect(merged.checksElapsedMs).toBe(900_000);
    // Duration still merges the other way: the tighter remaining wins.
    expect(merged.remainingDurationMs).toBe(600_000);
  });

  it("keeps the checks total on a failing merge, whichever side failed", () => {
    const failure = {
      status: "budget_exceeded" as const,
      metric: "tokens" as const,
      limit: 10,
      consumed: 11,
      reason: "budget_exceeded: tokens 11 reached limit 10",
    };

    expect(
      mergeBudgetObservations(
        observation({ check: failure }),
        observation({ checksElapsedMs: 900_000 }),
      ).checksElapsedMs,
    ).toBe(900_000);
    expect(
      mergeBudgetObservations(
        observation({ checksElapsedMs: 900_000 }),
        observation({ check: failure }),
      ).checksElapsedMs,
    ).toBe(900_000);
  });

  it("treats an absent total on either side as zero spent", () => {
    const legacy = observation();
    delete legacy.checksElapsedMs;

    expect(
      mergeBudgetObservations(legacy, observation({ checksElapsedMs: 120_000 }))
        .checksElapsedMs,
    ).toBe(120_000);
    expect(mergeBudgetObservations(legacy, legacy).checksElapsedMs).toBe(0);
  });
});

describe("checks phase accounting", () => {
  it("charges checks time to its own clock, leaving the run's duration alone", () => {
    const state = addChecksElapsed(addActiveElapsed(createRunBudgetState(), 400), 900_000);

    expect(state.activeElapsedMs).toBe(400);
    expect(checksElapsedOf(state)).toBe(900_000);
    // The whole point: nineteen minutes of somebody's test suite does not
    // exhaust a thirty minute run budget that exists to pay for agent work.
    expect(checkRunBudget(state, { maxDurationMs: 1_000 })).toEqual({ status: "ok" });
  });

  it("routes elapsed time by attribution", () => {
    const run = addElapsed(createRunBudgetState(), 500, "duration");
    const checks = addElapsed(createRunBudgetState(), 500, "checks");

    expect(run.activeElapsedMs).toBe(500);
    expect(checksElapsedOf(run)).toBe(0);
    expect(checks.activeElapsedMs).toBe(0);
    expect(checksElapsedOf(checks)).toBe(500);
  });

  it("reads an absent checks total as zero rather than as NaN", () => {
    // A budget state can cross a step boundary as a journaled argument, so a
    // run started before this field existed resumes without it. Reading it
    // directly would make every bound derived from it NaN, which compares
    // false against everything and silently disables the ceiling.
    const legacy = { ...createRunBudgetState() } as Record<string, unknown>;
    delete legacy.checksElapsedMs;

    expect(checksElapsedOf(legacy as unknown as ReturnType<typeof createRunBudgetState>)).toBe(0);
    expect(remainingChecksMs(legacy, 600_000)).toBe(600_000);
    expect(remainingChecksMs({}, 600_000)).toBe(600_000);
  });

  it("never reports a negative remainder once the ceiling is spent", () => {
    expect(remainingChecksMs({ checksElapsedMs: 700_000 }, 600_000)).toBe(0);
    expect(remainingChecksMs({ checksElapsedMs: 100_000 }, 600_000)).toBe(500_000);
  });

  it("publishes the checks total on every observation", () => {
    const state = addChecksElapsed(createRunBudgetState(), 120_000);

    expect(observeRunBudget(state, { maxDurationMs: 1_000_000 }, true)).toMatchObject({
      check: { status: "ok" },
      checksElapsedMs: 120_000,
    });
  });
});

describe("run budget accounting", () => {
  it("tracks active elapsed time without reading the clock itself", () => {
    const state = addActiveElapsed(addActiveElapsed(createRunBudgetState(), 400), 600);

    expect(state.activeElapsedMs).toBe(1_000);
    expect(checkRunBudget(state, { maxDurationMs: 1_000 })).toEqual({ status: "ok" });
    expect(checkRunBudget(addActiveElapsed(state, 1), { maxDurationMs: 1_000 })).toMatchObject({
      status: "budget_exceeded",
      metric: "duration",
      limit: 1_000,
      consumed: 1_001,
    });
  });

  it("allows exact duration on completion but not when more work would start", () => {
    const state = addActiveElapsed(createRunBudgetState(), 1_000);
    const limits = { maxDurationMs: 1_000 };

    expect(observeRunBudget(state, limits, false).check).toEqual({ status: "ok" });
    expect(observeRunBudget(state, limits, true).check).toMatchObject({
      status: "budget_exceeded",
      metric: "duration",
      limit: 1_000,
      consumed: 1_000,
    });
  });

  it("counts input, cached input, and output tokens", () => {
    const state = recordBudgetUsage(createRunBudgetState(), usage(), null);

    expect(totalBudgetTokens(state)).toBe(60);
  });

  it("uses direct phase cost when available", () => {
    const state = recordBudgetUsage(
      createRunBudgetState(),
      usage({ cost_usd: 1.25, tokens: null }),
      null,
    );

    expect(state.costUsd).toBe(1.25);
    expect(state.costKnown).toBe(true);
  });

  it("derives phase cost from token pricing when direct cost is absent", () => {
    const state = recordBudgetUsage(createRunBudgetState(), usage(), {
      input: 0.01,
      cached_input: 0.001,
      output: 0.02,
    });

    expect(state.costUsd).toBeCloseTo(0.1 + 0.02 + 0.6, 8);
    expect(state.costKnown).toBe(true);
  });

  it("passes exact token and cost limits and fails only when over", () => {
    const exact = recordBudgetUsage(
      createRunBudgetState(),
      usage({ cost_usd: 2 }),
      null,
    );

    expect(checkRunBudget(exact, { maxDurationMs: 5_000, maxTokens: 60, maxCostUsd: 2 })).toEqual({
      status: "ok",
    });
    expect(checkRunBudget(exact, { maxDurationMs: 5_000, maxTokens: 59 })).toMatchObject({
      status: "budget_exceeded",
      metric: "tokens",
      consumed: 60,
      limit: 59,
    });
    expect(checkRunBudget(exact, { maxDurationMs: 5_000, maxCostUsd: 1.99 })).toMatchObject({
      status: "budget_exceeded",
      metric: "cost",
      consumed: 2,
      limit: 1.99,
    });
  });

  it("uses decimal-safe direct cost accumulation at an exact limit", () => {
    let state = recordBudgetUsage(
      createRunBudgetState(),
      usage({ cost_usd: 0.1 }),
      null,
    );
    state = recordBudgetUsage(state, usage({ cost_usd: 0.2 }), null);

    expect(checkRunBudget(state, { maxDurationMs: 5_000, maxCostUsd: 0.3 })).toEqual({
      status: "ok",
    });
    expect(checkRunBudget(state, { maxDurationMs: 5_000, maxCostUsd: 0.299_999_999 })).toMatchObject({
      status: "budget_exceeded",
      metric: "cost",
      limit: 0.299_999_999,
      consumed: 0.3,
    });
  });

  it("uses decimal-safe price-derived cost accumulation at an exact limit", () => {
    const oneInputToken = usage({
      cost_usd: null,
      tokens: { input: 1, cached_input: 0, output: 0 },
    });
    let state = recordBudgetUsage(createRunBudgetState(), oneInputToken, {
      input: 0.1,
      cached_input: 0,
      output: 0,
    });
    state = recordBudgetUsage(state, oneInputToken, {
      input: 0.2,
      cached_input: 0,
      output: 0,
    });

    expect(checkRunBudget(state, { maxDurationMs: 5_000, maxCostUsd: 0.3 })).toEqual({
      status: "ok",
    });
  });

  it("fails closed when token usage is missing under a token cap", () => {
    const state = recordBudgetUsage(createRunBudgetState(), null, null);

    expect(checkRunBudget(state, { maxDurationMs: 5_000, maxTokens: 1_000 })).toEqual({
      status: "budget_unverifiable",
      metric: "tokens",
      limit: 1_000,
      consumed: null,
      reason: "budget_unverifiable: token usage is unavailable",
    });
    expect(checkRunBudget(state, { maxDurationMs: 5_000 })).toEqual({ status: "ok" });
  });

  it("fails closed when pricing is missing under a cost cap", () => {
    const state = recordBudgetUsage(createRunBudgetState(), usage(), null);

    expect(checkRunBudget(state, { maxDurationMs: 5_000, maxCostUsd: 10 })).toEqual({
      status: "budget_unverifiable",
      metric: "cost",
      limit: 10,
      consumed: null,
      reason: "budget_unverifiable: cost usage or pricing is unavailable",
    });
  });
});
