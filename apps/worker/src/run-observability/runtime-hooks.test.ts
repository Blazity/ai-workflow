import { describe, expect, it, vi } from "vitest";
import type {
  BlockOutput,
  JsonValue,
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import type { BlockExecutionResult } from "../workflow-definition/interpreter.js";
import {
  executeV2Graph,
  type V2InvocationIdentity,
} from "../workflow-definition/v2-scheduler.js";
import {
  buildV2ReplayGraphSnapshot,
  createV2RunObservationHooks,
  type RunObservationAttemptFinish,
  type V2RunObservationSink,
} from "./runtime-hooks.js";

const STARTED_AT = new Date("2026-07-23T10:00:00.000Z");
const COMPLETED_AT = new Date("2026-07-23T10:00:03.000Z");

function sink(): V2RunObservationSink & {
  start: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  updateWaiting: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  markUnavailable: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn().mockResolvedValue(41),
    observe: vi.fn().mockResolvedValue(undefined),
    updateWaiting: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    markUnavailable: vi.fn().mockResolvedValue(undefined),
  };
}

interface RecordedAttempt {
  id: number;
  identity: V2InvocationIdentity;
  startedAt: Date;
  observations: Array<{ kind: string; value: unknown }>;
  finish?: RunObservationAttemptFinish;
  completedAt?: Date;
}

function recordingSink(): {
  attempts: RecordedAttempt[];
  sink: V2RunObservationSink;
} {
  let nextId = 1;
  const attempts: RecordedAttempt[] = [];
  const attempt = (attemptId: number) => {
    const found = attempts.find((candidate) => candidate.id === attemptId);
    if (!found) throw new Error(`unknown attempt ${attemptId}`);
    return found;
  };
  return {
    attempts,
    sink: {
      async start(identity, startedAt) {
        const id = nextId;
        nextId += 1;
        attempts.push({
          id,
          identity: { ...identity },
          startedAt,
          observations: [],
        });
        return id;
      },
      async observe(attemptId, observation) {
        attempt(attemptId).observations.push(structuredClone(observation));
      },
      async updateWaiting() {},
      async finish(attemptId, finish, completedAt) {
        attempt(attemptId).finish = structuredClone(finish);
        attempt(attemptId).completedAt = completedAt;
      },
      async markUnavailable() {},
    },
  };
}

function workflowNode(
  id: string,
  type: WorkflowBlockType,
  configuration: Record<string, JsonValue> = {},
): WorkflowDefinitionV2Node {
  return {
    id,
    type,
    x: 0,
    y: 0,
    configuration,
    inputs: {},
    additionalInputs: [],
  };
}

function workflowDefinition(
  nodes: WorkflowDefinitionV2Node[],
  edges: WorkflowDefinitionV2["edges"],
): WorkflowDefinitionV2 {
  return { schemaVersion: 2, nodes, edges };
}

function successfulOutput(node: WorkflowDefinitionV2Node): BlockOutput {
  if (node.type === "transform") {
    return { status: "ok", output: { nodeId: node.id } };
  }
  return { status: "completed", body: `${node.id} completed` };
}

describe("v2 run observation hooks", () => {
  it("builds a presentation-only graph without executable configuration", () => {
    expect(
      buildV2ReplayGraphSnapshot({
        schemaVersion: 2,
        nodes: [
          {
            id: "agent",
            type: "generic_agent",
            name: "Implement",
            x: 12,
            y: 34,
            configuration: { prompt: "private prompt" },
            inputs: {},
            additionalInputs: [],
          },
        ],
        edges: [],
      }),
    ).toEqual({
      nodes: [
        {
          id: "agent",
          type: "generic_agent",
          name: "Implement",
          x: 12,
          y: 34,
        },
      ],
      edges: [],
    });
  });

  it("records metadata, observations, waiting state, and the exact selected edge IDs", async () => {
    const target = sink();
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map([["branch", "branch"]]),
      sink: target,
    });
    const identity = {
      nodeId: "branch",
      attempt: 2,
      activationScopeId: "root/loop:review:1",
    };

    await hooks.onNodeStart?.({ ...identity, startedAt: STARTED_AT });
    await hooks.observationHooksFor?.(identity).emit({
      kind: "input",
      value: { approved: true },
    });
    await hooks.onNodeWaiting?.({
      ...identity,
      state: "waiting_loop",
      selectedTransition: {
        port: "continue",
        edgeIds: ["loop-review"],
      },
    });
    await hooks.onNodeFinish?.({
      ...identity,
      completedAt: COMPLETED_AT,
      runtimeState: "completed",
      selectedTransition: {
        port: "true",
        edgeIds: ["branch-publish", "branch-notify"],
      },
      state: {
        status: "ok",
        attempt: 2,
        output: { status: "ok", path: "true" },
      },
    });
    await hooks.finalize("test_finished");

    expect(target.start).toHaveBeenCalledWith(identity, STARTED_AT);
    expect(target.observe).toHaveBeenNthCalledWith(1, 41, {
      kind: "metadata",
      value: {
        nodeType: "branch",
        activationScopeId: "root/loop:review:1",
      },
    });
    expect(target.observe).toHaveBeenNthCalledWith(2, 41, {
      kind: "input",
      value: { approved: true },
    });
    expect(target.updateWaiting).toHaveBeenCalledWith(41, {
      port: "continue",
      edgeIds: ["loop-review"],
    });
    expect(target.finish).toHaveBeenCalledWith(
      41,
      {
        state: "completed",
        outcome: { kind: "completed", status: "ok" },
        selectedTransition: {
          port: "true",
          edgeIds: ["branch-publish", "branch-notify"],
        },
        diagnosticId: null,
      },
      COMPLETED_AT,
    );
  });

  it("captures trigger activation as a completed attempt", async () => {
    const target = sink();
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map([["trigger", "trigger_ticket_ai"]]),
      sink: target,
    });

    await hooks.onTriggerActivated?.({
      nodeId: "trigger",
      attempt: 1,
      activationScopeId: "root",
      startedAt: STARTED_AT,
      completedAt: STARTED_AT,
      output: { status: "fired", ticketKey: "AIW-134" },
      selectedTransition: {
        port: "out",
        edgeIds: ["trigger-plan"],
      },
    });
    await hooks.finalize("test_finished");

    expect(target.observe).toHaveBeenLastCalledWith(41, {
      kind: "output",
      value: { status: "fired", ticketKey: "AIW-134" },
    });
    expect(target.finish).toHaveBeenCalledWith(
      41,
      expect.objectContaining({
        state: "completed",
        outcome: { kind: "completed", status: "fired" },
        selectedTransition: {
          port: "out",
          edgeIds: ["trigger-plan"],
        },
      }),
      STARTED_AT,
    );
  });

  it("persists a resolved inactive node as a synthetic skipped attempt", async () => {
    const target = sink();
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map([["inactive", "generic_agent"]]),
      sink: target,
    });

    await hooks.onNodeSkipped?.({
      nodeId: "inactive",
      attempt: 1,
      activationScopeId: "root",
      startedAt: STARTED_AT,
      completedAt: STARTED_AT,
    });
    await hooks.finalize("test_finished");

    expect(target.finish).toHaveBeenCalledWith(
      41,
      {
        state: "skipped",
        outcome: { kind: "skipped", status: "skipped" },
        selectedTransition: null,
        diagnosticId: null,
      },
      STARTED_AT,
    );
  });

  it("never lets a sink failure alter scheduler control flow", async () => {
    const target = sink();
    target.start.mockRejectedValueOnce(new Error("database unavailable"));
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map([["agent", "generic_agent"]]),
      sink: target,
    });
    const identity = {
      nodeId: "agent",
      attempt: 1,
      activationScopeId: "root",
    };

    expect(() =>
      hooks.onNodeStart?.({ ...identity, startedAt: STARTED_AT }),
    ).not.toThrow();
    expect(() =>
      hooks.observationHooksFor?.(identity).emit({
        kind: "output",
        value: { status: "completed" },
      }),
    ).not.toThrow();
    expect(() =>
      hooks.onNodeFinish?.({
        ...identity,
        completedAt: COMPLETED_AT,
        runtimeState: "completed",
        selectedTransition: null,
        state: { status: "ok" },
      }),
    ).not.toThrow();
    await hooks.finalize("test_finished");
    expect(target.observe).not.toHaveBeenCalled();
    expect(target.finish).not.toHaveBeenCalled();
  });

  it("starts parallel attempt persistence without blocking authored work", async () => {
    const starts = Array.from(
      { length: 4 },
      () => {
        let resolve!: (value: number | null) => void;
        const promise = new Promise<number | null>((next) => {
          resolve = next;
        });
        return { promise, resolve };
      },
    );
    const target = sink();
    target.start.mockReset();
    starts.forEach((deferred) => {
      target.start.mockReturnValueOnce(deferred.promise);
    });
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map(
        Array.from(
          { length: 4 },
          (_, index) => [`agent-${index}`, "generic_agent"] as const,
        ),
      ),
      sink: target,
    });

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        hooks.onNodeStart?.({
          nodeId: `agent-${index}`,
          attempt: 1,
          activationScopeId: "root",
          startedAt: STARTED_AT,
        }),
      ),
    );

    expect(target.start).toHaveBeenCalledTimes(4);
    expect(starts.every((deferred) => deferred.promise instanceof Promise)).toBe(
      true,
    );

    starts.forEach((deferred, index) => deferred.resolve(index + 1));
    await hooks.finalize("test_finished");
    expect(target.finish).toHaveBeenCalledTimes(4);
  });

  it("stops capture and marks replay unavailable when skipped fan-out exceeds the run cap", async () => {
    const target = sink();
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map([
        ["skip-1", "generic_agent"],
        ["skip-2", "generic_agent"],
        ["skip-3", "generic_agent"],
        ["after-cap", "generic_agent"],
      ]),
      sink: target,
      maxCapturedAttempts: 2,
    });

    for (const nodeId of ["skip-1", "skip-2", "skip-3"]) {
      expect(() =>
        hooks.onNodeSkipped?.({
          nodeId,
          attempt: 1,
          activationScopeId: "root",
          startedAt: STARTED_AT,
          completedAt: STARTED_AT,
        }),
      ).not.toThrow();
    }
    expect(() =>
      hooks.onNodeStart?.({
        nodeId: "after-cap",
        attempt: 1,
        activationScopeId: "root",
        startedAt: STARTED_AT,
      }),
    ).not.toThrow();

    await hooks.finalize("test_finished");

    expect(target.start).toHaveBeenCalledTimes(2);
    expect(target.markUnavailable).toHaveBeenCalledTimes(1);
  });

  it("keeps the same capture cap across clarification resume", async () => {
    const target = sink();
    const definition = workflowDefinition(
      [
        workflowNode("trigger", "trigger_ticket_ai"),
        workflowNode("question", "human_question"),
      ],
      [{ id: "trigger-question", from: "trigger", to: "question" }],
    );
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map(
        definition.nodes.map((node) => [node.id, node.type] as const),
      ),
      sink: target,
      maxCapturedAttempts: 2,
    });
    const executeBlock = async (
      current: WorkflowDefinitionV2Node,
      _steps: unknown,
      _inputs: unknown,
      context: { clarificationAnswer?: string },
    ): Promise<BlockExecutionResult> =>
      context.clarificationAnswer
        ? {
            kind: "next",
            output: {
              status: "answered",
              answer: context.clarificationAnswer,
            },
          }
        : {
            kind: "needs_human_input",
            output: {
              status: "needs_human_input",
              questions: [`Clarify ${current.id}`],
            },
            questions: [`Clarify ${current.id}`],
          };

    const paused = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock,
      hooks,
    });
    expect(paused.outcome).toBe("paused");
    const resumed = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock,
      hooks,
      resume: {
        checkpoint: paused.state,
        clarificationAnswer: "Proceed",
      },
    });
    await hooks.finalize("test_finished");

    expect(resumed.outcome).toBe("completed");
    expect(target.start).toHaveBeenCalledTimes(2);
    expect(target.markUnavailable).toHaveBeenCalledTimes(1);
  });

  it("keeps scheduler boundary timing when attempt persistence is delayed", async () => {
    let resolveAgentStart!: (attemptId: number | null) => void;
    const agentStart = new Promise<number | null>((resolve) => {
      resolveAgentStart = resolve;
    });
    const target = sink();
    target.start.mockImplementation(
      (identity: V2InvocationIdentity) =>
        identity.nodeId === "agent"
          ? agentStart
          : Promise.resolve(1),
    );
    const definition = workflowDefinition(
      [
        workflowNode("trigger", "trigger_ticket_ai"),
        workflowNode("agent", "generic_agent"),
      ],
      [{ id: "trigger-agent", from: "trigger", to: "agent" }],
    );
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map(
        definition.nodes.map((node) => [node.id, node.type] as const),
      ),
      sink: target,
    });
    let boundaryAt = STARTED_AT;

    const result = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      hooks,
      clock: () => boundaryAt,
      executeBlock: async (node) => {
        boundaryAt = COMPLETED_AT;
        return { kind: "next", output: successfulOutput(node) };
      },
    });
    expect(result.outcome).toBe("completed");

    const agentStartCall = target.start.mock.calls.find(
      ([identity]) =>
        (identity as V2InvocationIdentity).nodeId === "agent",
    );
    expect(agentStartCall?.[1]).toEqual(STARTED_AT);
    expect(
      target.finish.mock.calls.some(([attemptId]) => attemptId === 42),
    ).toBe(false);

    boundaryAt = new Date("2026-07-23T11:00:00.000Z");
    resolveAgentStart(42);
    await hooks.finalize("test_finished");

    expect(target.finish).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        state: "completed",
        outcome: { kind: "completed", status: "completed" },
      }),
      COMPLETED_AT,
    );
  });

  it("closes any still-open attempt when capture is finalized", async () => {
    const target = sink();
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map([["agent", "generic_agent"]]),
      sink: target,
    });
    await hooks.onNodeStart?.({
      nodeId: "agent",
      attempt: 1,
      activationScopeId: "root",
      startedAt: STARTED_AT,
    });

    await hooks.finalize("workflow_stopped");

    expect(target.finish).toHaveBeenCalledWith(
      41,
      {
        state: "cancelled",
        outcome: { kind: "cancelled", status: "workflow_stopped" },
        selectedTransition: null,
        diagnosticId: null,
      },
      expect.any(Date),
    );
  });

  it("captures loop-exhaustion resume input and output after the resumed attempt starts", async () => {
    const capture = recordingSink();
    const definition = workflowDefinition(
      [
        workflowNode("trigger", "trigger_ticket_ai"),
        workflowNode("loop", "loop", {
          maxAttempts: 1,
          onExhaust: "human",
        }),
        workflowNode("body", "transform"),
        workflowNode("after", "generic_agent"),
      ],
      [
        { id: "trigger-loop", from: "trigger", to: "loop" },
        {
          id: "loop-body",
          from: "loop",
          fromPort: "continue",
          to: "body",
        },
        { id: "body-loop", from: "body", to: "loop" },
        {
          id: "loop-after",
          from: "loop",
          fromPort: "exhausted",
          to: "after",
        },
      ],
    );
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map(
        definition.nodes.map((node) => [node.id, node.type] as const),
      ),
      sink: capture.sink,
    });
    const executeBlock = async (
      current: WorkflowDefinitionV2Node,
    ): Promise<BlockExecutionResult> => ({
      kind: "next",
      output: successfulOutput(current),
    });

    const paused = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock,
      hooks,
    });
    expect(paused.outcome).toBe("paused");

    const resumed = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock,
      hooks,
      resume: {
        checkpoint: paused.state,
        clarificationAnswer: "Continue",
      },
    });
    expect(resumed.outcome).toBe("completed");
    await hooks.finalize("test_finished");

    const resumedLoop = capture.attempts.find(
      (attempt) =>
        attempt.identity.nodeId === "loop" &&
        attempt.identity.activationScopeId === "root" &&
        attempt.identity.attempt === 3,
    );
    expect(resumedLoop?.observations).toEqual(
      expect.arrayContaining([
        {
          kind: "input",
          value: { clarificationAnswer: "Continue" },
        },
        {
          kind: "output",
          value: {
            status: "exhausted",
            attempt: 1,
            answer: "Continue",
          },
        },
      ]),
    );
    expect(resumedLoop?.finish).toMatchObject({
      state: "completed",
      outcome: { kind: "completed", status: "exhausted" },
      selectedTransition: {
        port: "exhausted",
        edgeIds: ["loop-after"],
      },
    });
    expect(capture.attempts.every((attempt) => attempt.finish)).toBe(true);
  });

  it("preserves the owning loop attempt while a child clarification pauses and resumes", async () => {
    const capture = recordingSink();
    const definition = workflowDefinition(
      [
        workflowNode("trigger", "trigger_ticket_ai"),
        workflowNode("loop", "loop", {
          maxAttempts: 1,
          onExhaust: "continue",
        }),
        workflowNode("question", "human_question"),
        workflowNode("after", "generic_agent"),
      ],
      [
        { id: "trigger-loop", from: "trigger", to: "loop" },
        {
          id: "loop-question",
          from: "loop",
          fromPort: "continue",
          to: "question",
        },
        { id: "question-loop", from: "question", to: "loop" },
        {
          id: "loop-after",
          from: "loop",
          fromPort: "exhausted",
          to: "after",
        },
      ],
    );
    const hooks = createV2RunObservationHooks({
      nodeTypes: new Map(
        definition.nodes.map((node) => [node.id, node.type] as const),
      ),
      sink: capture.sink,
    });
    const executeBlock = async (
      current: WorkflowDefinitionV2Node,
      _steps: unknown,
      _inputs: unknown,
      context: { clarificationAnswer?: string },
    ): Promise<BlockExecutionResult> => {
      if (current.id === "question" && !context.clarificationAnswer) {
        return {
          kind: "needs_human_input",
          output: {
            status: "needs_human_input",
            questions: ["Continue the loop?"],
          },
          questions: ["Continue the loop?"],
        };
      }
      if (current.id === "question") {
        return {
          kind: "next",
          output: {
            status: "answered",
            answer: context.clarificationAnswer!,
          },
        };
      }
      return {
        kind: "next",
        output: successfulOutput(current),
      };
    };

    const paused = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock,
      hooks,
    });
    expect(paused.outcome).toBe("paused");

    const ownerWhilePaused = capture.attempts.find(
      (attempt) =>
        attempt.identity.nodeId === "loop" &&
        attempt.identity.activationScopeId === "root" &&
        attempt.identity.attempt === 1,
    );
    expect(ownerWhilePaused?.finish).toBeUndefined();

    const resumed = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock,
      hooks,
      resume: {
        checkpoint: paused.state,
        clarificationAnswer: "Yes",
      },
    });
    expect(resumed.outcome).toBe("completed");
    await hooks.finalize("test_finished");

    const questionAttempts = capture.attempts.filter(
      (attempt) => attempt.identity.nodeId === "question",
    );
    expect(questionAttempts).toHaveLength(2);
    expect(questionAttempts[0]?.finish).toMatchObject({
      state: "waiting_for_clarification",
      outcome: {
        kind: "paused",
        status: "waiting_for_clarification",
      },
    });
    expect(questionAttempts[1]?.observations).toEqual(
      expect.arrayContaining([
        { kind: "input", value: {} },
        {
          kind: "output",
          value: { status: "answered", answer: "Yes" },
        },
      ]),
    );
    expect(questionAttempts[1]?.finish).toMatchObject({
      state: "completed",
      outcome: { kind: "completed", status: "answered" },
    });
    expect(ownerWhilePaused?.observations).toEqual(
      expect.arrayContaining([
        {
          kind: "output",
          value: { status: "exhausted", attempt: 1 },
        },
      ]),
    );
    expect(ownerWhilePaused?.finish).toMatchObject({
      state: "completed",
      outcome: { kind: "completed", status: "exhausted" },
      selectedTransition: {
        port: "exhausted",
        edgeIds: ["loop-after"],
      },
    });
    expect(capture.attempts.every((attempt) => attempt.finish)).toBe(true);
  });
});
