import { describe, expect, it } from "vitest";
import type { PhaseUsage } from "../sandbox/agents/types.js";
import {
  addActiveElapsed,
  checkRunBudget,
  createRunBudgetState,
  observeRunBudget,
  recordBudgetUsage,
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
