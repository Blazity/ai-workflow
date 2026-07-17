import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildRuntimeGraph,
  executeGraph,
  type BlockExecutionResult,
  type BlockExecutor,
  type ExecuteGraphHooks,
} from "../workflow-definition/interpreter.js";
import { recordBlockStatuses, recordRunUsage } from "../lib/telemetry/run-telemetry.js";
import { entryOwnsClarificationThread } from "./agent.js";
import { computeUsageTotals, type PhaseUsage, type PriceLookup } from "../sandbox/usage.js";
import { createTestDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { isTriggerBlockType } from "@shared/contracts";
import type {
  BlockOutput,
  BlockRunState,
  WorkflowBlockType,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  RunBudgetError,
  checkRunBudget,
  createRunBudgetState,
  recordBudgetUsage,
  type RunBudgetFailure,
  type RunBudgetLimits,
} from "./run-budget.js";

/**
 * Integration target (B): one layer above interpreter.test.ts. It drives the
 * REAL interpreter (buildRuntimeGraph + executeGraph) through production-shaped
 * hooks that call the REAL telemetry writers (recordBlockStatuses,
 * recordRunUsage + computeUsageTotals) against a REAL pglite database.
 *
 * We chose B over A (running agentWorkflow itself) because agentWorkflow is a
 * "use workflow" function bound to the Workflow DevKit runtime, and its inline
 * agent-phase cases provision @vercel/sandbox, poll via sleep, and reach the
 * live Jira/GitHub/Slack adapters + Neon getDb — none of which can be faked
 * cleanly or deterministically. The harness below reproduces exactly the wiring
 * agentWorkflow builds around executeGraph (see apps/worker/src/workflows/
 * agent.ts): the pending-seeded block-status map, writeBlockStatuses, the
 * onBlockStart/onBlockFinish hooks, the runOutcome transitions, and the
 * always-run recordRunUsage finally. The only fakes are the scripted
 * executeBlock and the usage/model/PR values a real agent block would push into
 * phaseUsages/phaseModels/activeModel/prForTelemetry. Everything on the
 * persistence path is unmodified production code writing to pglite.
 */

function node(
  id: string,
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue> = {},
  name?: string,
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params, inputs: {}, name };
}

/** Claude-shaped phase usage: cost reported directly, tokens also present. */
function claudeUsage(costUsd: number, durationMs = 60_000): PhaseUsage {
  return {
    cost_usd: costUsd,
    tokens: { input: 1000, cached_input: 200, output: 500 },
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    num_turns: 3,
  };
}

/** Per-node script standing in for what a real block executor would do. */
interface NodeScript {
  result: BlockExecutionResult;
  onExecute?: () => void;
  /** Usage the block records, mirroring ctx.recordUsage in agent.ts. */
  usage?: { phase: string; usage: PhaseUsage | null; model: string };
  /** Run headline model, mirroring activeModel set by prepare/impl blocks. */
  activeModel?: string;
  /** PR captured by open_pr, mirroring prForTelemetry. */
  pr?: { url: string; number: number };
}

interface RunFixture {
  runId: string;
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
  entryTriggerType: WorkflowBlockType;
  scripts?: Record<string, NodeScript>;
  priceLookup?: PriceLookup;
  budgetLimits?: RunBudgetLimits;
}

interface RunResult {
  outcome: "completed" | "stopped" | "ended";
  runOutcome: "success" | "failed" | "awaiting";
  /** block_statuses read back from the DB after every persisted write. */
  persistedSnapshots: Array<Record<string, BlockRunState>>;
}

const TICKET = {
  identifier: "PROJ-1",
  title: "Add login",
  url: "https://jira/browse/PROJ-1",
};
const DEFINITION_ID = 7;
const DEFINITION_VERSION = 3;

/**
 * Runs a workflow definition against pglite through the same seam agent.ts uses,
 * returning the walk outcome, the run's own terminal status, and the sequence of
 * block-status snapshots that actually landed in the DB.
 */
async function runWorkflowAgainstDb(db: Db, fx: RunFixture): Promise<RunResult> {
  const scripts = fx.scripts ?? {};

  const graph = buildRuntimeGraph({ nodes: fx.nodes, edges: fx.edges });
  const entryTrigger = fx.nodes.find((n) => n.type === fx.entryTriggerType);
  if (!entryTrigger) throw new Error("fixture has no entry trigger");

  // Seed exactly like agent.ts: every non-trigger node starts pending.
  const blockStatuses: Record<string, BlockRunState> = Object.fromEntries(
    fx.nodes
      .filter((n) => !isTriggerBlockType(n.type))
      .map((n): [string, BlockRunState] => [n.id, { status: "pending" }]),
  );

  const persistedSnapshots: Array<Record<string, BlockRunState>> = [];
  const writeBlockStatuses = async () => {
    // REAL persistence: what recordBlockStatusesStep does, minus the DevKit step.
    await recordBlockStatuses(db, {
      runId: fx.runId,
      subjectKey: `ticket:jira:${TICKET.identifier}`,
      ticketKey: TICKET.identifier,
      ticketTitle: TICKET.title,
      ticketUrl: TICKET.url,
      definitionVersion: DEFINITION_VERSION,
      definitionId: DEFINITION_ID,
      blockStatuses: { ...blockStatuses },
    });
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, fx.runId));
    persistedSnapshots.push(
      (rows[0]?.blockStatuses ?? {}) as Record<string, BlockRunState>,
    );
  };
  await writeBlockStatuses();

  // Usage accumulation, mirroring the real ctx captures.
  const phaseUsages: Record<string, PhaseUsage | null> = {};
  const phaseModels: Record<string, string> = {};
  let budgetState = createRunBudgetState();
  let budgetFailure: RunBudgetFailure | null = null;
  let currentBlockId: string | null = null;
  // Holder object so closure mutations survive TS control-flow narrowing
  // (mirrors the `state` holder agent.ts uses for the same reason).
  const captured: {
    activeModel: string | undefined;
    pr: { url: string; number: number } | null;
  } = { activeModel: undefined, pr: null };
  let runOutcome: "success" | "failed" | "awaiting" = "failed";

  const executeBlock: BlockExecutor = async (blockNode) => {
    const script = scripts[blockNode.id];
    script?.onExecute?.();
    if (script?.usage) {
      phaseUsages[script.usage.phase] = script.usage.usage;
      phaseModels[script.usage.phase] = script.usage.model;
      budgetState = recordBudgetUsage(
        budgetState,
        script.usage.usage,
        fx.priceLookup?.(script.usage.model) ?? null,
      );
    }
    if (script?.activeModel) captured.activeModel = script.activeModel;
    if (script?.pr) captured.pr = script.pr;
    return script?.result ?? { kind: "next", output: { status: "ok" } };
  };

  const hooks: ExecuteGraphHooks = {
    async onBlockStart(nodeId, attempt) {
      currentBlockId = nodeId;
      blockStatuses[nodeId] = { status: "running", attempt };
      await writeBlockStatuses();
    },
    async onBlockFinish(nodeId, state) {
      if (fx.budgetLimits) {
        const check = checkRunBudget(budgetState, fx.budgetLimits);
        if (check.status !== "ok") throw new RunBudgetError(check);
      }
      let guarded = state;
      if (state.output && JSON.stringify(state.output).length > 8192) {
        guarded = { ...state, output: { status: state.output.status, _truncated: true } };
      }
      blockStatuses[nodeId] = guarded;
      await writeBlockStatuses();
    },
    // A clarification parks the run: awaiting, not success. The answer endpoint
    // (or re-pickup housekeeping) flips it to success later.
    async clarificationExit() {
      runOutcome = "awaiting";
    },
    // failureExit leaves runOutcome at its default "failed".
    async failureExit() {},
    async terminate(params) {
      runOutcome =
        params.terminalStatus === "failed"
          ? "failed"
          : params.terminalStatus === "waiting_for_human"
            ? "awaiting"
            : "success";
    },
  };

  const triggerOutput: BlockOutput = { status: "fired", ticketKey: TICKET.identifier };

  let outcome: "completed" | "stopped" | "ended" = "stopped";
  try {
    const walk = await executeGraph({
      graph,
      entryTriggerId: entryTrigger.id,
      triggerOutput,
      executeBlock,
      hooks,
      maxTotalExecutions: 200,
    });
    outcome = walk.outcome;
    // Mirror agent.ts: never promote a clarification park (awaiting) to success.
    // `as string` because TS narrows runOutcome to its "failed" initializer (it
    // can't see the hook closures writing it).
    if (
      (walk.outcome === "completed" || walk.outcome === "ended") &&
      (runOutcome as string) !== "awaiting"
    ) {
      runOutcome = "success";
    }
  } catch (err) {
    if (err instanceof RunBudgetError) budgetFailure = err.failure;
    if (currentBlockId) {
      blockStatuses[currentBlockId] = {
        status: "fail",
        error: err instanceof Error ? err.message : String(err),
      };
      await writeBlockStatuses();
    }
    throw err;
  } finally {
    // REAL run telemetry, recorded on every exit path (agent.ts outer finally).
    const totals = computeUsageTotals(phaseUsages, fx.priceLookup, captured.activeModel, phaseModels);
    await recordRunUsage(db, {
      runId: fx.runId,
      subjectKey: `ticket:jira:${TICKET.identifier}`,
      workflowId: "wf_agent",
      workflowName: "Agent",
      status: runOutcome,
      ticketKey: TICKET.identifier,
      ticketTitle: TICKET.title,
      ticketUrl: TICKET.url,
      model: captured.activeModel ?? null,
      costUsd: totals.costUsd,
      costKnown: totals.costKnown,
      tokensInput: totals.tokensInput,
      tokensCached: totals.tokensCached,
      tokensOutput: totals.tokensOutput,
      phases: totals.phases,
      steps: null,
      prUrl: captured.pr?.url ?? null,
      prNumber: captured.pr?.number ?? null,
      budgetFailure,
    } as Parameters<typeof recordRunUsage>[1]);
  }

  return { outcome, runOutcome, persistedSnapshots };
}

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const runRow = (runId: string) =>
  db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .then((r) => r[0]);

describe("re-pickup clarification housekeeping gate", () => {
  // The housekeeping (label strip, pending supersede, awaiting flip) only runs
  // for entry kinds that own the ticket's main work thread. A pr_trigger /
  // plan_approved follow-up must skip it so it can't strand a live pending
  // question or flip the parked asking run to success.
  it("runs only for ticket and clarification_answered pickups", () => {
    expect(entryOwnsClarificationThread("ticket")).toBe(true);
    expect(entryOwnsClarificationThread("clarification_answered")).toBe(true);
    expect(entryOwnsClarificationThread("pr_trigger")).toBe(false);
    expect(entryOwnsClarificationThread("plan_approved")).toBe(false);
  });
});

describe("run telemetry integration (executeGraph -> pglite)", () => {
  it("happy multi-block run: all blocks ok, run success, cost + model persisted", async () => {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("prep", "prepare_workspace"),
      node("plan", "planning_agent"),
      node("impl", "implementation_agent"),
      node("pr", "open_pr"),
      node("status", "update_ticket_status"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "prep" },
      { from: "prep", to: "plan" },
      { from: "plan", to: "impl" },
      { from: "impl", to: "pr" },
      { from: "pr", to: "status" },
    ];

    const result = await runWorkflowAgainstDb(db, {
      runId: "wrun_happy",
      nodes,
      edges,
      entryTriggerType: "trigger_ticket_ai",
      scripts: {
        prep: { result: { kind: "next", output: { status: "ok" } }, activeModel: "claude-default" },
        plan: {
          result: { kind: "next", output: { status: "ready" } },
          usage: { phase: "Research", usage: claudeUsage(0.5), model: "claude-opus" },
        },
        impl: {
          result: { kind: "next", output: { status: "implemented" } },
          usage: { phase: "Impl", usage: claudeUsage(1.0), model: "claude-sonnet" },
          activeModel: "claude-sonnet",
        },
        pr: {
          result: { kind: "next", output: { status: "ok", prNumber: 7 } },
          pr: { url: "https://github.com/o/r/pull/7", number: 7 },
        },
      },
    });

    expect(result.outcome).toBe("completed");
    expect(result.runOutcome).toBe("success");

    // The first persisted write is the pending seed for every non-trigger node.
    expect(result.persistedSnapshots[0]).toEqual({
      prep: { status: "pending" },
      plan: { status: "pending" },
      impl: { status: "pending" },
      pr: { status: "pending" },
      status: { status: "pending" },
    });

    // Progression is really persisted: at least one snapshot shows each node
    // running, and a later one shows it ok.
    for (const id of ["prep", "plan", "impl", "pr", "status"]) {
      expect(result.persistedSnapshots.some((s) => s[id]?.status === "running")).toBe(true);
      expect(result.persistedSnapshots.some((s) => s[id]?.status === "ok")).toBe(true);
    }

    // Terminal block statuses in the DB: every node ok.
    const r = await runRow("wrun_happy");
    expect(r.blockStatuses).toEqual({
      prep: { status: "ok", attempt: 1, output: { status: "ok" } },
      plan: { status: "ok", attempt: 1, output: { status: "ready" } },
      impl: { status: "ok", attempt: 1, output: { status: "implemented" } },
      pr: { status: "ok", attempt: 1, output: { status: "ok", prNumber: 7 } },
      status: { status: "ok", attempt: 1, output: { status: "ok" } },
    });

    // Run row: authoritative success + cost/model/token/phase telemetry.
    expect(r.status).toBe("success");
    expect(r.workflowId).toBe("wf_agent");
    expect(r.workflowName).toBe("Agent");
    expect(r.model).toBe("claude-sonnet");
    expect(r.costUsd).toBeCloseTo(1.5);
    expect(r.costKnown).toBe(true);
    expect(r.tokensInput).toBe(2000);
    expect(r.tokensCached).toBe(400);
    expect(r.tokensOutput).toBe(1000);
    expect(Object.keys(r.phases as Record<string, unknown>).sort()).toEqual(["Impl", "Research"]);
    expect(r.prNumber).toBe(7);
    expect(r.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(r.definitionId).toBe(DEFINITION_ID);
    expect(r.definitionVersion).toBe(DEFINITION_VERSION);
    expect(r.completedAt).not.toBeNull();
  });

  it("needs_human_input block: warn persisted, downstream stays pending, run recorded as awaiting with cost", async () => {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("prep", "prepare_workspace"),
      node("plan", "planning_agent"),
      node("impl", "implementation_agent"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "prep" },
      { from: "prep", to: "plan" },
      { from: "plan", to: "impl" },
    ];

    const result = await runWorkflowAgainstDb(db, {
      runId: "wrun_clarify",
      nodes,
      edges,
      entryTriggerType: "trigger_ticket_ai",
      scripts: {
        prep: { result: { kind: "next", output: { status: "ok" } }, activeModel: "claude-default" },
        plan: {
          result: {
            kind: "needs_human_input",
            output: { status: "needs_human_input" },
            questions: ["Which auth provider?", "Do we support SSO?"],
          },
          usage: { phase: "Research", usage: claudeUsage(0.5), model: "claude-opus" },
        },
      },
    });

    expect(result.outcome).toBe("stopped");
    expect(result.runOutcome).toBe("awaiting");

    const r = await runRow("wrun_clarify");
    expect(r.blockStatuses).toEqual({
      prep: { status: "ok", attempt: 1, output: { status: "ok" } },
      plan: {
        status: "warn",
        attempt: 1,
        output: { status: "needs_human_input" },
        error: "Which auth provider?; Do we support SSO?",
      },
      // never reached
      impl: { status: "pending" },
    });

    // Clarification parks the run (awaiting, not success), and cost is still recorded.
    expect(r.status).toBe("awaiting");
    expect(r.model).toBe("claude-default");
    expect(r.costUsd).toBeCloseTo(0.5);
    expect(r.costKnown).toBe(true);
    expect(r.tokensInput).toBe(1000);
    expect(Object.keys(r.phases as Record<string, unknown>)).toEqual(["Research"]);
    expect(r.prNumber).toBeNull();
  });

  it("terminate waiting_for_human parks the run: awaiting persists to the run row, not clobbered to success", async () => {
    // A terminate(waiting_for_human) node sets runOutcome = awaiting. The walk
    // returns "stopped", so the post-walk success promotion is skipped, and the
    // guard (runOutcome !== "awaiting") is the belt-and-suspenders that keeps a
    // completed/ended walk from ever overriding awaiting.
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("prep", "prepare_workspace"),
      node("wait", "terminate", { terminalStatus: "waiting_for_human", postComment: "Need input" }),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "prep" },
      { from: "prep", to: "wait" },
    ];

    const result = await runWorkflowAgainstDb(db, {
      runId: "wrun_wait",
      nodes,
      edges,
      entryTriggerType: "trigger_ticket_ai",
      scripts: {
        prep: { result: { kind: "next", output: { status: "ok" } }, activeModel: "claude-default" },
      },
    });

    expect(result.outcome).toBe("stopped");
    expect(result.runOutcome).toBe("awaiting");
    expect((await runRow("wrun_wait")).status).toBe("awaiting");
  });

  it("failed block with no failure edge: fail persisted, run recorded as failed, cost still captured", async () => {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("prep", "prepare_workspace"),
      node("plan", "planning_agent"),
      node("impl", "implementation_agent"),
      node("pr", "open_pr"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "prep" },
      { from: "prep", to: "plan" },
      { from: "plan", to: "impl" },
      { from: "impl", to: "pr" },
    ];

    const result = await runWorkflowAgainstDb(db, {
      runId: "wrun_fail",
      nodes,
      edges,
      entryTriggerType: "trigger_ticket_ai",
      scripts: {
        prep: { result: { kind: "next", output: { status: "ok" } }, activeModel: "claude-default" },
        plan: {
          result: { kind: "next", output: { status: "ready" } },
          usage: { phase: "Research", usage: claudeUsage(0.5), model: "claude-opus" },
        },
        impl: {
          result: {
            kind: "failed",
            output: { status: "failed" },
            reason: "impl blew up",
            phase: "impl",
          },
          usage: { phase: "Impl", usage: claudeUsage(1.0), model: "claude-sonnet" },
          activeModel: "claude-sonnet",
        },
      },
    });

    expect(result.outcome).toBe("stopped");
    expect(result.runOutcome).toBe("failed");

    const r = await runRow("wrun_fail");
    const persisted = r.blockStatuses as Record<string, BlockRunState>;
    expect(persisted.prep.status).toBe("ok");
    expect(persisted.plan.status).toBe("ok");
    expect(persisted.impl.status).toBe("fail");
    expect(persisted.impl.error).toBe("impl blew up");
    expect(persisted.pr).toEqual({ status: "pending" });

    // Run is failed, yet cost/usage from the phases that ran is still recorded.
    expect(r.status).toBe("failed");
    expect(r.model).toBe("claude-sonnet");
    expect(r.costUsd).toBeCloseTo(1.5);
    expect(r.costKnown).toBe(true);
    expect(r.tokensInput).toBe(2000);
    expect(r.prNumber).toBeNull();
    expect(r.completedAt).not.toBeNull();
  });

  it("failed block routed through a wired failure edge: fail persisted but run completes as success", async () => {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("prep", "prepare_workspace"),
      node("checks", "run_pre_pr_checks"),
      node("recover", "send_slack_message"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "prep" },
      { from: "prep", to: "checks" },
      { from: "checks", to: "recover", fromPort: "failed" },
    ];

    const result = await runWorkflowAgainstDb(db, {
      runId: "wrun_recover",
      nodes,
      edges,
      entryTriggerType: "trigger_ticket_ai",
      scripts: {
        prep: { result: { kind: "next", output: { status: "ok" } }, activeModel: "claude-default" },
        checks: {
          result: {
            kind: "failed",
            output: { status: "failed" },
            reason: "lint broke",
            phase: "checks",
          },
        },
        recover: { result: { kind: "next", output: { status: "ok" } } },
      },
    });

    expect(result.outcome).toBe("completed");
    expect(result.runOutcome).toBe("success");

    const r = await runRow("wrun_recover");
    const persisted = r.blockStatuses as Record<string, BlockRunState>;
    expect(persisted.prep.status).toBe("ok");
    expect(persisted.checks.status).toBe("fail");
    expect(persisted.checks.error).toBe("lint broke");
    expect(persisted.recover.status).toBe("ok");

    // A recovered failure edge leaves the run itself successful.
    expect(r.status).toBe("success");
  });

  it("persists a budget failure and never executes the downstream side effect", async () => {
    let downstreamExecuted = false;
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("llm", "call_llm", { prompt: "summarize" }),
      node("comment", "post_ticket_comment", { body: "should not post" }),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "llm" },
      { from: "llm", to: "comment" },
    ];

    await expect(
      runWorkflowAgainstDb(db, {
        runId: "wrun_budget",
        nodes,
        edges,
        entryTriggerType: "trigger_ticket_ai",
        budgetLimits: { maxDurationMs: 60_000, maxTokens: 1_699 },
        scripts: {
          llm: {
            result: { kind: "next", output: { status: "ok" } },
            usage: { phase: "LLM llm", usage: claudeUsage(0.1), model: "claude-haiku" },
          },
          comment: {
            result: { kind: "next", output: { status: "ok" } },
            onExecute: () => {
              downstreamExecuted = true;
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: { status: "budget_exceeded", metric: "tokens", consumed: 1_700, limit: 1_699 },
    });

    expect(downstreamExecuted).toBe(false);
    const row = await runRow("wrun_budget");
    expect(row.status).toBe("failed");
    expect(row.tokensInput).toBe(1_000);
    expect(
      (row as unknown as { budgetFailure: unknown }).budgetFailure,
    ).toEqual({
      status: "budget_exceeded",
      metric: "tokens",
      limit: 1_699,
      consumed: 1_700,
      reason: "budget_exceeded: tokens 1700 exceeds limit 1699",
    });
    expect(row.blockStatuses).toMatchObject({
      llm: { status: "fail", error: expect.stringContaining("budget_exceeded") },
      comment: { status: "pending" },
    });
  });

  it("persists budget_unverifiable when configured cost cannot be priced", async () => {
    let downstreamExecuted = false;
    const unknownCostUsage: PhaseUsage = {
      ...claudeUsage(0.1),
      cost_usd: null,
    };
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("llm", "call_llm", { prompt: "summarize" }),
      node("comment", "post_ticket_comment", { body: "should not post" }),
    ];

    await expect(
      runWorkflowAgainstDb(db, {
        runId: "wrun_budget_unknown",
        nodes,
        edges: [
          { from: "trig", to: "llm" },
          { from: "llm", to: "comment" },
        ],
        entryTriggerType: "trigger_ticket_ai",
        budgetLimits: { maxDurationMs: 60_000, maxCostUsd: 2 },
        scripts: {
          llm: {
            result: { kind: "next", output: { status: "ok" } },
            usage: { phase: "LLM llm", usage: unknownCostUsage, model: "unpriced-model" },
          },
          comment: {
            result: { kind: "next", output: { status: "ok" } },
            onExecute: () => {
              downstreamExecuted = true;
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: { status: "budget_unverifiable", metric: "cost" },
    });

    expect(downstreamExecuted).toBe(false);
    const row = await runRow("wrun_budget_unknown");
    expect(row.status).toBe("failed");
    expect(
      (row as unknown as { budgetFailure: unknown }).budgetFailure,
    ).toEqual({
      status: "budget_unverifiable",
      metric: "cost",
      limit: 2,
      consumed: null,
      reason: "budget_unverifiable: cost usage or pricing is unavailable",
    });
    expect(row.blockStatuses).toMatchObject({
      llm: { status: "fail", error: expect.stringContaining("budget_unverifiable") },
      comment: { status: "pending" },
    });
  });

  it("persists null token totals when a launched phase has unknown usage", async () => {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("llm", "call_llm", { prompt: "summarize" }),
    ];

    await expect(
      runWorkflowAgainstDb(db, {
        runId: "wrun_budget_unknown_tokens",
        nodes,
        edges: [{ from: "trig", to: "llm" }],
        entryTriggerType: "trigger_ticket_ai",
        budgetLimits: { maxDurationMs: 60_000, maxTokens: 2_000 },
        scripts: {
          llm: {
            result: { kind: "next", output: { status: "ok" } },
            usage: { phase: "LLM llm", usage: null, model: "claude-haiku" },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: { status: "budget_unverifiable", metric: "tokens" },
    });

    const row = await runRow("wrun_budget_unknown_tokens");
    expect(row.tokensInput).toBeNull();
    expect(row.tokensCached).toBeNull();
    expect(row.tokensOutput).toBeNull();
  });
});
