import { describe, expect, it, vi } from "vitest";
import type {
  BlockOutput,
  JsonValue,
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
  WorkflowInputBindingV2,
} from "@shared/contracts";
import type { BlockExecutionResult } from "./interpreter.js";
import {
  createV2InvocationCancellationController,
  V2InvocationCancelledError,
  type V2InvocationContext,
} from "./invocation-context.js";
import {
  buildV2RuntimeGraph,
  executeV2Graph,
  type V2BlockExecutor,
} from "./v2-scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function node(
  id: string,
  type: WorkflowBlockType,
  configuration: Record<string, JsonValue> = {},
  inputs: Record<string, WorkflowInputBindingV2> = {},
): WorkflowDefinitionV2Node {
  return {
    id,
    type,
    x: 0,
    y: 0,
    configuration,
    inputs,
    additionalInputs: [],
  };
}

function definition(
  nodes: WorkflowDefinitionV2Node[],
  edges: WorkflowDefinitionV2["edges"],
): WorkflowDefinitionV2 {
  return { schemaVersion: 2, nodes, edges };
}

function successfulOutput(node: WorkflowDefinitionV2Node): BlockOutput {
  if (node.type === "generic_agent") {
    return { status: "completed", body: `${node.id} completed` };
  }
  if (node.type === "transform") {
    return { status: "ok", output: { nodeId: node.id } };
  }
  throw new Error(`No successful test output for ${node.type}`);
}

describe("v2 runtime graph", () => {
  it("keeps every same-port edge for fan-out", () => {
    const graph = buildV2RuntimeGraph(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("one", "generic_agent"),
          node("two", "generic_agent"),
        ],
        [
          { id: "to-one", from: "trigger", to: "one" },
          { id: "to-two", from: "trigger", to: "two" },
        ],
      ),
    );

    expect(graph.outgoing.get("trigger")?.map((edge) => edge.id)).toEqual([
      "to-one",
      "to-two",
    ]);
  });
});

describe("executeV2Graph edge tokens", () => {
  it("runs all fan-out targets and waits for every fan-in edge to resolve", async () => {
    const first = deferred<BlockExecutionResult>();
    const second = deferred<BlockExecutionResult>();
    const calls: string[] = [];
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("first", "generic_agent"),
        node("second", "generic_agent"),
        node("join", "transform"),
      ],
      [
        { id: "trigger-first", from: "trigger", to: "first" },
        { id: "trigger-second", from: "trigger", to: "second" },
        { id: "first-join", from: "first", to: "join" },
        { id: "second-join", from: "second", to: "join" },
      ],
    );
    const execution = executeV2Graph({
      definition: def,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock: async (current, steps) => {
        calls.push(current.id);
        if (current.id === "first") return first.promise;
        if (current.id === "second") return second.promise;
        expect(Object.keys(steps)).toEqual(
          expect.arrayContaining(["first", "second"]),
        );
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    await vi.waitFor(() => expect(calls).toEqual(["first", "second"]));
    first.resolve({
      kind: "next",
      output: { status: "completed", body: "first completed" },
    });
    await Promise.resolve();
    expect(calls).not.toContain("join");
    second.resolve({
      kind: "next",
      output: { status: "completed", body: "second completed" },
    });

    const result = await execution;
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["first", "second", "join"]);
    expect(result.state.scopes.root.edgeTokens).toMatchObject({
      "trigger-first": "active",
      "trigger-second": "active",
      "first-join": "active",
      "second-join": "active",
    });
  });

  it("propagates inactive Branch paths so a join does not wait forever", async () => {
    const calls: string[] = [];
    const result = await executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("branch", "branch", {
            condition: { kind: "lit", value: true },
          }),
          node("yes", "generic_agent"),
          node("no", "generic_agent"),
          node("join", "generic_agent"),
        ],
        [
          { id: "trigger-branch", from: "trigger", to: "branch" },
          {
            id: "branch-yes",
            from: "branch",
            fromPort: "true",
            to: "yes",
          },
          {
            id: "branch-no",
            from: "branch",
            fromPort: "false",
            to: "no",
          },
          { id: "yes-join", from: "yes", to: "join" },
          { id: "no-join", from: "no", to: "join" },
        ],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock: async (current) => {
        calls.push(current.id);
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["yes", "join"]);
    expect(result.state.scopes.root.nodeStates.no?.status).toBe("skipped");
    expect(result.state.scopes.root.edgeTokens["no-join"]).toBe("inactive");
  });

  it("resolves non-selected trigger paths as inactive", async () => {
    const calls: string[] = [];
    const result = await executeV2Graph({
      definition: definition(
        [
          node("ticket", "trigger_ticket_ai"),
          node("review", "trigger_pr_review"),
          node("join", "generic_agent"),
        ],
        [
          { id: "ticket-join", from: "ticket", to: "join" },
          { id: "review-join", from: "review", to: "join" },
        ],
      ),
      entryTriggerId: "review",
      triggerOutput: { status: "ok", review: { body: "Looks good" } },
      executeBlock: async (current) => {
        calls.push(current.id);
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["join"]);
    expect(result.state.scopes.root.edgeTokens).toMatchObject({
      "ticket-join": "inactive",
      "review-join": "active",
    });
  });

  it("emits invocation-scoped observations for scheduler-owned Branch blocks", async () => {
    const observations: Array<{
      nodeId: string;
      attempt: number;
      activationScopeId: string;
      kind: string;
      value: unknown;
    }> = [];
    const result = await executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("branch", "branch", {
            condition: { kind: "lit", value: true },
          }),
          node("yes", "generic_agent"),
        ],
        [
          { id: "trigger-branch", from: "trigger", to: "branch" },
          {
            id: "branch-yes",
            from: "branch",
            fromPort: "true",
            to: "yes",
          },
        ],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      hooks: {
        observationHooksFor(identity) {
          return {
            emit(observation) {
              observations.push({ ...identity, ...observation });
            },
          };
        },
      },
      executeBlock: async (current) => ({
        kind: "next",
        output: successfulOutput(current),
      }),
    });

    expect(result.outcome).toBe("completed");
    expect(
      observations.filter((observation) => observation.nodeId === "branch"),
    ).toEqual([
      {
        nodeId: "branch",
        attempt: 1,
        activationScopeId: "root",
        kind: "input",
        value: { condition: { kind: "lit", value: true } },
      },
      {
        nodeId: "branch",
        attempt: 1,
        activationScopeId: "root",
        kind: "output",
        value: { status: "ok", path: "true" },
      },
    ]);
  });
});

describe("executeV2Graph concurrency and failure", () => {
  it("admits at most four block invocations at once", async () => {
    const gates = new Map(
      ["one", "two", "three", "four", "five"].map((id) => [
        id,
        deferred<void>(),
      ]),
    );
    const started: string[] = [];
    let running = 0;
    let maximum = 0;
    const children = [...gates.keys()];
    const run = executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          ...children.map((id) => node(id, "generic_agent")),
        ],
        children.map((id) => ({
          id: `trigger-${id}`,
          from: "trigger",
          to: id,
        })),
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock: async (current) => {
        started.push(current.id);
        running += 1;
        maximum = Math.max(maximum, running);
        await gates.get(current.id)!.promise;
        running -= 1;
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(maximum).toBe(4);
    expect(started).not.toContain("five");

    gates.get("one")!.resolve();
    await vi.waitFor(() => expect(started).toContain("five"));
    for (const gate of gates.values()) gate.resolve();

    expect((await run).outcome).toBe("completed");
    expect(maximum).toBe(4);
  });

  it("promotes execution_error to the run, stops admission, and ignores late results", async () => {
    const slow = deferred<BlockExecutionResult>();
    const calls: string[] = [];
    let slowContext: V2InvocationContext | undefined;
    const finishes: string[] = [];
    const run = executeV2Graph({
      runId: "run-120",
      maxConcurrency: 2,
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("failure", "generic_agent"),
          node("slow", "generic_agent"),
          node("queued", "generic_agent"),
          node("legacy-cleanup", "generic_agent"),
        ],
        [
          { id: "trigger-failure", from: "trigger", to: "failure" },
          { id: "trigger-slow", from: "trigger", to: "slow" },
          { id: "trigger-queued", from: "trigger", to: "queued" },
          {
            id: "legacy-failure-edge",
            from: "failure",
            fromPort: "failed",
            to: "legacy-cleanup",
          },
        ],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      hooks: {
        onNodeFinish(event) {
          finishes.push(event.nodeId);
        },
      },
      executeBlock: async (current, _steps, _inputs, context) => {
        calls.push(current.id);
        if (current.id === "failure") {
          return {
            kind: "execution_error",
            error: {
              category: "provider",
              message: "The provider could not complete this block.",
              detail: "raw provider failure",
            },
          };
        }
        if (current.id === "slow") {
          slowContext = context;
          return slow.promise;
        }
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    let settled = false;
    const trackedRun = run.then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(calls).toEqual(["failure", "slow"]));
    await vi.waitFor(() =>
      expect(slowContext?.cancellation.cancelled).toBe(true),
    );
    expect(settled).toBe(false);
    expect(calls).not.toEqual(
      expect.arrayContaining(["queued", "legacy-cleanup"]),
    );

    slow.resolve({
      kind: "next",
      output: { status: "completed", body: "late result" },
    });
    const result = await trackedRun;
    expect(result.outcome).toBe("failed");
    expect(result.executionError).toMatchObject({
      nodeId: "failure",
      diagnosticId: "AIW-DIAG-run-120-failure-1",
    });
    expect(calls).toEqual(["failure", "slow"]);
    expect(slowContext?.cancellation.cancelled).toBe(true);
    expect(result.state.scopes.root.nodeStates.slow).toMatchObject({
      status: "cancelled",
      attempt: 1,
    });
    expect(result.steps.slow).toBeUndefined();
    expect(finishes).toEqual(["failure", "slow"]);
  });

  it("serializes scheduler hook mutations across concurrent invocations", async () => {
    const firstHookEntered = deferred<void>();
    const releaseFirstHook = deferred<void>();
    let first = true;
    let activeHooks = 0;
    let maximumActiveHooks = 0;

    const run = executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("one", "generic_agent"),
          node("two", "generic_agent"),
        ],
        [
          { id: "trigger-one", from: "trigger", to: "one" },
          { id: "trigger-two", from: "trigger", to: "two" },
        ],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      hooks: {
        async onNodeStart() {
          activeHooks += 1;
          maximumActiveHooks = Math.max(maximumActiveHooks, activeHooks);
          if (first) {
            first = false;
            firstHookEntered.resolve();
            await releaseFirstHook.promise;
          }
          activeHooks -= 1;
        },
      },
      executeBlock: async (current) => ({
        kind: "next",
        output: successfulOutput(current),
      }),
    });

    await firstHookEntered.promise;
    await Promise.resolve();
    expect(maximumActiveHooks).toBe(1);
    releaseFirstHook.resolve();

    expect((await run).outcome).toBe("completed");
    expect(maximumActiveHooks).toBe(1);
  });

  it("promotes an invalid executor output to a top-level schema failure", async () => {
    const result = await executeV2Graph({
      runId: "run-invalid-output",
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("agent", "generic_agent"),
        ],
        [{ id: "trigger-agent", from: "trigger", to: "agent" }],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock: async () => ({
        kind: "next",
        output: { status: "completed" },
      }),
    });

    expect(result.outcome).toBe("failed");
    expect(result.executionError).toMatchObject({
      category: "schema",
      phase: "contract",
      nodeId: "agent",
      diagnosticId: "AIW-DIAG-run-invalid-output-agent-1",
    });
  });
});

describe("executeV2Graph clarification and cancellation", () => {
  it("quiesces siblings, serializes pause state, and resumes the same node with a new attempt", async () => {
    const sibling = deferred<void>();
    const calls: Array<{
      nodeId: string;
      attempt: number;
      answer: string | undefined;
    }> = [];
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("question", "human_question"),
        node("sibling", "generic_agent"),
        node("after-question", "generic_agent", {}, {
          answer: {
            kind: "reference",
            reference: "steps.question.output.answer",
          },
        }),
        node("after-sibling", "generic_agent"),
      ],
      [
        { id: "trigger-question", from: "trigger", to: "question" },
        { id: "trigger-sibling", from: "trigger", to: "sibling" },
        {
          id: "question-after",
          from: "question",
          to: "after-question",
        },
        {
          id: "sibling-after",
          from: "sibling",
          to: "after-sibling",
        },
      ],
    );
    const executor: V2BlockExecutor = async (
      current,
      _steps,
      inputs,
      context,
    ): Promise<BlockExecutionResult> => {
      calls.push({
        nodeId: current.id,
        attempt: context.attempt,
        answer: context.clarificationAnswer,
      });
      if (current.id === "question" && !context.clarificationAnswer) {
        return {
          kind: "needs_human_input",
          output: {
            status: "needs_human_input",
            questions: ["Continue?"],
            suggestedAnswers: ["Yes"],
          },
          questions: ["Continue?"],
          suggestedAnswers: ["Yes"],
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
      if (current.id === "sibling") await sibling.promise;
      if (current.id === "after-question") {
        expect(inputs.answer).toBe("Yes");
      }
      return { kind: "next", output: successfulOutput(current) };
    };

    const firstRun = executeV2Graph({
      definition: def,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
    });
    await vi.waitFor(() =>
      expect(calls.map((call) => call.nodeId)).toEqual([
        "question",
        "sibling",
      ]),
    );
    sibling.resolve();

    const paused = await firstRun;
    expect(paused.outcome).toBe("paused");
    expect(paused.clarification?.questions).toEqual(["Continue?"]);
    expect(
      Object.values(paused.state.scopes.root.nodeStates).some(
        (state) => state.status === "running",
      ),
    ).toBe(false);
    expect(calls.map((call) => call.nodeId)).not.toContain("after-sibling");

    const resumed = await executeV2Graph({
      definition: def,
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      resume: {
        checkpoint: paused.state,
        clarificationAnswer: "Yes",
      },
    });

    expect(resumed.outcome).toBe("completed");
    expect(calls).toContainEqual({
      nodeId: "question",
      attempt: 2,
      answer: "Yes",
    });
    expect(calls.map((call) => call.nodeId)).toEqual(
      expect.arrayContaining(["after-question", "after-sibling"]),
    );
  });

  it("exposes external cancellation to active invocations and aborts scheduling", async () => {
    const controller = createV2InvocationCancellationController();
    let context: V2InvocationContext | undefined;
    const started = deferred<void>();
    const run = executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("slow", "generic_agent"),
        ],
        [{ id: "trigger-slow", from: "trigger", to: "slow" }],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      cancellation: controller.view,
      executeBlock: async (_current, _steps, _inputs, invocation) => {
        context = invocation;
        started.resolve();
        await invocation.cancellation.wait();
        invocation.cancellation.throwIfCancelled();
        return { kind: "next", output: successfulOutput(_current) };
      },
    });

    await started.promise;
    controller.cancel("cancelled by user");

    await expect(run).rejects.toMatchObject({
      name: "V2InvocationCancelledError",
      reason: "cancelled by user",
    } satisfies Partial<V2InvocationCancelledError>);
    expect(context?.cancellation.cancelled).toBe(true);
  });

  it("quiesces every sibling when a completed invocation wins the cancellation race", async () => {
    const controller = createV2InvocationCancellationController();
    const releaseFastSibling = deferred<void>();
    const releaseSlowSibling = deferred<void>();
    const bothStarted = deferred<void>();
    const fastFinished = deferred<void>();
    let started = 0;
    let settled = false;
    const run = executeV2Graph({
      maxConcurrency: 2,
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("fast", "generic_agent"),
          node("slow", "generic_agent"),
        ],
        [
          { id: "trigger-fast", from: "trigger", to: "fast" },
          { id: "trigger-slow", from: "trigger", to: "slow" },
        ],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      cancellation: controller.view,
      hooks: {
        onNodeFinish(event) {
          if (event.nodeId === "fast") fastFinished.resolve();
        },
      },
      executeBlock: async (current, _steps, _inputs, invocation) => {
        started += 1;
        if (started === 2) bothStarted.resolve();
        await bothStarted.promise;
        if (current.id === "fast") {
          await releaseFastSibling.promise;
          return { kind: "next", output: successfulOutput(current) };
        }
        await invocation.cancellation.wait();
        if (current.id === "slow") {
          await releaseSlowSibling.promise;
          invocation.cancellation.throwIfCancelled();
        }
        return { kind: "next", output: successfulOutput(current) };
      },
    }).finally(() => {
      settled = true;
    });

    await bothStarted.promise;
    releaseFastSibling.resolve();
    controller.cancel("cancelled by user");
    await fastFinished.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSlowSibling.resolve();
    await expect(run).rejects.toMatchObject({
      name: "V2InvocationCancelledError",
      reason: "cancelled by user",
    } satisfies Partial<V2InvocationCancelledError>);
  });

  it("cancels and quiesces siblings before rethrowing a run-control error", async () => {
    const fatal = new Error("active run ownership was lost");
    const bothStarted = deferred<void>();
    let started = 0;
    let siblingQuiesced = false;
    const run = executeV2Graph({
      maxConcurrency: 2,
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("owner-check", "generic_agent"),
          node("sibling", "generic_agent"),
        ],
        [
          { id: "trigger-owner", from: "trigger", to: "owner-check" },
          { id: "trigger-sibling", from: "trigger", to: "sibling" },
        ],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      shouldRethrowExecutionError: (error) => error === fatal,
      executeBlock: async (current, _steps, _inputs, invocation) => {
        started += 1;
        if (started === 2) bothStarted.resolve();
        await bothStarted.promise;
        if (current.id === "owner-check") throw fatal;
        await invocation.cancellation.wait();
        siblingQuiesced = true;
        invocation.cancellation.throwIfCancelled();
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    await expect(run).rejects.toBe(fatal);
    expect(siblingQuiesced).toBe(true);
  });
});

describe("executeV2Graph loop scopes", () => {
  it("runs each iteration in a distinct scope with increasing node attempts", async () => {
    const bodyInvocations: Array<{
      attempt: number;
      activationScopeId: string;
    }> = [];
    const result = await executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("loop", "loop", {
            maxAttempts: 2,
            onExhaust: "continue",
          }),
          node("body", "transform"),
          node("after", "generic_agent"),
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
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock: async (current, _steps, inputs, context) => {
        if (current.id === "body") {
          bodyInvocations.push({
            attempt: context.attempt,
            activationScopeId: context.activationScopeId,
          });
          expect(inputs).toEqual({});
        }
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    expect(result.outcome).toBe("completed");
    expect(bodyInvocations).toEqual([
      { attempt: 1, activationScopeId: "root/loop:loop:1" },
      { attempt: 2, activationScopeId: "root/loop:loop:2" },
    ]);
    expect(result.steps.loop?.output).toEqual({
      status: "exhausted",
      attempt: 2,
    });
    expect(result.steps.after?.output.status).toBe("completed");
  });

  it("exits through an active body boundary after an inactive earlier iteration", async () => {
    const calls: string[] = [];
    const loopStarts: string[] = [];
    const loopFinishes: string[] = [];
    const result = await executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("loop", "loop", {
            maxAttempts: 3,
            onExhaust: "continue",
          }),
          node("body", "transform"),
          node("verdict", "branch", {
            condition: {
              kind: "path",
              reference: "steps.body.output.output.succeeded",
            },
          }),
          node("after", "generic_agent"),
        ],
        [
          { id: "trigger-loop", from: "trigger", to: "loop" },
          {
            id: "loop-body",
            from: "loop",
            fromPort: "continue",
            to: "body",
          },
          { id: "body-verdict", from: "body", to: "verdict" },
          {
            id: "verdict-after",
            from: "verdict",
            fromPort: "true",
            to: "after",
          },
          {
            id: "verdict-loop",
            from: "verdict",
            fromPort: "false",
            to: "loop",
          },
          {
            id: "loop-after",
            from: "loop",
            fromPort: "exhausted",
            to: "after",
          },
        ],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      hooks: {
        onNodeStart(identity) {
          if (identity.nodeId === "loop") {
            loopStarts.push(
              `${identity.activationScopeId}:${identity.attempt}`,
            );
          }
        },
        onNodeFinish(identity) {
          if (identity.nodeId === "loop") {
            loopFinishes.push(
              `${identity.activationScopeId}:${identity.attempt}`,
            );
          }
        },
      },
      executeBlock: async (current, _steps, _inputs, context) => {
        calls.push(current.id);
        if (current.id === "body") {
          return {
            kind: "next",
            output: {
              status: "ok",
              output: { succeeded: context.attempt === 2 },
            },
          };
        }
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["body", "body", "after"]);
    expect(result.steps.loop?.output).toEqual({
      status: "ok",
      attempt: 2,
    });
    expect(result.steps.after?.output.status).toBe("completed");
    expect(result.state.scopes.root.edgeTokens).toMatchObject({
      "verdict-after": "active",
      "loop-after": "inactive",
    });
    expect(
      result.state.scopes["root/loop:loop:1"]?.edgeTokens[
        "verdict-after"
      ],
    ).toBe("inactive");
    expect(
      result.state.scopes["root/loop:loop:2"]?.edgeTokens[
        "verdict-after"
      ],
    ).toBe("active");
    expect(loopFinishes).toHaveLength(loopStarts.length);
    expect([...loopFinishes].sort()).toEqual([...loopStarts].sort());
  });

  it("terminates before an ordinary same-port body edge can return to Loop", async () => {
    const calls: string[] = [];
    const loopStarts: string[] = [];
    const loopFinishes: string[] = [];
    const result = await executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("loop", "loop", {
            maxAttempts: 3,
            onExhaust: "continue",
          }),
          node("body", "transform"),
          node("after", "generic_agent"),
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
          { id: "body-after", from: "body", to: "after" },
          {
            id: "loop-after",
            from: "loop",
            fromPort: "exhausted",
            to: "after",
          },
        ],
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      hooks: {
        onNodeStart(identity) {
          if (identity.nodeId === "loop") {
            loopStarts.push(
              `${identity.activationScopeId}:${identity.attempt}`,
            );
          }
        },
        onNodeFinish(identity) {
          if (identity.nodeId === "loop") {
            loopFinishes.push(
              `${identity.activationScopeId}:${identity.attempt}`,
            );
          }
        },
      },
      executeBlock: async (current) => {
        calls.push(current.id);
        return { kind: "next", output: successfulOutput(current) };
      },
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["body", "after"]);
    expect(result.state.scopes.root.edgeTokens).toMatchObject({
      "body-after": "active",
      "loop-after": "inactive",
    });
    expect(
      result.state.scopes["root/loop:loop:1"]?.nodeStates.loop?.status,
    ).toBe("skipped");
    expect(loopFinishes).toHaveLength(loopStarts.length);
    expect([...loopFinishes].sort()).toEqual([...loopStarts].sort());
  });

  it("emits invocation-scoped observations for every scheduler-owned Loop attempt", async () => {
    const observations: Array<{
      nodeId: string;
      attempt: number;
      activationScopeId: string;
      kind: string;
      value: unknown;
    }> = [];
    const starts: string[] = [];
    const finishes: string[] = [];
    const result = await executeV2Graph({
      definition: definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("loop", "loop", {
            maxAttempts: 1,
            onExhaust: "continue",
          }),
          node("body", "transform"),
          node("after", "generic_agent"),
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
      ),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      hooks: {
        onNodeStart(identity) {
          if (identity.nodeId === "loop") {
            starts.push(
              `${identity.activationScopeId}:${identity.attempt}`,
            );
          }
        },
        onNodeFinish(identity) {
          if (identity.nodeId === "loop") {
            finishes.push(
              `${identity.activationScopeId}:${identity.attempt}`,
            );
          }
        },
        observationHooksFor(identity) {
          return {
            emit(observation) {
              observations.push({ ...identity, ...observation });
            },
          };
        },
      },
      executeBlock: async (current) => ({
        kind: "next",
        output: successfulOutput(current),
      }),
    });

    expect(result.outcome).toBe("completed");
    expect(
      observations
        .filter((observation) => observation.nodeId === "loop")
        .map(({ attempt, activationScopeId, kind }) => ({
          attempt,
          activationScopeId,
          kind,
        })),
    ).toEqual([
      { attempt: 1, activationScopeId: "root", kind: "input" },
      {
        attempt: 2,
        activationScopeId: "root/loop:loop:1",
        kind: "input",
      },
      {
        attempt: 2,
        activationScopeId: "root/loop:loop:1",
        kind: "output",
      },
      {
        attempt: 1,
        activationScopeId: "root",
        kind: "output",
      },
    ]);
    expect(
      observations.filter(
        (observation) =>
          observation.nodeId === "loop" &&
          observation.activationScopeId === "root",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "output",
          value: { status: "exhausted", attempt: 1 },
        }),
      ]),
    );
    expect(finishes).toHaveLength(starts.length);
    expect([...finishes].sort()).toEqual([...starts].sort());
  });
});
