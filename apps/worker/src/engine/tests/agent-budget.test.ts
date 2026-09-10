import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import type { PhaseUsage } from "../../sandbox/agents/types.js";
import { recordPrePrFixCycleUsages } from "../agent-workflow.js";
import { blockRunStateSummary, modelsRequiringPriceLookup, soleActiveBlockId } from "../helpers/prompt-output.js";
import { createHarnessInvocationBudget } from "../steps/phase.js";
import {
  checkRunBudget,
  createRunBudgetState,
  missingRequiredPriceFailure,
  recordBudgetUsage,
} from "../helpers/run-budget.js";
import { makeHarnessRuntime } from "../blocks/support/test-support.js";

const node = (
  id: string,
  type: WorkflowDefinitionNode["type"],
  params: WorkflowDefinitionNode["params"],
): WorkflowDefinitionNode => ({ id, type, x: 0, y: 0, params, inputs: {} });

describe("agent workflow budget integration", () => {
  it("ignores a strict profile on an untaken branch and enforces the active invocation", async () => {
    const active = makeHarnessRuntime(
      "active",
      "generic_agent",
      {
        limits: {
          maxDurationMs: 20_000,
          maxTokens: 100,
          maxCostUsd: 2,
        },
        workspaceMode: "none",
      },
    );
    const inactive = makeHarnessRuntime(
      "inactive",
      "review_agent",
      {
        limits: {
          maxDurationMs: 1,
          maxTokens: 1,
          maxCostUsd: 0.01,
        },
      },
    );
    let clock = 0;
    const observeWorkflowBudget = vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 60_000,
      durationLimitMs: 60_000,
      activeElapsedMs: 0,
    });
    const budget = await createHarnessInvocationBudget({
      workflowLimits: {
        maxDurationMs: 60_000,
        maxTokens: 1_000,
        maxCostUsd: 10,
      },
      runtime: active,
      observeWorkflowBudget,
      readClock: async () => clock,
      priceLookup: () => ({
        input: 0.001,
        cached_input: 0.0001,
        output: 0.002,
      }),
    });

    expect(budget.limits).toEqual({
      maxDurationMs: 20_000,
      maxDurationSource: "profile",
      maxDurationProfileName: "Claude",
      maxTokens: 100,
      maxCostUsd: 2,
    });
    expect(inactive.manifest.limits.maxTokens).toBe(1);

    budget.recordUsage(
      {
        cost_usd: 0.5,
        tokens: { input: 80, cached_input: 10, output: 11 },
        duration_ms: 100,
        duration_api_ms: 90,
        num_turns: 1,
      },
      active.manifest.model.id,
    );
    clock = 500;

    await expect(budget.observeBudget(false)).resolves.toMatchObject({
      check: {
        status: "budget_exceeded",
        metric: "tokens",
        limit: 100,
        consumed: 101,
      },
    });
    // The attribution travels to the workflow context too: it owns the clock,
    // so it is the one that has to know which total to charge.
    expect(observeWorkflowBudget).toHaveBeenCalledWith(false, "duration");
  });

  it("reports invocation time when a strict profile expires after more run time", async () => {
    const active = makeHarnessRuntime("active", "generic_agent", {
      limits: {
        maxDurationMs: 600_000,
        maxTokens: null,
        maxCostUsd: null,
      },
    });
    let clock = 0;
    const observeWorkflowBudget = vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 300_000,
      durationLimitMs: 1_800_000,
      activeElapsedMs: 1_500_000,
      maxDurationSource: "definition",
    });
    const budget = await createHarnessInvocationBudget({
      workflowLimits: {
        maxDurationMs: 1_800_000,
        maxDurationSource: "definition",
      },
      runtime: active,
      observeWorkflowBudget,
      readClock: () => Promise.resolve(clock),
    });

    clock = 725_999;

    await expect(budget.observeBudget(false)).resolves.toMatchObject({
      check: {
        status: "budget_exceeded",
        metric: "duration",
        limit: 600_000,
        consumed: 725_999,
        reason:
          "budget_exceeded: this invocation took 12 min 5 s, over the 10 min limit from " +
          "the harness profile \"Claude\" (runtimeLimits.maxDurationMs). " +
          "Raise that limit on the profile to allow longer invocations.",
      },
    });
  });

  it.each(["env", "definition"] as const)(
    "keeps the %s workflow duration source when the profile is not tighter",
    async (maxDurationSource) => {
      const active = makeHarnessRuntime("active", "generic_agent", {
        limits: {
          maxDurationMs: 600_000,
          maxTokens: null,
          maxCostUsd: null,
        },
      });
      const budget = await createHarnessInvocationBudget({
        workflowLimits: {
          maxDurationMs: 600_000,
          maxDurationSource,
        },
        runtime: active,
        observeWorkflowBudget: vi.fn(),
        readClock: () => Promise.resolve(0),
      });

      expect(budget.limits).toEqual({
        maxDurationMs: 600_000,
        maxDurationSource,
      });
    },
  );

  it("blames a run-level failure on the only block in flight, and the engine otherwise", () => {
    // One block in flight: it owns the failure, which is the serial behaviour.
    expect(soleActiveBlockId(new Set(["security-review"]))).toBe(
      "security-review",
    );
    // Nothing in flight: the engine owns it.
    expect(soleActiveBlockId(new Set())).toBeNull();
    // Several in flight: no honest answer, so the engine owns it rather than
    // whichever sibling was inserted last. Both orders must agree, because
    // insertion order under concurrency is a wall-clock accident.
    expect(
      soleActiveBlockId(new Set(["security-review", "quality-review"])),
    ).toBeNull();
    expect(
      soleActiveBlockId(new Set(["quality-review", "security-review"])),
    ).toBeNull();
  });

  it("keeps workflow block status state summary-only", () => {
    expect(
      blockRunStateSummary({
        status: "ok",
        attempt: 2,
        output: { status: "ok", body: "runtime data" },
      }),
    ).toEqual({ status: "ok", attempt: 2 });
  });

  it("prefetches prices for codex agents and every Call LLM model", () => {
    const models = modelsRequiringPriceLookup(
      [
        node("agent", "generic_agent", {
          prompt: "work",
          provider: "codex",
          model: "gpt-agent",
        }),
        node("llm-codex", "call_llm", {
          prompt: "summarize",
          provider: "codex",
          model: "gpt-summary",
        }),
        node("llm-unresolved", "call_llm", { prompt: "summarize", model: "claude-haiku" }),
        node("llm-claude", "call_llm", {
          prompt: "summarize",
          provider: "claude",
          model: "claude-fast",
        }),
        node("llm-default", "call_llm", { prompt: "classify" }),
      ],
      "codex",
      { claude: "claude-default", codex: "codex-default" },
    );

    // "llm-unresolved" states a model and no provider. It is priceable by model
    // id, so dropping it from the prefetch is what would make it unpriceable.
    expect(models).toEqual(
      new Set([
        "gpt-agent",
        "gpt-summary",
        "claude-haiku",
        "claude-fast",
        "codex-default",
      ]),
    );
  });

  it("fails a configured cost budget before a required unpriced model can launch", () => {
    const prices = new Map([
      ["gpt-priced", { input: 0.001, cached_input: 0.0001, output: 0.002 }],
    ]);

    expect(
      missingRequiredPriceFailure(
        2,
        new Set(["gpt-unpriced", "gpt-priced"]),
        prices,
      ),
    ).toEqual({
      status: "budget_unverifiable",
      metric: "cost",
      limit: 2,
      consumed: null,
      reason: "budget_unverifiable: pricing is unavailable for required model gpt-unpriced",
    });
    expect(missingRequiredPriceFailure(undefined, new Set(["gpt-unpriced"]), prices)).toBeNull();
    expect(missingRequiredPriceFailure(2, new Set(["gpt-priced"]), prices)).toBeNull();
  });

  it("marks and records every pre-PR fix cycle, failing closed on missing usage", () => {
    const knownUsage: PhaseUsage = {
      cost_usd: null,
      tokens: { input: 10, cached_input: 2, output: 3 },
      duration_ms: 100,
      duration_api_ms: 90,
      num_turns: 1,
    };
    const markLaunched = vi.fn();
    let budgetState = createRunBudgetState();
    const recordUsage = vi.fn((_label: string, usage: PhaseUsage | null) => {
      budgetState = recordBudgetUsage(budgetState, usage, {
        kind: "codex",
        price: { input: 0.001, cached_input: 0.0001, output: 0.002 },
      });
    });

    recordPrePrFixCycleUsages(
      { markLaunched, recordUsage },
      [knownUsage, null],
      "codex",
      "gpt-5",
    );

    expect(markLaunched.mock.calls).toEqual([
      ["Pre-PR Fix 1"],
      ["Pre-PR Fix 2"],
    ]);
    expect(recordUsage.mock.calls).toEqual([
      ["Pre-PR Fix 1", knownUsage, "codex", "gpt-5"],
      ["Pre-PR Fix 2", null, "codex", "gpt-5"],
    ]);
    expect(checkRunBudget(budgetState, { maxDurationMs: 1_000, maxTokens: 1_000 })).toMatchObject({
      status: "budget_unverifiable",
      metric: "tokens",
    });
  });

  it("records the completed pre-PR fix usage before throwing its structured budget failure", () => {
    const usage: PhaseUsage = {
      cost_usd: 0.5,
      tokens: { input: 10, cached_input: 0, output: 5 },
      duration_ms: 100,
      duration_api_ms: 90,
      num_turns: 1,
    };
    const markLaunched = vi.fn();
    const recordUsage = vi.fn();
    const failure = {
      status: "budget_exceeded" as const,
      metric: "tokens" as const,
      limit: 14,
      consumed: 15,
      reason: "budget_exceeded: tokens 15 exceeds limit 14",
    };

    expect(() =>
      recordPrePrFixCycleUsages(
        { markLaunched, recordUsage },
        [usage],
        "codex",
        "gpt-5",
        failure,
      ),
    ).toThrowError(expect.objectContaining({ name: "RunBudgetError", failure }));
    expect(recordUsage).toHaveBeenCalledWith(
      "Pre-PR Fix 1",
      usage,
      "codex",
      "gpt-5",
    );
  });
});
