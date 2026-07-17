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
  onCall?: (block: WorkflowDefinitionNode, steps: StepsRecord) => void,
): { executor: BlockExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: BlockExecutor = async (block, steps) => {
    calls.push(block.id);
    onCall?.(block, steps);
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
