import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import type { PhaseUsage } from "../sandbox/agents/types.js";
import {
  createHarnessInvocationBudget,
  modelsRequiringPriceLookup,
  modelsRequiringPriceLookupForRun,
  recordPrePrFixCycleUsages,
  shouldReconcilePhaseUsageOnBlockFinish,
} from "./agent.js";
import { buildRuntimeGraph } from "../workflow-definition/interpreter.js";
import {
  checkRunBudget,
  createRunBudgetState,
  missingRequiredPriceFailure,
  recordBudgetUsage,
} from "./run-budget.js";
import { makeHarnessRuntime } from "./blocks/test-support.js";

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
    expect(observeWorkflowBudget).toHaveBeenCalledWith(false);
  });

  it("does not reconcile still-running sibling usage on v2 block finishes", () => {
    expect(shouldReconcilePhaseUsageOnBlockFinish(1)).toBe(true);
    expect(shouldReconcilePhaseUsageOnBlockFinish(2)).toBe(false);
  });

  it("prefetches prices for codex agents and every Call LLM model", () => {
    const models = modelsRequiringPriceLookup(
      [
        node("agent", "generic_agent", {
          prompt: "work",
          provider: "codex",
          model: "gpt-agent",
        }),
        node("llm-explicit", "call_llm", { prompt: "summarize", model: "claude-haiku" }),
        node("llm-default", "call_llm", { prompt: "classify" }),
      ],
      "codex",
      { claude: "claude-default", codex: "codex-default" },
    );

    expect(models).toEqual(new Set(["gpt-agent", "claude-haiku", "codex-default"]));
  });

  it("prices only nodes reachable from the selected trigger", () => {
    const ticketTrigger = node("ticket", "trigger_ticket_ai", {});
    const prTrigger = node("pr", "trigger_pr_review", {});
    const ticketAgent = node("ticket-agent", "generic_agent", {
      prompt: "implement",
      provider: "codex",
      model: "gpt-ticket-only",
    });
    const prComment = node("pr-comment", "post_pr_comment", { body: "review received" });
    const graph = buildRuntimeGraph({
      nodes: [ticketTrigger, prTrigger, ticketAgent, prComment],
      edges: [
        { from: "ticket", to: "ticket-agent" },
        { from: "pr", to: "pr-comment" },
      ],
    });

    expect(
      modelsRequiringPriceLookupForRun(
        graph,
        "pr",
        "codex",
        { claude: "claude-default", codex: "codex-default" },
      ),
    ).toEqual(new Set());
  });

  it("prices the default Codex model only for reachable compatibility blocks that can launch it", () => {
    const trigger = node("ticket", "trigger_ticket_ai", {});
    const finalize = node("finalize", "finalize_workspace", {});
    const graph = buildRuntimeGraph({
      nodes: [trigger, finalize],
      edges: [{ from: "ticket", to: "finalize" }],
    });

    expect(
      modelsRequiringPriceLookupForRun(
        graph,
        "ticket",
        "codex",
        { claude: "claude-default", codex: "codex-default" },
      ),
    ).toEqual(new Set(["codex-default"]));
  });

  it("does not price the run default when a different implementation model replaces it on every path", () => {
    const trigger = node("ticket", "trigger_ticket_ai", {});
    const implementation = node("implementation", "implementation_agent", {
      provider: "claude",
      model: "claude-implementation",
    });
    const checks = node("checks", "run_pre_pr_checks", {});
    const graph = buildRuntimeGraph({
      nodes: [trigger, implementation, checks],
      edges: [
        { from: "ticket", to: "implementation" },
        { from: "implementation", to: "checks" },
      ],
    });

    expect(
      modelsRequiringPriceLookupForRun(
        graph,
        "ticket",
        "codex",
        { claude: "claude-default", codex: "codex-default" },
      ),
    ).toEqual(new Set());
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
        input: 0.001,
        cached_input: 0.0001,
        output: 0.002,
      });
    });

    recordPrePrFixCycleUsages(
      { markLaunched, recordUsage },
      [knownUsage, null],
      "gpt-5",
    );

    expect(markLaunched.mock.calls).toEqual([
      ["Pre-PR Fix 1"],
      ["Pre-PR Fix 2"],
    ]);
    expect(recordUsage.mock.calls).toEqual([
      ["Pre-PR Fix 1", knownUsage, "gpt-5"],
      ["Pre-PR Fix 2", null, "gpt-5"],
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
        "gpt-5",
        failure,
      ),
    ).toThrowError(expect.objectContaining({ name: "RunBudgetError", failure }));
    expect(recordUsage).toHaveBeenCalledWith("Pre-PR Fix 1", usage, "gpt-5");
  });
});
