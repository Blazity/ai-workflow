import { describe, expect, it } from "vitest";
import type {
  BlockRunState,
  WorkflowBlockType,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  buildRuntimeGraph,
  executeGraph,
  type BlockExecutionResult,
  type BlockExecutor,
  type ExecuteGraphHooks,
  type RuntimeGraph,
  type StepsRecord,
} from "./interpreter.js";

function node(
  id: string,
  type: WorkflowBlockType,
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
    async clarificationExit(questions, nodeId, suggestedAnswers) {
      clarifications.push({ questions, nodeId, suggestedAnswers });
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
      "steps.trig.output.failures: expected boolean, got array",
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
    expect(rec.failures[0]?.reason).toMatch(/maximum of 2 block executions/);
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
      checks: { kind: "failed", output: { status: "failed" }, reason: "lint broke", phase: "checks" },
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
    expect(rec.failures).toEqual([]);
    expect(finishStatuses(rec, "checks")).toEqual(["fail"]);
    expect(rec.finishes[0].state.error).toBe("lint broke");
  });

  it("calls failureExit with the phase when no failure edge is wired", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      checks: { kind: "failed", output: { status: "failed" }, reason: "lint broke", phase: "checks" },
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
    expect(rec.failures[0].reason).toBe("lint broke");
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
    expect(rec.failures[0].reason).toContain("maximum of 5 block executions");
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
        reason: 'binding "trigger.missing" could not be resolved',
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

  it("throws when the entry trigger is missing from the graph", async () => {
    const graph = graphFrom([node("trig", "trigger_ticket_ai")], []);
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    await expect(
      executeGraph({
        graph,
        entryTriggerId: "ghost",
        triggerOutput: { status: "ok" },
        executeBlock: executor,
        hooks: rec.hooks,
      }),
    ).rejects.toThrow(/entry trigger/);
  });
});
