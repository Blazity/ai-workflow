import { describe, expect, it } from "vitest";
import type {
  BlockOutput,
  BlockRunState,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  buildRuntimeGraph,
  executeGraph as executeGraphWithContractValidation,
  type BlockExecutionResult,
  type BlockExecutor,
  type ExecuteGraphHooks,
  type StepsRecord,
} from "./interpreter.js";

import {
  humanGateLoopDefinition,
  linearPipelineDefinition,
  planApprovalDefinition,
  prReviewFixDefinition,
} from "./graph-fixtures.js";
import { normalizeDefinitionForExecution } from "../workflows/definition-step.js";

type ExecuteGraphOptions = Parameters<typeof executeGraphWithContractValidation>[0];

function executeGraph(opts: ExecuteGraphOptions) {
  return executeGraphWithContractValidation({ ...opts, outputValidator: () => [] });
}

// Helpers reused verbatim from interpreter.test.ts.
interface Recorder {
  hooks: ExecuteGraphHooks;
  starts: Array<{ nodeId: string; attempt: number }>;
  finishes: Array<{ nodeId: string; state: BlockRunState }>;
  clarifications: Array<{ questions: string[]; nodeId: string }>;
  failures: Array<{ phase: string; reason: string; nodeId: string }>;
  terminations: Array<{
    params: { terminalStatus: string; postComment?: string };
    nodeId: string;
  }>;
}

function makeRecorder(): Recorder {
  const starts: Recorder["starts"] = [];
  const finishes: Recorder["finishes"] = [];
  const clarifications: Recorder["clarifications"] = [];
  const failures: Recorder["failures"] = [];
  const terminations: Recorder["terminations"] = [];
  const hooks: ExecuteGraphHooks = {
    async onBlockStart(nodeId, attempt) {
      starts.push({ nodeId, attempt });
    },
    async onBlockFinish(nodeId, state) {
      finishes.push({ nodeId, state });
    },
    async clarificationExit(questions, nodeId) {
      clarifications.push({ questions, nodeId });
    },
    async failureExit(phase, reason, nodeId) {
      failures.push({ phase, reason, nodeId });
    },
    async terminate(params, nodeId) {
      terminations.push({ params, nodeId });
    },
  };
  return { hooks, starts, finishes, clarifications, failures, terminations };
}

function makeExecutor(
  overrides: Record<string, BlockExecutionResult> = {},
  onCall?: (block: WorkflowDefinitionNode, steps: StepsRecord) => void,
): { executor: BlockExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: BlockExecutor = async (block, steps) => {
    calls.push(block.id);
    onCall?.(block, steps);
    return overrides[block.id] ?? defaultResult(block);
  };
  return { executor, calls };
}

const finishStatuses = (rec: Recorder, nodeId: string): string[] =>
  rec.finishes.filter((f) => f.nodeId === nodeId).map((f) => f.state.status);

const attemptsFor = (rec: Recorder, nodeId: string): number[] =>
  rec.starts.filter((s) => s.nodeId === nodeId).map((s) => s.attempt);

// Golden-run harness: mirror the production build path (agent.ts:687-1200).
// normalize -> build on the normalized arrays -> resolve entry trigger by TYPE
// (nodes.find, exactly as agent.ts:688) -> executeGraph.
async function runGolden(opts: {
  def: WorkflowDefinition;
  entryTriggerType: WorkflowBlockType;
  overrides?: Record<string, BlockExecutionResult>;
  triggerOutput?: BlockOutput;
  executor?: { executor: BlockExecutor; calls: string[] };
}) {
  const normalized = normalizeDefinitionForExecution(opts.def.nodes, opts.def.edges);
  const graph = buildRuntimeGraph({ nodes: normalized.nodes, edges: normalized.edges });
  const entry = normalized.nodes.find((n) => n.type === opts.entryTriggerType);
  if (!entry) throw new Error(`fixture has no ${opts.entryTriggerType} trigger`);
  const rec = makeRecorder();
  const exec = opts.executor ?? makeExecutor(opts.overrides ?? {});
  const ticket = {
    identifier: "AIW-1",
    title: "Golden run",
    description: "Typed trigger inputs",
    acceptanceCriteria: "The graph completes",
    labels: [],
    comments: [],
    priorAnswers: [],
  };
  const defaultTriggerOutput: BlockOutput = {
    status: "ok",
    ticket,
    comments: [],
    priorAnswers: [],
    ...(opts.entryTriggerType === "trigger_plan_approved"
      ? { approvedPlan: "Approved golden plan" }
      : {}),
  };
  const result = await executeGraph({
    graph,
    entryTriggerId: entry.id,
    triggerOutput: opts.triggerOutput ?? defaultTriggerOutput,
    executeBlock: exec.executor,
    hooks: rec.hooks,
  });
  return { result, calls: exec.calls, rec, normalized, graph, entryTriggerId: entry.id };
}

// Executor whose result varies by per-id call count (attempt).
function makeDynamicExecutor(
  fn: (block: WorkflowDefinitionNode, attempt: number) => BlockExecutionResult | undefined,
): { executor: BlockExecutor; calls: string[] } {
  const calls: string[] = [];
  const perId = new Map<string, number>();
  const executor: BlockExecutor = async (block) => {
    calls.push(block.id);
    const attempt = (perId.get(block.id) ?? 0) + 1;
    perId.set(block.id, attempt);
    return fn(block, attempt) ?? defaultResult(block);
  };
  return { executor, calls };
}

function defaultResult(block: WorkflowDefinitionNode): BlockExecutionResult {
  if (block.type === "planning_agent") {
    return { kind: "next", output: { status: "ready", plan: "Golden plan" } };
  }
  if (block.type === "finalize_workspace") {
    return {
      kind: "next",
      output: {
        status: "finalized",
        repositories: [],
      },
    };
  }
  return { kind: "next", output: { status: "ok", id: block.id } };
}

// Clone the humanGate fixture with overridden retry.params and optional extra edges.
function humanGateWithRetry(
  retryParams: Record<string, WorkflowParamValue>,
  extraEdges: WorkflowDefinitionEdge[] = [],
): WorkflowDefinition {
  const def = humanGateLoopDefinition();
  const nodes = def.nodes.map((n) =>
    n.id === "retry" ? { ...n, params: { ...n.params, ...retryParams } } : n,
  );
  return { ...def, nodes, edges: [...def.edges, ...extraEdges] };
}

const CHECKS_FAIL: BlockExecutionResult = { kind: "next", output: { status: "ok", ok: false } };
const CHECKS_PASS: BlockExecutionResult = { kind: "next", output: { status: "ok", ok: true } };

describe("golden runs: linear pipeline", () => {
  it("completes the authored full chain in visit order", async () => {
    const { result, calls, rec } = await runGolden({
      def: linearPipelineDefinition(),
      entryTriggerType: "trigger_ticket_ai",
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual([
      "planning",
      "implementation",
      "checks",
      "finalize",
      "open-pr",
      "slack",
      "status",
    ]);
    expect(rec.starts.map((s) => s.nodeId)).toEqual(calls);
    expect(rec.starts.every((s) => s.attempt === 1)).toBe(true);
    expect(rec.finishes.every((f) => f.state.status === "ok")).toBe(true);
    expect(Object.keys(result.steps).sort()).toEqual(
      ["trigger", "planning", "implementation", "checks", "finalize", "open-pr", "status", "slack"].sort(),
    );
  });

  it("visits planning first without injecting a virtual Prepare", async () => {
    const { calls, normalized } = await runGolden({
      def: linearPipelineDefinition(),
      entryTriggerType: "trigger_ticket_ai",
    });
    expect(calls[0]).toBe("planning");
    expect(normalized.nodes.some((node) => node.type === "prepare_workspace")).toBe(false);
  });

  it("does not execute the entry trigger but seeds it into steps with triggerOutput", async () => {
    const triggerOutput: BlockOutput = { status: "ok", ticket: "AI-1" };
    const { calls, rec, result } = await runGolden({
      def: linearPipelineDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      triggerOutput,
    });
    expect(calls).not.toContain("trigger");
    expect(rec.starts.some((s) => s.nodeId === "trigger")).toBe(false);
    expect(rec.starts[0].nodeId).toBe("planning");
    expect(result.steps.trigger.output).toBe(triggerOutput);
  });

  it("stops via failureExit when a mid-chain action fails with no wired failure edge", async () => {
    const { result, calls, rec } = await runGolden({
      def: linearPipelineDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: {
        implementation: {
          kind: "failed",
          output: { status: "failed" },
          reason: "boom",
          phase: "implementation",
        },
      },
    });
    expect(result.outcome).toBe("stopped");
    expect(calls).toEqual(["planning", "implementation"]);
    expect(rec.failures).toEqual([
      { phase: "implementation", reason: "boom", nodeId: "implementation" },
    ]);
    expect(finishStatuses(rec, "implementation")).toEqual(["fail"]);
  });
});

describe("golden runs: humanGate loop", () => {
  it("gate=true: needs_human_input planning routes to notify then terminate(waiting_for_human)", async () => {
    const { result, calls, rec } = await runGolden({
      def: humanGateLoopDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { planning: { kind: "next", output: { status: "needs_human_input" } } },
    });
    expect(result.outcome).toBe("stopped");
    expect(calls).toEqual(["planning", "notify"]);
    expect(result.steps.gate.output.path).toBe("true");
    expect(finishStatuses(rec, "halt")).toEqual(["warn"]);
    expect(rec.terminations).toEqual([
      { params: { terminalStatus: "waiting_for_human", postComment: undefined }, nodeId: "halt" },
    ]);
    expect(rec.failures).toEqual([]);
    expect(rec.clarifications).toEqual([
      { nodeId: "halt", questions: ["Waiting for human input."] },
    ]);
  });

  it("gate=false, verdict=true: checks pass on the first try and open-pr completes", async () => {
    const { result, calls, rec } = await runGolden({
      def: humanGateLoopDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { checks: CHECKS_PASS },
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["planning", "implementation", "checks", "finalize", "open-pr"]);
    expect(result.steps.gate.output.path).toBe("false");
    expect(result.steps.verdict.output.path).toBe("true");
    expect(calls).not.toContain("fix");
    expect(rec.starts.some((s) => s.nodeId === "retry")).toBe(false);
  });

  it("onExhaust=fail (fixture default): loops fix->checks 3x then fails via the loop", async () => {
    const { result, calls, rec } = await runGolden({
      def: humanGateLoopDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { checks: CHECKS_FAIL },
    });
    expect(result.outcome).toBe("stopped");
    expect(calls).toEqual([
      "planning",
      "implementation",
      "checks",
      "fix",
      "checks",
      "fix",
      "checks",
      "fix",
      "checks",
    ]);
    expect(rec.failures).toEqual([
      { phase: "loop", reason: 'loop "retry" exhausted after 3 attempts', nodeId: "retry" },
    ]);
    expect(finishStatuses(rec, "retry")).toEqual(["ok", "ok", "ok", "fail"]);
  });

  it("accumulates attempt counters across re-entry for every cyclic block, not just the loop", async () => {
    const { rec } = await runGolden({
      def: humanGateLoopDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { checks: CHECKS_FAIL },
    });
    expect(attemptsFor(rec, "checks")).toEqual([1, 2, 3, 4]);
    expect(attemptsFor(rec, "verdict")).toEqual([1, 2, 3, 4]);
    expect(attemptsFor(rec, "fix")).toEqual([1, 2, 3]);
    expect(attemptsFor(rec, "retry")).toEqual([1, 2, 3, 4]);
  });

  it("steps record persists visited control nodes (gate, verdict, retry) alongside actions", async () => {
    const { result } = await runGolden({
      def: humanGateLoopDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { checks: CHECKS_FAIL },
    });
    expect(Object.keys(result.steps).sort()).toEqual(
      ["trigger", "planning", "gate", "implementation", "checks", "verdict", "retry", "fix"].sort(),
    );
  });

  it("onExhaust=human: exhaustion routes to clarificationExit with the loop id label", async () => {
    const { result, rec } = await runGolden({
      def: humanGateWithRetry({ onExhaust: "human" }),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { checks: CHECKS_FAIL },
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.clarifications).toEqual([
      { questions: ['Loop "retry" exhausted after 3 attempts. How should we proceed?'], nodeId: "retry" },
    ]);
    expect(finishStatuses(rec, "retry")).toEqual(["ok", "ok", "ok", "warn"]);
    expect(rec.failures).toEqual([]);
  });

  it("onExhaust=continue with a wired exhausted edge follows it and completes", async () => {
    const { result, calls, rec } = await runGolden({
      def: humanGateWithRetry({ onExhaust: "continue" }, [
        { from: "retry", to: "finalize", fromPort: "exhausted" },
      ]),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { checks: CHECKS_FAIL },
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toContain("open-pr");
    expect(finishStatuses(rec, "retry")).toEqual(["ok", "ok", "ok", "ok"]);
    expect(rec.failures).toEqual([]);
  });

  it("onExhaust=continue with no exhausted edge ends the walk cleanly (no failure)", async () => {
    const { result, calls, rec } = await runGolden({
      def: humanGateWithRetry({ onExhaust: "continue" }),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { checks: CHECKS_FAIL },
    });
    expect(result.outcome).toBe("completed");
    expect(calls).not.toContain("open-pr");
    expect(finishStatuses(rec, "retry")).toEqual(["ok", "ok", "ok", "ok"]);
    expect(rec.failures).toEqual([]);
    expect(rec.clarifications).toEqual([]);
  });

  it("recovers before exhaustion: checks passes on the 2nd attempt, loop never exhausts", async () => {
    const { result, calls, rec } = await runGolden({
      def: humanGateLoopDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      executor: makeDynamicExecutor((block, attempt) =>
        block.id === "checks" ? (attempt >= 2 ? CHECKS_PASS : CHECKS_FAIL) : undefined,
      ),
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toContain("open-pr");
    expect(calls.filter((c) => c === "fix")).toHaveLength(1);
    expect(finishStatuses(rec, "retry")).toEqual(["ok"]);
  });
});

describe("golden runs: planApproval two-chain hand-off", () => {
  it("binds the approved trigger plan into the implementation block explicitly", () => {
    const implementation = planApprovalDefinition().nodes.find(
      (node) => node.id === "implementation",
    );
    expect(implementation?.inputs).toEqual({
      ticket: "trigger.ticket",
      plan: "trigger.approvedPlan",
    });
  });

  it("normalization preserves both authored trigger chains", async () => {
    const normalized = normalizeDefinitionForExecution(
      planApprovalDefinition().nodes,
      planApprovalDefinition().edges,
    );
    expect(normalized.nodes.some((n) => n.type === "prepare_workspace")).toBe(false);

    const first = await runGolden({
      def: planApprovalDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: { "send-approval": { kind: "ended", output: { status: "waiting_for_human" } } },
    });
    expect(first.calls[0]).toBe("planning");

    const second = await runGolden({
      def: planApprovalDefinition(),
      entryTriggerType: "trigger_plan_approved",
    });
    expect(second.calls[0]).toBe("implementation");
  });

  it("first chain parks cleanly at send_plan_approval with outcome 'ended'", async () => {
    const { result, calls, rec } = await runGolden({
      def: planApprovalDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: {
        planning: { kind: "next", output: { status: "planned", plan: "Ship it" } },
        "send-approval": { kind: "ended", output: { status: "waiting_for_human" } },
      },
    });
    expect(result.outcome).toBe("ended");
    expect(calls).toEqual(["planning", "send-approval"]);
    expect(finishStatuses(rec, "send-approval")).toEqual(["warn"]);
    expect(rec.terminations).toEqual([]);
    expect(rec.clarifications).toEqual([]);
    expect(rec.failures).toEqual([]);
    expect(calls).not.toContain("implementation");
    expect(calls).not.toContain("open-pr");
    expect(calls).not.toContain("status");
  });

  it("send_plan_approval has no ports, so a 'next' result triggers an unknown-port failureExit", async () => {
    const { result, rec } = await runGolden({
      def: planApprovalDefinition(),
      entryTriggerType: "trigger_ticket_ai",
      overrides: {
        planning: { kind: "next", output: { status: "planned", plan: "Ship it" } },
        "send-approval": { kind: "next", output: { status: "ok" } },
      },
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures[0].phase).toBe("engine");
    expect(rec.failures[0].reason).toContain("unknown port");
  });

  it("second chain (trigger_plan_approved) delivers and completes directly", async () => {
    const { result, calls } = await runGolden({
      def: planApprovalDefinition(),
      entryTriggerType: "trigger_plan_approved",
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["implementation", "finalize", "open-pr", "status"]);
    expect(calls).not.toContain("planning");
    expect(calls).not.toContain("send-approval");
  });
});

describe("golden runs: prReviewFix fan-in", () => {
  it("normalize is a no-op for the canonical workspace-aware Fix flow", async () => {
    const def = prReviewFixDefinition();
    const normalized = normalizeDefinitionForExecution(def.nodes, def.edges);
    expect(normalized.nodes.some((n) => n.id.startsWith("__prepare"))).toBe(false);
    expect(normalized.nodes.map((n) => n.id)).toEqual(def.nodes.map((n) => n.id));

    const { calls } = await runGolden({ def, entryTriggerType: "trigger_pr_checks_failed" });
    expect(calls[0]).toBe("fetch-context");
  });

  it("both triggers keep separate outEdges that converge on fetch-context", async () => {
    const def = prReviewFixDefinition();
    const normalized = normalizeDefinitionForExecution(def.nodes, def.edges);
    const graph = buildRuntimeGraph({ nodes: normalized.nodes, edges: normalized.edges });
    expect(graph.outEdges.get("trigger-checks-failed")?.get("out")).toBe("fetch-context");
    expect(graph.outEdges.get("trigger-review")?.get("out")).toBe("fetch-context");
  });

  it("entry=trigger_pr_checks_failed runs the shared fix pipeline to completion", async () => {
    const { result, calls } = await runGolden({
      def: prReviewFixDefinition(),
      entryTriggerType: "trigger_pr_checks_failed",
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["fetch-context", "fix", "finalize", "comment"]);
    expect(Object.keys(result.steps)).toContain("trigger-checks-failed");
    expect(Object.keys(result.steps)).not.toContain("trigger-review");
  });

  it("entry=trigger_pr_review yields the identical downstream walk", async () => {
    const { result, calls } = await runGolden({
      def: prReviewFixDefinition(),
      entryTriggerType: "trigger_pr_review",
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["fetch-context", "fix", "finalize", "comment"]);
  });
});

describe("golden runs: entry-trigger resolution by type", () => {
  it("resolves the entry id via nodes.find(first type match) exactly like agent.ts", () => {
    const cases: Array<[WorkflowDefinition, WorkflowBlockType, string]> = [
      [linearPipelineDefinition(), "trigger_ticket_ai", "trigger"],
      [humanGateLoopDefinition(), "trigger_ticket_ai", "trigger"],
      [planApprovalDefinition(), "trigger_ticket_ai", "trigger-ticket"],
      [planApprovalDefinition(), "trigger_plan_approved", "trigger-approved"],
      [prReviewFixDefinition(), "trigger_pr_checks_failed", "trigger-checks-failed"],
      [prReviewFixDefinition(), "trigger_pr_review", "trigger-review"],
    ];
    for (const [def, entryTriggerType, expectedId] of cases) {
      const normalized = normalizeDefinitionForExecution(def.nodes, def.edges);
      const entry = normalized.nodes.find((n) => n.type === entryTriggerType);
      expect(entry?.id).toBe(expectedId);
    }
  });
});
