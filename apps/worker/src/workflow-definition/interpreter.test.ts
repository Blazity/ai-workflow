import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { WorkflowRunCancelledError } from "workflow/errors";
import type {
  BlockOutput,
  BlockRunState,
  WorkflowBlockTypeV1,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  buildRuntimeGraph,
  executionError,
  executeGraph as executeGraphWithContractValidation,
  SAFE_EXECUTION_ERROR_MESSAGES,
  WORKSPACE_GATE_NOT_RECORDED_MESSAGE,
  type BlockExecutionResult,
  type BlockExecutor,
  type ExecuteGraphHooks,
  type RuntimeGraph,
  type StepsRecord,
} from "./interpreter.js";
import { ActiveRunOwnerError } from "../lib/active-run-owner.js";
import { RunBudgetError } from "../workflows/run-budget.js";
import { isRunControlError } from "../workflows/run-control-error.js";

type ExecuteGraphOptions = Parameters<typeof executeGraphWithContractValidation>[0];

function executeGraph(opts: ExecuteGraphOptions) {
  return executeGraphWithContractValidation({ ...opts, outputValidator: () => [] });
}

function node(
  id: string,
  type: WorkflowBlockTypeV1,
  params: Record<string, WorkflowParamValue> = {},
  name?: string,
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params, inputs: {}, name };
}

function graphFrom(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionEdge[],
): RuntimeGraph {
  return buildRuntimeGraph({ nodes, edges });
}

interface Recorder {
  hooks: ExecuteGraphHooks;
  starts: Array<{ nodeId: string; attempt: number }>;
  finishes: Array<{ nodeId: string; state: BlockRunState }>;
  clarifications: Array<{ questions: string[]; nodeId: string; suggestedAnswers?: string[] }>;
  failures: Array<{ phase: string; reason: string; nodeId: string }>;
  /** Kept beside `failures` rather than inside it: the walk's recorded steps
   *  are what the failure comment reads, and folding them into the failure
   *  objects would make every existing `toEqual` on them a whole-graph dump. */
  failureSteps: Array<StepsRecord | undefined>;
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
  const failureSteps: Recorder["failureSteps"] = [];
  const terminations: Recorder["terminations"] = [];
  const hooks: ExecuteGraphHooks = {
    async onBlockStart(nodeId, attempt) {
      starts.push({ nodeId, attempt });
    },
    async onBlockFinish(nodeId, state) {
      finishes.push({ nodeId, state });
    },
    async clarificationExit(questions, nodeId, suggestedAnswers) {
      clarifications.push({ questions, nodeId, suggestedAnswers });
    },
    async failureExit(phase, reason, nodeId, steps) {
      failures.push({ phase, reason, nodeId });
      failureSteps.push(steps);
    },
    async terminate(params, nodeId) {
      terminations.push({ params, nodeId });
    },
  };
  return {
    hooks,
    starts,
    finishes,
    clarifications,
    failures,
    failureSteps,
    terminations,
  };
}

function makeExecutor(
  overrides: Record<string, BlockExecutionResult> = {},
  onCall?: (
    block: WorkflowDefinitionNode,
    steps: StepsRecord,
    resolvedInputs: Record<string, unknown>,
  ) => void,
): { executor: BlockExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: BlockExecutor = async (block, steps, resolvedInputs) => {
    calls.push(block.id);
    onCall?.(block, steps, resolvedInputs);
    return overrides[block.id] ?? { kind: "next", output: { status: "ok", id: block.id } };
  };
  return { executor, calls };
}

const finishStatuses = (rec: Recorder, nodeId: string): string[] =>
  rec.finishes.filter((f) => f.nodeId === nodeId).map((f) => f.state.status);

const attemptsFor = (rec: Recorder, nodeId: string): number[] =>
  rec.starts.filter((s) => s.nodeId === nodeId).map((s) => s.attempt);

describe("buildRuntimeGraph", () => {
  it("accepts the unchanged v1 graph contract and excludes v2 definitions", () => {
    expectTypeOf<WorkflowDefinitionV1>().toMatchTypeOf<
      Parameters<typeof buildRuntimeGraph>[0]
    >();
    expectTypeOf<WorkflowDefinitionV2>().not.toMatchTypeOf<
      Parameters<typeof buildRuntimeGraph>[0]
    >();
  });

  it("resolves the default port when an edge omits fromPort", () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("plan", "planning_agent")],
      [{ from: "trig", to: "plan" }],
    );
    expect(graph.outEdges.get("trig")?.get("out")).toBe("plan");
  });

  it("respects an explicit fromPort", () => {
    const graph = graphFrom(
      [
        node("br", "branch", { condition: "true" }),
        node("yes", "open_pr"),
        node("no", "open_pr"),
      ],
      [
        { from: "br", to: "yes", fromPort: "true" },
        { from: "br", to: "no", fromPort: "false" },
      ],
    );
    expect(graph.outEdges.get("br")?.get("true")).toBe("yes");
    expect(graph.outEdges.get("br")?.get("false")).toBe("no");
  });

  it("collects every trigger node", () => {
    const graph = graphFrom(
      [
        node("a", "trigger_ticket_ai"),
        node("b", "trigger_ticket_ai"),
        node("plan", "planning_agent"),
      ],
      [],
    );
    expect(graph.triggers.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });
});

describe("executeGraph output contracts", () => {
  it("rejects an invalid trigger output before starting downstream execution", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("after", "send_slack_message")],
      [{ from: "trig", to: "after" }],
    );
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();

    const result = await executeGraphWithContractValidation({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("stopped");
    expect(calls).toEqual([]);
    expect(result.steps.trig).toBeUndefined();
    expect(rec.failures).toEqual([
      expect.objectContaining({ phase: "contract", nodeId: "trig" }),
    ]);
  });

  it.each([
    ["next", { kind: "next", output: { status: "sent" } }],
    [
      "needs_human_input",
      {
        kind: "needs_human_input",
        output: { status: "needs_human_input" },
        questions: ["continue?"],
      },
    ],
    ["ended", { kind: "ended", output: { status: "waiting" } }],
  ] as const)("rejects an invalid %s executor output before recording or routing", async (_kind, invalid) => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("action", "send_slack_message"),
        node("after", "send_slack_message"),
      ],
      [
        { from: "trig", to: "action" },
        { from: "action", to: "after" },
        { from: "action", to: "after", fromPort: "failed" },
      ],
    );
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor({ action: invalid as BlockExecutionResult });

    const result = await executeGraphWithContractValidation({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", ticketKey: "AIW-103" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("stopped");
    expect(calls).toEqual(["action"]);
    expect(result.steps.action).toBeUndefined();
    expect(rec.finishes).toHaveLength(1);
    expect(rec.finishes[0]).toMatchObject({
      nodeId: "action",
      state: { status: "fail" },
    });
    expect(rec.finishes[0]?.state.output).toBeUndefined();
    expect(rec.failures).toEqual([
      expect.objectContaining({ phase: "contract", nodeId: "action" }),
    ]);
    expect(rec.clarifications).toEqual([]);
  });

  it("requires fields guaranteed by a normal output contract", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("comment", "post_pr_comment", { body: "done" })],
      [{ from: "trig", to: "comment" }],
    );
    const rec = makeRecorder();

    const result = await executeGraphWithContractValidation({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", ticketKey: "AIW-103" },
      executeBlock: async () => ({ kind: "next", output: { status: "ok" } }),
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("stopped");
    expect(rec.failures[0]).toMatchObject({ phase: "contract", nodeId: "comment" });
    expect(rec.failures[0]?.reason).toBe(
      'The block returned an invalid result. (block "comment" (post_pr_comment) returned output that violates its contract: output.comments is required.) Diagnostic ID: AIW-DIAG-test-run-comment-1',
    );
    expect(result.executionError?.category).toBe("schema");
  });

  it("does not validate normal output fields for an execution error", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("comment", "post_pr_comment", { body: "done" }),
        node("recover", "send_slack_message", { message: "failed" }),
      ],
      [
        { from: "trig", to: "comment" },
        { from: "comment", to: "recover", fromPort: "failed" },
      ],
    );
    const rec = makeRecorder();

    const result = await executeGraphWithContractValidation({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", ticketKey: "AIW-103" },
      executeBlock: async (block) =>
        block.id === "comment"
          ? executionError("provider rejected", { category: "provider" })
          : { kind: "next", output: { status: "ok" } },
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(result.steps.comment).toBeUndefined();
    expect(result.executionError?.category).toBe("provider");
    expect(rec.failures).toHaveLength(1);
  });

  it("routes a thrown executor error through an authored failure edge", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("comment", "post_ticket_comment", { body: "done" }),
        node("recover", "send_slack_message", { message: "failed" }),
      ],
      [
        { from: "trig", to: "comment" },
        { from: "comment", to: "recover", fromPort: "failed" },
      ],
    );
    const rec = makeRecorder();
    const calls: string[] = [];

    const result = await executeGraphWithContractValidation({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", ticketKey: "AIW-103" },
      executeBlock: async (block) => {
        calls.push(block.id);
        if (block.id === "comment") throw new Error("provider rejected the comment");
        return { kind: "next", output: { status: "ok" } };
      },
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["comment", "recover"]);
    expect(result.steps.comment).toBeUndefined();
    expect(rec.finishes.find((finish) => finish.nodeId === "comment")?.state).toMatchObject({
      status: "fail",
      error: "The block could not be completed. (provider rejected the comment)",
      diagnosticId: "AIW-DIAG-test-run-comment-1",
    });
    expect(rec.failures).toEqual([
      {
        phase: "post_ticket_comment",
        reason:
          "The block could not be completed. (provider rejected the comment) Diagnostic ID: AIW-DIAG-test-run-comment-1",
        nodeId: "comment",
      },
    ]);
  });

  it.each([
    [
      "budget exhaustion",
      new RunBudgetError({
        status: "budget_exceeded",
        metric: "tokens",
        limit: 10,
        consumed: 11,
        reason: "budget exceeded",
      }),
    ],
    ["exact-owner loss", new ActiveRunOwnerError()],
    ["Workflow cancellation", new WorkflowRunCancelledError("wrun-1")],
  ])("does not route %s through an authored failure edge", async (_label, controlError) => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("comment", "post_ticket_comment", { body: "done" }),
        node("recover", "send_slack_message", { message: "failed" }),
      ],
      [
        { from: "trig", to: "comment" },
        { from: "comment", to: "recover", fromPort: "failed" },
      ],
    );
    const rec = makeRecorder();
    const calls: string[] = [];

    await expect(
      executeGraphWithContractValidation({
        graph,
        entryTriggerId: "trig",
        triggerOutput: { status: "fired", ticketKey: "AIW-103" },
        executeBlock: async (block) => {
          calls.push(block.id);
          throw controlError;
        },
        hooks: rec.hooks,
        shouldRethrowExecutionError: isRunControlError,
      }),
    ).rejects.toBe(controlError);

    expect(calls).toEqual(["comment"]);
    expect(rec.failures).toEqual([]);
    expect(rec.finishes).toEqual([]);
  });

  it("applies the default failure exit when a thrown executor error has no failure edge", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("comment", "post_ticket_comment", { body: "done" })],
      [{ from: "trig", to: "comment" }],
    );
    const rec = makeRecorder();

    const result = await executeGraphWithContractValidation({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", ticketKey: "AIW-103" },
      executeBlock: async () => {
        throw new Error("provider rejected the comment");
      },
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("stopped");
    expect(result.steps.comment).toBeUndefined();
    expect(rec.failures).toEqual([
      {
        phase: "post_ticket_comment",
        reason:
          "The block could not be completed. (provider rejected the comment) Diagnostic ID: AIW-DIAG-test-run-comment-1",
        nodeId: "comment",
      },
    ]);
  });
});

describe("executeGraph protocol diagnostics", () => {
  it("logs one stable structured event and omits protocol detail from run state", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("impl", "implementation_agent")],
      [{ from: "trig", to: "impl" }],
    );
    const rec = makeRecorder();
    const diagnostic = {
      provider: "codex" as const,
      packageName: "@openai/codex",
      cliVersion: "0.144.6",
      protocol: "codex-jsonl-0.144.6",
      phase: "impl",
      failureKind: "invalid_json" as const,
      exitCode: 0,
      stderrTail: "redacted detail",
    };
    const onExecutionError = vi.fn();

    const result = await executeGraphWithContractValidation({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", ticketKey: "AIW-106" },
      executeBlock: async () => executionError("internal parser detail", {
        category: "parsing",
        message: "The current agent phase returned an invalid structured response.",
        phase: "impl",
        diagnostic,
      }),
      hooks: { ...rec.hooks, onExecutionError },
    });

    expect(onExecutionError).toHaveBeenCalledTimes(1);
    expect(onExecutionError).toHaveBeenCalledWith({
      diagnosticId: "AIW-DIAG-test-run-impl-1",
      nodeId: "impl",
      attempt: 1,
      category: "parsing",
      phase: "impl",
      detail: "internal parser detail",
      message:
        "The current agent phase returned an invalid structured response. (internal parser detail)",
      agentProtocol: diagnostic,
    });
    expect(result.executionError).toEqual({
      category: "parsing",
      // The caller's sentence now leads and the parser detail follows it
      // (AIW-254): an explicit message sets the lead, it no longer replaces the
      // cause. `invalid_json` is a protocol failure whose detail IS the cause, so
      // the detail outranks the captured stderr tail and the tail stays internal.
      message:
        "The current agent phase returned an invalid structured response. (internal parser detail)",
      phase: "impl",
      diagnosticId: "AIW-DIAG-test-run-impl-1",
      nodeId: "impl",
      attempt: 1,
    });
    expect(JSON.stringify(result.executionError)).not.toContain("redacted detail");
  });
});

describe("executeGraph linear walk", () => {
  it("executes a V1-shaped chain in order and completes", async () => {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("plan", "planning_agent"),
      node("impl", "implementation_agent"),
      node("pr", "open_pr"),
      node("status", "update_ticket_status"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "plan" },
      { from: "plan", to: "impl" },
      { from: "impl", to: "pr" },
      { from: "pr", to: "status" },
    ];
    const graph = graphFrom(nodes, edges);
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["plan", "impl", "pr", "status"]);
    expect(rec.starts.map((s) => s.nodeId)).toEqual(["plan", "impl", "pr", "status"]);
    expect(rec.finishes.every((f) => f.state.status === "ok")).toBe(true);
    expect(Object.keys(result.steps).sort()).toEqual(
      ["impl", "pr", "plan", "status", "trig"].sort(),
    );
    expect(result.steps.trig.output).toEqual({ status: "ok" });
  });

  it("resumes at the waiting node with prior outputs and the human answer", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("before", "prepare_workspace"),
        node("waiting", "implementation_agent"),
        node("after", "run_checks"),
      ],
      [
        { from: "trig", to: "before" },
        { from: "before", to: "waiting" },
        { from: "waiting", to: "after" },
      ],
    );
    const rec = makeRecorder();
    const calls: string[] = [];
    const seenSteps: string[][] = [];
    const seenAnswers: Array<string | undefined> = [];
    const executor: BlockExecutor = async (block, steps, _inputs, execution) => {
      calls.push(block.id);
      seenSteps.push(Object.keys(steps).sort());
      seenAnswers.push(execution?.clarificationAnswer);
      return { kind: "next", output: { status: "ok", id: block.id } };
    };

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", ticketKey: "AIW-96" },
      resume: {
        waitingNodeId: "waiting",
        clarificationAnswer: "Keep both conflict sides and add a regression test.",
        priorSteps: {
          trig: { output: { status: "fired", ticketKey: "AIW-96" } },
          before: { output: { status: "ready", sandboxId: "sbx_source" } },
        },
      },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(Object.getPrototypeOf(result.steps)).toBeNull();
    expect(calls).toEqual(["waiting", "after"]);
    expect(seenSteps[0]).toEqual(["before", "trig"]);
    expect(seenAnswers).toEqual([
      "Keep both conflict sides and add a regression test.",
      undefined,
    ]);
    expect(result.steps.before.output).toEqual({ status: "ready", sandboxId: "sbx_source" });
    expect(result.steps.waiting.output).toEqual({ status: "ok", id: "waiting" });
  });

  it("consumes a human_question answer once and continues downstream", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("waiting", "human_question", { questions: ["Which region?"] }),
        node("after", "send_slack_message"),
      ],
      [
        { from: "trig", to: "waiting" },
        { from: "waiting", to: "after" },
      ],
    );
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      resume: {
        waitingNodeId: "waiting",
        clarificationAnswer: "eu-central",
        priorSteps: { trig: { output: { status: "fired" } } },
      },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["after"]);
    expect(result.steps.waiting.output).toEqual({
      status: "answered",
      answer: "eu-central",
    });
    expect(rec.clarifications).toEqual([]);
  });

  it("does not park again when resuming a terminate(waiting_for_human) node", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("waiting", "terminate", { terminalStatus: "waiting_for_human" }),
      ],
      [{ from: "trig", to: "waiting" }],
    );
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      resume: {
        waitingNodeId: "waiting",
        clarificationAnswer: "continue",
        priorSteps: { trig: { output: { status: "fired" } } },
      },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(result.steps.waiting.output).toEqual({ status: "done", answer: "continue" });
    expect(rec.terminations).toEqual([]);
  });
});

describe("executeGraph branch", () => {
  function branchGraph(condition: string): RuntimeGraph {
    return graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("br", "branch", { condition }),
        node("yes", "open_pr"),
        node("no", "send_slack_message"),
      ],
      [
        { from: "trig", to: "br" },
        { from: "br", to: "yes", fromPort: "true" },
        { from: "br", to: "no", fromPort: "false" },
      ],
    );
  }

  it("takes the true path when the condition holds", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph: branchGraph("steps.trig.output.approved == true"),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok", approved: true },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["yes"]);
    expect(result.steps.br.output).toEqual({
      status: "ok",
      path: "true",
      reason: "steps.trig.output.approved == true",
    });
    expect(rec.failures).toEqual([]);
  });

  it("takes the false path when the condition fails", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph: branchGraph("steps.trig.output.approved == true"),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok", approved: false },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["no"]);
    expect(result.steps.br.output.path).toBe("false");
  });

  it("fails via failureExit when the condition yields a non-boolean, taking neither port", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph: branchGraph("!steps.trig.output.failures"),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok", ok: false, failures: ["lint"] },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(calls).toEqual([]);
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].phase).toBe("branch");
    expect(rec.failures[0].nodeId).toBe("br");
    expect(rec.failures[0].reason).toBe(
      "The workflow engine could not continue. (steps.trig.output.failures: expected boolean, got array) Diagnostic ID: AIW-DIAG-test-run-br-1",
    );
    expect(finishStatuses(rec, "br")).toEqual(["fail"]);
    expect(result.steps.br).toBeUndefined();
  });

  it("fails via failureExit on a condition parse error", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph: branchGraph("("),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(calls).toEqual([]);
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].phase).toBe("branch");
    expect(rec.failures[0].nodeId).toBe("br");
    expect(finishStatuses(rec, "br")).toEqual(["fail"]);
  });
});

describe("executeGraph loop", () => {
  function loopGraph(opts: {
    maxAttempts: number;
    onExhaust: string;
    wireExhausted: boolean;
    loopName?: string;
  }): RuntimeGraph {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node(
        "loop",
        "loop",
        { maxAttempts: opts.maxAttempts, onExhaust: opts.onExhaust },
        opts.loopName,
      ),
      node("body", "implementation_agent"),
      node("end", "open_pr"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "loop" },
      { from: "loop", to: "body", fromPort: "continue" },
      { from: "body", to: "loop" },
    ];
    if (opts.wireExhausted) {
      edges.push({ from: "loop", to: "end", fromPort: "exhausted" });
    }
    return graphFrom(nodes, edges);
  }

  it("runs the body maxAttempts times then exhausts", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    await executeGraph({
      graph: loopGraph({ maxAttempts: 2, onExhaust: "continue", wireExhausted: true }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(attemptsFor(rec, "body")).toEqual([1, 2]);
    expect(attemptsFor(rec, "loop")).toEqual([1, 2, 3]);
  });

  it("onExhaust=continue follows the exhausted edge and completes", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({ maxAttempts: 2, onExhaust: "continue", wireExhausted: true }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toContain("end");
    expect(finishStatuses(rec, "loop")).toEqual(["ok", "ok", "ok"]);
    expect(rec.failures).toEqual([]);
  });

  it("onExhaust=fail with no exhausted edge calls failureExit", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({ maxAttempts: 2, onExhaust: "fail", wireExhausted: false }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].phase).toBe("loop");
    expect(rec.failures[0].reason).toBe('loop "loop" exhausted after 2 attempts');
    expect(finishStatuses(rec, "loop")).toEqual(["ok", "ok", "fail"]);
  });

  it("onExhaust=fail with an exhausted edge follows the edge", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({ maxAttempts: 2, onExhaust: "fail", wireExhausted: true }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toContain("end");
    expect(rec.failures).toEqual([]);
    expect(finishStatuses(rec, "loop")).toEqual(["ok", "ok", "ok"]);
  });

  it("onExhaust=human calls clarificationExit with a message", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({
        maxAttempts: 2,
        onExhaust: "human",
        wireExhausted: true,
        loopName: "Retry loop",
      }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.clarifications).toHaveLength(1);
    expect(rec.clarifications[0].questions).toEqual([
      'Loop "Retry loop" exhausted after 2 attempts. How should we proceed?',
    ]);
    expect(finishStatuses(rec, "loop")).toEqual(["ok", "ok", "warn"]);
    expect(rec.failures).toEqual([]);
  });

  it("resumes an exhausted human loop on its exhausted edge without replaying its body", async () => {
    const graph = loopGraph({
      maxAttempts: 2,
      onExhaust: "human",
      wireExhausted: true,
      loopName: "Retry loop",
    });
    const first = makeRecorder();
    const firstCalls: string[] = [];
    let checkpoint:
      | { steps: StepsRecord; controlState: { attempts: Record<string, number>; executions: number } }
      | undefined;
    (first.hooks as any).clarificationExit = async (
      _questions: string[],
      _nodeId: string,
      _suggestions: string[] | undefined,
      steps: StepsRecord,
      controlState: { attempts: Record<string, number>; executions: number },
    ) => {
      checkpoint = { steps, controlState };
    };

    await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: async (block) => {
        firstCalls.push(block.id);
        return { kind: "next", output: { status: "ok" } };
      },
      hooks: first.hooks,
      maxTotalExecutions: 20,
    });
    expect(firstCalls.filter((id) => id === "body")).toHaveLength(2);
    expect(checkpoint).toBeDefined();

    const resumed = makeRecorder();
    const resumedCalls: string[] = [];
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      resume: {
        waitingNodeId: "loop",
        clarificationAnswer: "Continue downstream",
        priorSteps: checkpoint!.steps,
        controlState: checkpoint!.controlState,
      } as never,
      executeBlock: async (block) => {
        resumedCalls.push(block.id);
        return { kind: "next", output: { status: "ok" } };
      },
      hooks: resumed.hooks,
      maxTotalExecutions: 20,
    });

    expect(result.outcome).toBe("completed");
    expect(resumedCalls).toEqual(["end"]);
    expect(result.steps.loop.output).toMatchObject({
      status: "exhausted",
      attempt: 2,
      answer: "Continue downstream",
    });
  });

  it("carries the total execution cap across a clarification continuation", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("waiting", "implementation_agent"),
        node("after", "open_pr"),
      ],
      [
        { from: "trig", to: "waiting" },
        { from: "waiting", to: "after" },
      ],
    );
    const rec = makeRecorder();
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      resume: {
        waitingNodeId: "waiting",
        clarificationAnswer: "go",
        priorSteps: { trig: { output: { status: "ok" } } },
        controlState: { attempts: { waiting: 1 }, executions: 2 },
      } as never,
      executeBlock: async () => ({ kind: "next", output: { status: "ok" } }),
      hooks: rec.hooks,
      maxTotalExecutions: 2,
    });

    expect(result.outcome).toBe("stopped");
    expect(rec.failures[0]?.reason).toBe(
      "The workflow engine could not continue. (workflow exceeded the maximum of 2 block executions) Diagnostic ID: AIW-DIAG-test-run-waiting-2",
    );
  });
});

describe("executeGraph failure port override", () => {
  function failGraph(wireFailed: boolean): RuntimeGraph {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("checks", "run_pre_pr_checks"),
      node("recover", "send_slack_message"),
    ];
    const edges: WorkflowDefinitionEdge[] = [{ from: "trig", to: "checks" }];
    if (wireFailed) edges.push({ from: "checks", to: "recover", fromPort: "failed" });
    return graphFrom(nodes, edges);
  }

  it("continues along a wired failure edge and persists a fail state", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor({
      checks: executionError("lint broke", {
        category: "checks",
        phase: "checks",
      }),
    });
    const result = await executeGraph({
      graph: failGraph(true),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["checks", "recover"]);
    expect(rec.failures).toHaveLength(1);
    expect(finishStatuses(rec, "checks")).toEqual(["fail"]);
    expect(rec.finishes[0].state.error).toBe("The checks could not be started. (lint broke)");
    expect(result.steps.checks).toBeUndefined();
    expect(result.executionError?.diagnosticId).toBe(
      "AIW-DIAG-test-run-checks-1",
    );
  });

  it("keeps the first error primary when cleanup also errors", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      checks: executionError("provider rejected checks", {
        category: "provider",
        phase: "checks",
      }),
      recover: executionError("cleanup sandbox unavailable", {
        category: "sandbox",
        phase: "cleanup",
      }),
    });

    const result = await executeGraph({
      graph: failGraph(true),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.executionError).toMatchObject({
      category: "provider",
      diagnosticId: "AIW-DIAG-test-run-checks-1",
      nodeId: "checks",
    });
    expect(rec.finishes).toEqual([
      expect.objectContaining({
        nodeId: "checks",
        state: expect.objectContaining({
          status: "fail",
          diagnosticId: "AIW-DIAG-test-run-checks-1",
        }),
      }),
      expect.objectContaining({
        nodeId: "recover",
        state: expect.objectContaining({
          status: "fail",
          diagnosticId: "AIW-DIAG-test-run-recover-1",
        }),
      }),
    ]);
    expect(rec.failures).toEqual([
      {
        phase: "checks",
        reason:
          "An external service could not complete this block. (provider rejected checks) Diagnostic ID: AIW-DIAG-test-run-checks-1",
        nodeId: "checks",
      },
    ]);
  });

  it("calls failureExit with the phase when no failure edge is wired", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      checks: executionError("lint broke", {
        category: "checks",
        phase: "checks",
      }),
    });
    const result = await executeGraph({
      graph: failGraph(false),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].phase).toBe("checks");
    expect(rec.failures[0].reason).toBe(
      "The checks could not be started. (lint broke) Diagnostic ID: AIW-DIAG-test-run-checks-1",
    );
  });

  it("does not report a missing publication gate as checks that could not start", async () => {
    // UP-4847. The gate record is what is missing; the scripts may have run and
    // passed. Reading "The checks could not be started." here sent operators
    // looking for a check failure that never happened.
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      checks: executionError(WORKSPACE_GATE_NOT_RECORDED_MESSAGE, {
        category: "checks",
        phase: "pre-pr-checks",
      }),
    });
    await executeGraph({
      graph: failGraph(false),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(rec.failures[0].reason).toBe(
      `${WORKSPACE_GATE_NOT_RECORDED_MESSAGE} Diagnostic ID: AIW-DIAG-test-run-checks-1`,
    );
    expect(rec.failures[0].reason).not.toContain(
      SAFE_EXECUTION_ERROR_MESSAGES.checks,
    );
  });

  it("hands failureExit the steps the walk had recorded", async () => {
    // The failure comment reads the repository scripts output back out of these
    // (AIW-309): the engine's per-command summary does not fit the execution
    // error's own message bound, so without the steps the comment can never
    // name the failing command.
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      finalize: executionError("required checks not satisfied: checks", {
        category: "checks",
      }),
    });
    await executeGraph({
      graph: graphFrom(
        [
          node("trig", "trigger_ticket_ai"),
          node("checks", "run_pre_pr_checks"),
          node("finalize", "finalize_workspace"),
        ],
        [
          { from: "trig", to: "checks" },
          { from: "checks", to: "finalize" },
        ],
      ),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(rec.failures).toHaveLength(1);
    expect(rec.failureSteps[0]?.checks?.output).toEqual({
      status: "ok",
      id: "checks",
    });
  });
});

describe("executeGraph human input and ended", () => {
  const simple = (): RuntimeGraph =>
    graphFrom(
      [node("trig", "trigger_ticket_ai"), node("plan", "planning_agent")],
      [{ from: "trig", to: "plan" }],
    );

  it("needs_human_input calls clarificationExit and stops", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      plan: { kind: "needs_human_input", output: { status: "blocked" }, questions: ["Q1", "Q2"] },
    });
    const result = await executeGraph({
      graph: simple(),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.clarifications).toEqual([{ questions: ["Q1", "Q2"], nodeId: "plan" }]);
    expect(rec.clarifications[0].suggestedAnswers).toBeUndefined();
    expect(finishStatuses(rec, "plan")).toEqual(["warn"]);
    expect(rec.finishes[0].state.error).toBe("Q1; Q2");
    expect(rec.failures).toEqual([]);
  });

  it("hands the durable checkpoint hook every safe predecessor output", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("before", "prepare_workspace"),
        node("waiting", "implementation_agent"),
      ],
      [
        { from: "trig", to: "before" },
        { from: "before", to: "waiting" },
      ],
    );
    const rec = makeRecorder();
    let checkpointSteps: StepsRecord | undefined;
    rec.hooks.clarificationExit = async (_questions, _nodeId, _suggestions, steps) => {
      checkpointSteps = steps;
    };
    const { executor } = makeExecutor({
      before: { kind: "next", output: { status: "ready", workspace: "kept" } },
      waiting: {
        kind: "needs_human_input",
        output: { status: "needs_human_input" },
        questions: ["Which side?"],
      },
    });

    await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(checkpointSteps).toEqual({
      trig: { output: { status: "fired" } },
      before: { output: { status: "ready", workspace: "kept" } },
      waiting: { output: { status: "needs_human_input" } },
    });
  });

  it("forwards suggestedAnswers to clarificationExit when the result carries them", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      plan: {
        kind: "needs_human_input",
        output: { status: "blocked" },
        questions: ["Which database?"],
        suggestedAnswers: ["Postgres", "MySQL"],
      },
    });
    const result = await executeGraph({
      graph: simple(),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.clarifications).toEqual([
      { questions: ["Which database?"], nodeId: "plan", suggestedAnswers: ["Postgres", "MySQL"] },
    ]);
  });

  it("re-executes an action block with the answer and resolves downstream bindings", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("plan", "planning_agent"),
        { ...node("impl", "implementation_agent"), inputs: { plan: "steps.plan.output.plan" } },
      ],
      [
        { from: "trig", to: "plan" },
        { from: "plan", to: "impl" },
      ],
    );
    const rec = makeRecorder();
    rec.hooks.clarificationExit = async (questions, nodeId) => {
      rec.clarifications.push({ questions, nodeId, suggestedAnswers: undefined });
      return "Use the exact greeting: Hi hi";
    };
    const calls: Array<{ id: string; answer?: string; plan?: unknown }> = [];
    const executor: BlockExecutor = async (
      block,
      _steps,
      resolvedInputs,
      execution,
    ): Promise<BlockExecutionResult> => {
      calls.push({
        id: block.id,
        answer: execution?.clarificationAnswer,
        plan: resolvedInputs.plan,
      });
      if (block.id === "plan") {
        if (!execution?.clarificationAnswer) {
          return {
            kind: "needs_human_input",
            output: { status: "needs_human_input", questions: ["Which greeting?"] },
            questions: ["Which greeting?"],
          };
        }
        return {
          kind: "next",
          output: { status: "ready", plan: `Plan for: ${execution.clarificationAnswer}` },
        };
      }
      return { kind: "next", output: { status: "implemented", id: block.id } };
    };

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(result.executionError).toBeUndefined();
    expect(calls.map((c) => c.id)).toEqual(["plan", "plan", "impl"]);
    expect(calls[1].answer).toBe("Use the exact greeting: Hi hi");
    expect(calls[2].answer).toBeUndefined();
    expect(calls[2].plan).toBe("Plan for: Use the exact greeting: Hi hi");
    expect(attemptsFor(rec, "plan")).toEqual([1, 2]);
    // The asking attempt does not finish; only the informed re-execution does.
    expect(finishStatuses(rec, "plan")).toEqual(["ok"]);
    expect(result.steps.plan.output).toEqual({
      status: "ready",
      plan: "Plan for: Use the exact greeting: Hi hi",
    });
  });

  it("keeps the human_question answered envelope without re-executing it", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("waiting", "human_question", { questions: ["Which region?"] }),
        node("after", "send_slack_message"),
      ],
      [
        { from: "trig", to: "waiting" },
        { from: "waiting", to: "after" },
      ],
    );
    const rec = makeRecorder();
    rec.hooks.clarificationExit = async () => "eu-central";
    const { executor, calls } = makeExecutor({
      waiting: {
        kind: "needs_human_input",
        output: { status: "needs_human_input", questions: ["Which region?"] },
        questions: ["Which region?"],
      },
    });

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["waiting", "after"]);
    expect(result.steps.waiting.output).toEqual({ status: "answered", answer: "eu-central" });
    expect(finishStatuses(rec, "waiting")).toEqual(["ok"]);
  });

  it("supports a block asking again after re-execution, one round per ask", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("plan", "planning_agent")],
      [{ from: "trig", to: "plan" }],
    );
    const rec = makeRecorder();
    const answers = ["First answer", "Second answer"];
    rec.hooks.clarificationExit = async (questions, nodeId) => {
      rec.clarifications.push({ questions, nodeId, suggestedAnswers: undefined });
      return answers[rec.clarifications.length - 1];
    };
    const seen: Array<string | undefined> = [];
    const executor: BlockExecutor = async (
      _block,
      _steps,
      _inputs,
      execution,
    ): Promise<BlockExecutionResult> => {
      seen.push(execution?.clarificationAnswer);
      if (execution?.clarificationAnswer !== "Second answer") {
        return {
          kind: "needs_human_input",
          output: { status: "needs_human_input", questions: [`Q${seen.length}`] },
          questions: [`Q${seen.length}`],
        };
      }
      return { kind: "next", output: { status: "ready", plan: "final" } };
    };

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(seen).toEqual([undefined, "First answer", "Second answer"]);
    expect(attemptsFor(rec, "plan")).toEqual([1, 2, 3]);
    expect(rec.clarifications.map((c) => c.questions)).toEqual([["Q1"], ["Q2"]]);
    expect(result.steps.plan.output).toEqual({ status: "ready", plan: "final" });
  });

  it("bounds an endlessly re-asking block by maxTotalExecutions", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("plan", "planning_agent")],
      [{ from: "trig", to: "plan" }],
    );
    const rec = makeRecorder();
    rec.hooks.clarificationExit = async () => "still unclear";
    const executor: BlockExecutor = async () => ({
      kind: "needs_human_input",
      output: { status: "needs_human_input", questions: ["Again?"] },
      questions: ["Again?"],
    });

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      executeBlock: executor,
      hooks: rec.hooks,
      maxTotalExecutions: 3,
    });

    expect(result.outcome).toBe("stopped");
    expect(result.executionError).toMatchObject({ category: "engine" });
    expect(rec.failures).toEqual([expect.objectContaining({ nodeId: "plan" })]);
  });

  it("ended reports outcome ended with a warn finish and no exit hooks", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      plan: { kind: "ended", output: { status: "waiting_for_human" } },
    });
    const result = await executeGraph({
      graph: simple(),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("ended");
    expect(finishStatuses(rec, "plan")).toEqual(["warn"]);
    expect(rec.clarifications).toEqual([]);
    expect(rec.failures).toEqual([]);
    expect(rec.terminations).toEqual([]);
  });
});

describe("executeGraph terminal_success", () => {
  const noChangePlan = {
    status: "ready",
    plan: "The ticket is already resolved, so no change is needed.",
  };
  const linear = (): RuntimeGraph =>
    graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("plan", "planning_agent"),
        node("impl", "implementation_agent"),
      ],
      [
        { from: "trig", to: "plan" },
        { from: "plan", to: "impl" },
      ],
    );

  it("reports the natural completion outcome and skips everything downstream", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor({
      plan: { kind: "terminal_success", output: noChangePlan },
    });
    const result = await executeGraph({
      graph: linear(),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    const exhausted = await executeGraph({
      graph: graphFrom(
        [node("trig", "trigger_ticket_ai"), node("plan", "planning_agent")],
        [{ from: "trig", to: "plan" }],
      ),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: makeExecutor().executor,
      hooks: makeRecorder().hooks,
    });

    expect(result.outcome).toBe(exhausted.outcome);
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["plan"]);
    expect(result.steps.plan?.output).toEqual(noChangePlan);
    expect(result.steps.impl).toBeUndefined();
    expect(finishStatuses(rec, "plan")).toEqual(["ok"]);
    expect(rec.finishes[0].state.output).toEqual(noChangePlan);
    expect(rec.clarifications).toEqual([]);
    expect(rec.failures).toEqual([]);
    expect(rec.terminations).toEqual([]);
  });

  it("validates the terminating output against the declared contract", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      plan: { kind: "terminal_success", output: { status: "ready" } },
    });
    const result = await executeGraphWithContractValidation({
      graph: linear(),
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", ticketKey: "AIW-232" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("stopped");
    expect(result.steps.plan).toBeUndefined();
    expect(rec.failures).toEqual([
      expect.objectContaining({ phase: "contract", nodeId: "plan" }),
    ]);
  });
});

describe("executeGraph terminate", () => {
  const cases: Array<[string, string]> = [
    ["waiting_for_human", "warn"],
    ["failed", "fail"],
    ["skipped", "ok"],
    ["done", "ok"],
  ];

  it.each(cases)(
    "terminalStatus %s maps to onBlockFinish status %s and calls terminate",
    async (terminalStatus, expectedStatus) => {
      const graph = graphFrom(
        [
          node("trig", "trigger_ticket_ai"),
          node("term", "terminate", { terminalStatus, postComment: "note" }),
        ],
        [{ from: "trig", to: "term" }],
      );
      const rec = makeRecorder();
      const { executor, calls } = makeExecutor();
      const result = await executeGraph({
        graph,
        entryTriggerId: "trig",
        triggerOutput: { status: "ok" },
        executeBlock: executor,
        hooks: rec.hooks,
      });
      expect(result.outcome).toBe("stopped");
      expect(calls).toEqual([]);
      expect(finishStatuses(rec, "term")).toEqual([expectedStatus]);
      expect(rec.terminations).toEqual([
        { params: { terminalStatus, postComment: "note" }, nodeId: "term" },
      ]);
    },
  );

  it("does not let a cleanup terminate replace or repeat the primary failure exit", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("action", "post_ticket_comment", { body: "work" }),
        node("term", "terminate", { terminalStatus: "failed", postComment: "cleanup" }),
      ],
      [
        { from: "trig", to: "action" },
        { from: "action", to: "term", fromPort: "failed" },
      ],
    );
    const rec = makeRecorder();
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: async () =>
        executionError("provider rejected the action", { category: "provider" }),
      hooks: rec.hooks,
    });

    expect(result.executionError).toMatchObject({
      category: "provider",
      diagnosticId: "AIW-DIAG-test-run-action-1",
    });
    expect(rec.terminations).toEqual([]);
    expect(rec.failures).toEqual([
      expect.objectContaining({ nodeId: "action" }),
    ]);
  });
});

describe("executionError message derivation", () => {
  // AIW-254 flips this deliberately. An explicit caller message used to
  // short-circuit derivation, and because every agent call site supplies one,
  // "the account credit balance is too low" never reached a single surface. The
  // caller's sentence is a lead now, not a veto.
  it("does not let an explicit caller message suppress a curated cause", () => {
    const { error } = executionError("Credit balance is too low", {
      category: "provider",
      message: "A curated caller message.",
    });
    expect(error.message).toBe(
      "The AI provider rejected the request: the account credit or billing balance is too low.",
    );
    expect(error.detail).toBe("Credit balance is too low");
  });

  it("keeps an explicit caller message as the lead when nothing classifies", () => {
    const { error } = executionError("the upstream socket hung up", {
      category: "provider",
      message: "A curated caller message.",
    });
    expect(error.message).toBe(
      "A curated caller message. (the upstream socket hung up)",
    );
  });

  it("derives the curated billing message for a provider credit failure", () => {
    const { error } = executionError("Credit balance is too low", {
      category: "provider",
    });
    expect(error.message).toBe(
      "The AI provider rejected the request: the account credit or billing balance is too low.",
    );
    // detail is untouched so server logs still see the raw cause.
    expect(error.detail).toBe("Credit balance is too low");
  });

  it("appends a sanitized snippet for an unknown provider cause", () => {
    const { error } = executionError("the upstream socket hung up", {
      category: "provider",
    });
    expect(error.message).toBe(
      "An external service could not complete this block. (the upstream socket hung up)",
    );
  });

  // AIW-254 flips this deliberately: the plain generic text is the output the
  // ticket exists to remove.
  it("names candidate causes and the LOGS tab when detail is empty", () => {
    const { error } = executionError("   ", { category: "provider" });
    expect(error.message).toContain(
      "An external service could not complete this block.",
    );
    expect(error.message).toContain("Likely causes:");
    expect(error.message).toContain("LOGS tab");
  });
});

describe("executeGraph multi-trigger", () => {
  it("walks only the entry trigger's chain", async () => {
    const graph = graphFrom(
      [
        node("trigA", "trigger_ticket_ai"),
        node("trigB", "trigger_ticket_ai"),
        node("a1", "planning_agent"),
        node("b1", "implementation_agent"),
      ],
      [
        { from: "trigA", to: "a1" },
        { from: "trigB", to: "b1" },
      ],
    );
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph,
      entryTriggerId: "trigB",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["b1"]);
    expect(graph.triggers.map((t) => t.id).sort()).toEqual(["trigA", "trigB"]);
  });
});

describe("executeGraph execution cap", () => {
  it("stops with an engine failure once the cap is exceeded", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("loop", "loop", { maxAttempts: 1000, onExhaust: "fail" }),
        node("body", "implementation_agent"),
      ],
      [
        { from: "trig", to: "loop" },
        { from: "loop", to: "body", fromPort: "continue" },
        { from: "body", to: "loop" },
      ],
    );
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
      maxTotalExecutions: 5,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].phase).toBe("engine");
    expect(rec.failures[0].reason).toBe(
      "The workflow engine could not continue. (workflow exceeded the maximum of 5 block executions) Diagnostic ID: AIW-DIAG-test-run-body-3",
    );
  });
});

describe("executeGraph steps propagation", () => {
  it("resolves trigger, step, and run bindings before invoking an executor", async () => {
    const target = node("target", "send_slack_message");
    target.inputs = {
      fromTrigger: "trigger.review.body",
      fromStep: "steps.source.output.data.summary",
      fromRun: "run.defaultAgent.model",
    };
    const graph = graphFrom(
      [node("trig", "trigger_pr_review"), node("source", "generic_agent"), target],
      [
        { from: "trig", to: "source" },
        { from: "source", to: "target" },
      ],
    );
    const rec = makeRecorder();
    let received: Record<string, unknown> | undefined;
    const { executor } = makeExecutor(
      { source: { kind: "next", output: { status: "ok", data: { summary: "ready" } } } },
      (block, _steps, resolvedInputs) => {
        if (block.id === "target") received = resolvedInputs;
      },
    );

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired", review: { body: "please fix" } },
      runValues: {
        id: "run-1",
        branchName: "ai-workflow/AIW-92",
        defaultAgent: { provider: "codex", model: "gpt-5-codex" },
      },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("completed");
    expect(received).toEqual({
      fromTrigger: "please fix",
      fromStep: "ready",
      fromRun: "gpt-5-codex",
    });
  });

  it("fails closed in the bindings phase without invoking the executor", async () => {
    const target = node("target", "send_slack_message");
    target.inputs = { message: "trigger.missing" };
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), target],
      [{ from: "trig", to: "target" }],
    );
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      runValues: {
        id: "run-1",
        branchName: "branch",
        defaultAgent: { provider: "claude", model: "model" },
      },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("stopped");
    expect(calls).toEqual([]);
    expect(rec.failures).toEqual([
      {
        phase: "bindings",
        reason:
          'A block input could not be resolved. (binding "trigger.missing" could not be resolved) Diagnostic ID: AIW-DIAG-test-run-target-1',
        nodeId: "target",
      },
    ]);
    expect(finishStatuses(rec, "target")).toEqual(["fail"]);
  });

  it("resolves loop bindings from the latest step output on every iteration", async () => {
    const consumer = node("consumer", "send_slack_message");
    consumer.inputs = { message: "steps.producer.output.value" };
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("loop", "loop", { maxAttempts: 2, onExhaust: "continue" }),
        node("producer", "generic_agent"),
        consumer,
        node("done", "terminate", { terminalStatus: "done" }),
      ],
      [
        { from: "trig", to: "loop" },
        { from: "loop", to: "producer", fromPort: "continue" },
        { from: "producer", to: "consumer" },
        { from: "consumer", to: "loop" },
        { from: "loop", to: "done", fromPort: "exhausted" },
      ],
    );
    const rec = makeRecorder();
    const seen: unknown[] = [];
    let producerAttempt = 0;
    const executor: BlockExecutor = async (
      block,
      _steps,
      resolvedInputs,
    ): Promise<BlockExecutionResult> => {
      if (block.id === "producer") {
        producerAttempt += 1;
        return { kind: "next", output: { status: "ok", value: producerAttempt } };
      }
      if (block.id === "consumer") seen.push(resolvedInputs.message);
      return { kind: "next", output: { status: "ok" } };
    };

    await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "fired" },
      runValues: {
        id: "run-1",
        branchName: "branch",
        defaultAgent: { provider: "claude", model: "model" },
      },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(seen).toEqual([1, 2]);
  });

  it("lets later blocks read earlier outputs and increments loop attempts", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("a", "planning_agent"),
        node("b", "implementation_agent"),
        node("c", "open_pr"),
      ],
      [
        { from: "trig", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    const rec = makeRecorder();
    const seen: Record<string, string[]> = {};
    const { executor } = makeExecutor(
      { a: { kind: "next", output: { status: "ok", value: 42 } } },
      (block, steps) => {
        seen[block.id] = Object.keys(steps);
      },
    );
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(seen.c).toEqual(expect.arrayContaining(["trig", "a", "b"]));
    expect(result.steps.a.output.value).toBe(42);
  });

  it("normalizes a missing entry trigger through the execution-error path", async () => {
    const graph = graphFrom([node("trig", "trigger_ticket_ai")], []);
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph,
      entryTriggerId: "ghost",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(result.outcome).toBe("stopped");
    expect(result.executionError).toMatchObject({
      category: "engine",
      diagnosticId: "AIW-DIAG-test-run-ghost-1",
      nodeId: "ghost",
    });
    expect(rec.failures).toEqual([
      expect.objectContaining({ phase: "engine", nodeId: "ghost" }),
    ]);
  });
});

describe("executeGraph resists the v2 loop-region duplication class of bug", () => {
  /**
   * The same customer-authored shape as
   * scenarios/loop-branch-early-exit.scenario.test.ts (AIW-228/AIW-242), rebuilt
   * here with v1's node/edge shape: a Loop whose body a Branch can exit early,
   * wired both directly from outside the loop ("seed" to "loop") and through the
   * Loop's own "continue" port ("loop" to "work").
   *
   * In v2 that shape duplicated the region: an activation-scope model let a
   * fresh child scope re-run "work" after the Branch had already left it
   * (AIW-242). v1 has no activation scopes to duplicate, for two mechanical
   * reasons this test pins:
   *
   *   1. buildRuntimeGraph's outEdges map keeps one target per (node, port)
   *      pair. "seed" wires to both "loop" and "work" on its default port here,
   *      and the second edge silently overwrites the first rather than opening
   *      a second live path.
   *   2. executeGraph walks a single `current` cursor through the graph. There
   *      is no scope for that cursor to fork into, so nothing can admit the
   *      same node twice within one pass.
   */
  it("executes a block in a contested loop region exactly once per pass", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("seed", "generic_agent"),
        node("loop", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("work", "generic_agent"),
        node("gate", "branch", {
          condition: "steps.work.output.verdict == 'accept'",
        }),
        node("done", "terminate", { terminalStatus: "done" }),
        node("giveup", "terminate", { terminalStatus: "failed" }),
      ],
      [
        { from: "trig", to: "seed" },
        // Both leave "seed" on its default port: the second wins in v1's
        // outEdges map, which is mechanism 1 above.
        { from: "seed", to: "loop" },
        { from: "seed", to: "work" },
        { from: "loop", to: "work", fromPort: "continue" },
        { from: "work", to: "gate" },
        { from: "gate", to: "loop", fromPort: "false" },
        { from: "gate", to: "done", fromPort: "true" },
        { from: "loop", to: "giveup", fromPort: "exhausted" },
      ],
    );
    const rec = makeRecorder();
    const workCalls: number[] = [];
    const executor: BlockExecutor = async (block) => {
      const output: BlockOutput =
        block.id === "work"
          ? { status: "completed", verdict: "accept" }
          : { status: "completed" };
      if (block.id === "work") workCalls.push(workCalls.length + 1);
      return { kind: "next", output };
    };

    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });

    expect(workCalls).toEqual([1]);
    expect(attemptsFor(rec, "work")).toEqual([1]);
    // Mechanism 1, pinned directly: "seed"'s edge to "loop" was overwritten by
    // its edge to "work", so the walk never reaches "loop" at all on this pass.
    expect(attemptsFor(rec, "loop")).toEqual([]);
    expect(result.outcome).toBe("stopped");
    expect(rec.terminations).toEqual([
      { params: { terminalStatus: "done", postComment: undefined }, nodeId: "done" },
    ]);
  });
});
