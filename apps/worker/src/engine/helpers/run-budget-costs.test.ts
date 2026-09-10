import { describe, expect, it } from "vitest";
import type { PhaseUsage } from "../../sandbox/agents/types.js";
import {
  checkRunBudget,
  createRunBudgetState,
  recordBudgetUsage,
} from "./run-budget.js";

const usage = (over: Partial<PhaseUsage> = {}): PhaseUsage => ({
  cost_usd: null,
  tokens: { input: 10, cached_input: 20, output: 30 },
  duration_ms: 1_000,
  duration_api_ms: 900,
  num_turns: 1,
  ...over,
});

const PRICE = { input: 0.01, cached_input: 0.001, output: 0.02 };
// 10 * 0.01 + 20 * 0.001 + 30 * 0.02 = 0.72.
const PRICED_USD = 0.72;

describe("canonical run budget aggregation", () => {
  // The in-process LLM path always records tokens and a null cost_usd. Pricing
  // it by token keeps a run with maxCostUsd set verifiable; failing closed here
  // would halt runs that the same definition completed before.
  it("prices Claude token-only usage from the model price under a cost cap", () => {
    const state = recordBudgetUsage(createRunBudgetState(), usage(), {
      kind: "claude",
      price: PRICE,
    });

    expect(state.costKnown).toBe(true);
    expect(state.costUsd).toBeCloseTo(PRICED_USD, 8);
    expect(checkRunBudget(state, { maxDurationMs: 5_000, maxCostUsd: 10 })).toEqual({
      status: "ok",
    });
  });

  // A call_llm block with an explicit model and no provider states no kind at
  // all. The model price still has to reach it.
  it("prices a phase whose provider was never stated", () => {
    const state = recordBudgetUsage(createRunBudgetState(), usage(), {
      price: PRICE,
    });

    expect(state.costKnown).toBe(true);
    expect(state.costUsd).toBeCloseTo(PRICED_USD, 8);
  });

  it("marks cumulative token overflow unknown without replacing the subtotal", () => {
    const initial = {
      ...createRunBudgetState(),
      tokensInput: Number.MAX_SAFE_INTEGER,
    };
    const state = recordBudgetUsage(
      initial,
      usage({ tokens: { input: 1, cached_input: 0, output: 0 } }),
      {
        kind: "codex",
        price: { input: 0, cached_input: 0, output: 0 },
      },
    );

    expect(state.tokensInput).toBe(Number.MAX_SAFE_INTEGER);
    expect(state.tokensKnown).toBe(false);
  });
});
