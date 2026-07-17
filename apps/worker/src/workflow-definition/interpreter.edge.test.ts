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

// A single interleaved log every hook (and the executor) pushes into, so tests
// can assert cross-hook ordering that the separate arrays cannot express.
type Event = { type: string; nodeId: string; attempt?: number };

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
  events: Event[];
}

function makeRecorder(): Recorder {
  const starts: Recorder["starts"] = [];
  const finishes: Recorder["finishes"] = [];
  const clarifications: Recorder["clarifications"] = [];
  const failures: Recorder["failures"] = [];
  const terminations: Recorder["terminations"] = [];
  const events: Event[] = [];
  const hooks: ExecuteGraphHooks = {
    async onBlockStart(nodeId, attempt) {
      starts.push({ nodeId, attempt });
      events.push({ type: "start", nodeId, attempt });
    },
    async onBlockFinish(nodeId, state) {
      finishes.push({ nodeId, state });
      events.push({ type: "finish", nodeId, attempt: state.attempt });
    },
    async clarificationExit(questions, nodeId) {
      clarifications.push({ questions, nodeId });
      events.push({ type: "clarify", nodeId });
    },
    async failureExit(phase, reason, nodeId) {
      failures.push({ phase, reason, nodeId });
      events.push({ type: "fail", nodeId });
    },
    async terminate(params, nodeId) {
      terminations.push({ params, nodeId });
      events.push({ type: "terminate", nodeId });
    },
  };
  return { hooks, starts, finishes, clarifications, failures, terminations, events };
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

// Flexible loop builder: maxAttempts may be omitted or non-numeric to exercise
// the Number(...) NaN path. trig -> loop; loop continue -> body -> loop.
function loopGraph(opts: {
  maxAttempts?: WorkflowParamValue;
  onExhaust: string;
  wireExhausted: boolean;
  loopName?: string;
}): RuntimeGraph {
  const params: Record<string, WorkflowParamValue> = { onExhaust: opts.onExhaust };
  if (opts.maxAttempts !== undefined) params.maxAttempts = opts.maxAttempts;
  const nodes = [
    node("trig", "trigger_ticket_ai"),
    node("loop", "loop", params, opts.loopName),
    node("body", "implementation_agent"),
    node("end", "open_pr"),
  ];
  const edges: WorkflowDefinitionEdge[] = [
    { from: "trig", to: "loop" },
    { from: "loop", to: "body", fromPort: "continue" },
    { from: "body", to: "loop" },
  ];
  if (opts.wireExhausted) edges.push({ from: "loop", to: "end", fromPort: "exhausted" });
  return graphFrom(nodes, edges);
}

describe("interpreter edge: entry and dangling targets", () => {
  it("completes immediately when the entry trigger has no outgoing edge", async () => {
    const graph = graphFrom([node("trig", "trigger_ticket_ai")], []);
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
    expect(calls).toEqual([]);
    expect(Object.keys(result.steps)).toEqual(["trig"]);
    expect(rec.starts).toEqual([]);
  });

  it("fails via engine when an edge points at a node id absent from the graph", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai")],
      [{ from: "trig", to: "ghost" }],
    );
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].phase).toBe("engine");
    expect(rec.failures[0].reason).toContain('unknown block "ghost"');
    expect(rec.failures[0].nodeId).toBe("ghost");
  });
});

describe("interpreter edge: execution cap", () => {
  it("uses the default cap of 200 when maxTotalExecutions is omitted", async () => {
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
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].phase).toBe("engine");
    expect(rec.failures[0].reason).toContain("maximum of 200 block executions");
  });

  it("runs exactly N blocks at the cap and fails the N+1th without starting it", async () => {
    const nodes = [
      node("trig", "trigger_ticket_ai"),
      node("a", "planning_agent"),
      node("b", "implementation_agent"),
      node("c", "open_pr"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "trig", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];

    // Cap exactly matches the 3-block chain: it completes.
    const recAtCap = makeRecorder();
    const { executor: execAtCap } = makeExecutor();
    const atCap = await executeGraph({
      graph: graphFrom(nodes, edges),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: execAtCap,
      hooks: recAtCap.hooks,
      maxTotalExecutions: 3,
    });
    expect(atCap.outcome).toBe("completed");
    expect(recAtCap.starts).toHaveLength(3);

    // One below the chain length: the over-cap node never starts or finishes.
    const recBelow = makeRecorder();
    const { executor: execBelow } = makeExecutor();
    const below = await executeGraph({
      graph: graphFrom(nodes, edges),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: execBelow,
      hooks: recBelow.hooks,
      maxTotalExecutions: 2,
    });
    expect(below.outcome).toBe("stopped");
    expect(recBelow.starts).toHaveLength(2);
    expect(recBelow.starts.some((s) => s.nodeId === "c")).toBe(false);
    expect(recBelow.finishes.some((f) => f.nodeId === "c")).toBe(false);
    expect(recBelow.failures[0].nodeId).toBe("c");
  });
});

describe("interpreter edge: branch", () => {
  it("fails via failureExit when the condition param is missing", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("br", "branch", {})],
      [{ from: "trig", to: "br" }],
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
    expect(rec.failures[0].phase).toBe("branch");
    expect(finishStatuses(rec, "br")).toEqual(["fail"]);
  });

  it("fails via failureExit when the condition references a block that never ran", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("br", "branch", { condition: "steps.ghost.output.ok" })],
      [{ from: "trig", to: "br" }],
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
    expect(rec.failures[0].phase).toBe("branch");
    expect(rec.failures[0].nodeId).toBe("br");
    expect(rec.failures[0].reason).toMatch(/block "ghost" which has not produced an output/);
    expect(finishStatuses(rec, "br")).toEqual(["fail"]);
  });

  it("routes on an earlier action block's accumulated output", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("a", "planning_agent"),
        node("br", "branch", { condition: "steps.a.output.approved == true" }),
        node("yes", "open_pr"),
        node("no", "send_slack_message"),
      ],
      [
        { from: "trig", to: "a" },
        { from: "a", to: "br" },
        { from: "br", to: "yes", fromPort: "true" },
        { from: "br", to: "no", fromPort: "false" },
      ],
    );
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor({
      a: { kind: "next", output: { status: "ok", approved: true } },
    });
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toContain("yes");
    expect(calls).not.toContain("no");
  });

  it("completes with no downstream calls when the taken port is unwired", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("br", "branch", { condition: "true" }),
        node("no", "send_slack_message"),
      ],
      // Only the false edge is wired, but the condition evaluates true.
      [
        { from: "trig", to: "br" },
        { from: "br", to: "no", fromPort: "false" },
      ],
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
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual([]);
    expect(rec.failures).toEqual([]);
  });
});

describe("interpreter edge: loop exhaustion", () => {
  it("completes silently when onExhaust=continue and the exhausted port is unwired", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({ maxAttempts: 2, onExhaust: "continue", wireExhausted: false }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(rec.failures).toEqual([]);
    expect(rec.clarifications).toEqual([]);
    const loopFinishes = finishStatuses(rec, "loop");
    expect(loopFinishes[loopFinishes.length - 1]).toBe("ok");
  });

  it("falls back to the node id in the clarification message for an unnamed loop", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({ maxAttempts: 1, onExhaust: "human", wireExhausted: true }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.clarifications).toHaveLength(1);
    expect(rec.clarifications[0].questions[0]).toContain('Loop "loop"');
  });

  it("treats an unknown onExhaust value like fail when no exhausted edge exists", async () => {
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({ maxAttempts: 1, onExhaust: "bogus", wireExhausted: false }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0].phase).toBe("loop");
  });

  it("exhausts on the first visit when maxAttempts is non-numeric (NaN)", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({ maxAttempts: "x", onExhaust: "fail", wireExhausted: false }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(calls).not.toContain("body");
    expect(rec.failures[0].reason).toContain("NaN");
    expect(finishStatuses(rec, "loop")).toEqual(["fail"]);
  });

  it("exhausts immediately when maxAttempts is 0, never running the body", async () => {
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor();
    const result = await executeGraph({
      graph: loopGraph({ maxAttempts: 0, onExhaust: "continue", wireExhausted: true }),
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).not.toContain("body");
    expect(calls).toContain("end");
    expect(finishStatuses(rec, "loop")).toEqual(["ok"]);
  });

  it("feeds the exhausted loop output into a downstream branch", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("loop", "loop", { maxAttempts: 2, onExhaust: "continue" }),
        node("body", "implementation_agent"),
        node("br", "branch", { condition: "steps.loop.output.attempt == 2" }),
        node("yes", "open_pr"),
        node("no", "send_slack_message"),
      ],
      [
        { from: "trig", to: "loop" },
        { from: "loop", to: "body", fromPort: "continue" },
        { from: "body", to: "loop" },
        { from: "loop", to: "br", fromPort: "exhausted" },
        { from: "br", to: "yes", fromPort: "true" },
        { from: "br", to: "no", fromPort: "false" },
      ],
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
    expect(result.outcome).toBe("completed");
    expect(calls).toContain("yes");
    expect(calls).not.toContain("no");
  });

  it("runs the body once and completes when continue does not loop back", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("loop", "loop", { maxAttempts: 5, onExhaust: "fail" }),
        node("body", "implementation_agent"),
        node("end", "open_pr"),
      ],
      // continue -> body -> end, with no edge back to the loop.
      [
        { from: "trig", to: "loop" },
        { from: "loop", to: "body", fromPort: "continue" },
        { from: "body", to: "end" },
      ],
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
    expect(result.outcome).toBe("completed");
    expect(attemptsFor(rec, "loop")).toEqual([1]);
    expect(calls).toContain("body");
    expect(calls).toContain("end");
  });
});

describe("interpreter edge: terminate", () => {
  it("passes postComment undefined when the param is absent", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("term", "terminate", { terminalStatus: "done" }),
      ],
      [{ from: "trig", to: "term" }],
    );
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.terminations).toEqual([
      { params: { terminalStatus: "done", postComment: undefined }, nodeId: "term" },
    ]);
  });

  it("defaults the finish status to ok for an unknown terminalStatus and passes it through", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("term", "terminate", { terminalStatus: "bogus" }),
      ],
      [{ from: "trig", to: "term" }],
    );
    const rec = makeRecorder();
    const { executor } = makeExecutor();
    await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(finishStatuses(rec, "term")).toEqual(["ok"]);
    expect(rec.terminations[0].params.terminalStatus).toBe("bogus");
  });
});

describe("interpreter edge: action ports", () => {
  it("routes down an explicit wirable port on a next result", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("checks", "run_pre_pr_checks"),
        node("recover", "send_slack_message"),
      ],
      [
        { from: "trig", to: "checks" },
        { from: "checks", to: "recover", fromPort: "failed" },
      ],
    );
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor({
      checks: { kind: "next", output: { status: "ok" }, port: "failed" },
    });
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["checks", "recover"]);
    expect(rec.failures).toEqual([]);
  });

  it("fails via engine when a next result names an unwirable port", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("checks", "run_pre_pr_checks")],
      [{ from: "trig", to: "checks" }],
    );
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      checks: { kind: "next", output: { status: "ok" }, port: "nope" },
    });
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures[0].phase).toBe("engine");
    expect(rec.failures[0].reason).toContain('unknown port "nope"');
  });

  it("fails via engine when a portless block returns next with no port", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("sp", "send_plan_approval")],
      [{ from: "trig", to: "sp" }],
    );
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      sp: { kind: "next", output: { status: "ok" } },
    });
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures[0].phase).toBe("engine");
    expect(rec.failures[0].reason).toContain("unknown port");
  });
});

describe("interpreter edge: truncation and failed routing", () => {
  it("truncates a needs_human_input finish error to 500 chars but not the clarification questions", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("plan", "planning_agent")],
      [{ from: "trig", to: "plan" }],
    );
    const questions = ["x".repeat(300), "y".repeat(300)];
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      plan: { kind: "needs_human_input", output: { status: "blocked" }, questions },
    });
    await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(rec.finishes[0].state.error?.length).toBe(500);
    expect(rec.clarifications[0].questions).toEqual(questions);
  });

  it("uses node.type as the phase when a failed result omits phase", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("checks", "run_pre_pr_checks")],
      [{ from: "trig", to: "checks" }],
    );
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      checks: { kind: "failed", output: { status: "failed" }, reason: "x" },
    });
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("stopped");
    expect(rec.failures[0].phase).toBe("run_pre_pr_checks");
  });

  it("truncates a long failed reason to 500 in both the finish error and failureExit reason", async () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("checks", "run_pre_pr_checks")],
      [{ from: "trig", to: "checks" }],
    );
    const reason = "z".repeat(600);
    const rec = makeRecorder();
    const { executor } = makeExecutor({
      checks: { kind: "failed", output: { status: "failed" }, reason, phase: "checks" },
    });
    await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(finishStatuses(rec, "checks")).toEqual(["fail"]);
    expect(rec.finishes[0].state.error?.length).toBe(500);
    expect(rec.failures[0].reason.length).toBe(500);
  });

  it("accumulates a routed failed output for a downstream branch to read", async () => {
    const graph = graphFrom(
      [
        node("trig", "trigger_ticket_ai"),
        node("checks", "run_pre_pr_checks"),
        node("br", "branch", { condition: 'steps.checks.output.status == "failed"' }),
        node("yes", "open_pr"),
        node("no", "send_slack_message"),
      ],
      [
        { from: "trig", to: "checks" },
        { from: "checks", to: "br", fromPort: "failed" },
        { from: "br", to: "yes", fromPort: "true" },
        { from: "br", to: "no", fromPort: "false" },
      ],
    );
    const rec = makeRecorder();
    const { executor, calls } = makeExecutor({
      checks: { kind: "failed", output: { status: "failed" }, reason: "x", phase: "checks" },
    });
    const result = await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toContain("yes");
    expect(calls).not.toContain("no");
    expect(rec.failures).toEqual([]);
    expect(result.steps.checks.output.status).toBe("failed");
  });
});

describe("interpreter edge: hook ordering and attempts", () => {
  it("interleaves start -> executeBlock -> finish per node, finishing each before the next starts", async () => {
    const graph = graphFrom(
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
    const rec = makeRecorder();
    // The executor pushes into the same events log to prove it runs between start and finish.
    const { executor } = makeExecutor({}, (block) => {
      rec.events.push({ type: "exec", nodeId: block.id });
    });
    await executeGraph({
      graph,
      entryTriggerId: "trig",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks: rec.hooks,
    });
    expect(rec.events).toEqual([
      { type: "start", nodeId: "plan", attempt: 1 },
      { type: "exec", nodeId: "plan" },
      { type: "finish", nodeId: "plan", attempt: 1 },
      { type: "start", nodeId: "impl", attempt: 1 },
      { type: "exec", nodeId: "impl" },
      { type: "finish", nodeId: "impl", attempt: 1 },
    ]);
  });

  it("matches each onBlockFinish attempt to its onBlockStart attempt for a looping body", async () => {
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
    expect(rec.finishes.filter((f) => f.nodeId === "body").map((f) => f.state.attempt)).toEqual([
      1, 2,
    ]);
  });
});

describe("interpreter edge: buildRuntimeGraph", () => {
  it("skips edges whose source node is missing and lets the last edge from a port win", () => {
    const graph = graphFrom(
      [node("trig", "trigger_ticket_ai"), node("a", "planning_agent"), node("b", "open_pr")],
      [
        { from: "missing", to: "a" },
        { from: "trig", to: "a" },
        { from: "trig", to: "b" },
      ],
    );
    expect(graph.outEdges.has("missing")).toBe(false);
    // Both edges leave trig's default "out" port; the Map keeps the last one.
    expect(graph.outEdges.get("trig")?.get("out")).toBe("b");
  });
});
