import { createHook } from "workflow";
import type {
  BlockOutput,
  BlockRunState,
  JsonValue,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import type { V2InvocationObservation } from "../../src/workflow-definition/invocation-context.js";
import {
  executeV2Graph,
  type V2BlockExecutor,
  type V2InvocationIdentity,
  type V2SchedulerHooks,
} from "../../src/workflow-definition/v2-scheduler.js";

// A probe for AIW-233: production pins V2_MAX_BLOCK_CONCURRENCY to 1 because a
// fan-out of concurrent blocks corrupts the Workflow event log. Everything here
// mirrors the production agent workflow's shape around executeV2Graph, because
// the suspected non-determinism lives in the interleaving of step calls made by
// concurrent invocations, not in any single block:
//   - the interpreter runs inside a "use workflow" function
//   - every persistence hook is a real "use step"
//   - each agent block is a multi-step start/poll/finish chain whose steps take
//     different real time, so completion order differs from admission order
//   - scheduler hooks write closure state and then await a step
//   - replay capture is a fire-and-forget promise chain of steps, exactly like
//     createV2RunObservationHooks

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Steps (each one is a durable event-log entry, like agent.ts's) ---

async function readProbeClockStep(): Promise<number> {
  "use step";
  return Date.now();
}
readProbeClockStep.maxRetries = 0;

async function recordProbeBlockStatusesStep(payload: {
  runId: string;
  blockStatuses: Record<string, BlockRunState>;
}): Promise<void> {
  "use step";
  probeStatusWrites.push(payload.runId);
}
recordProbeBlockStatusesStep.maxRetries = 0;
const probeStatusWrites: string[] = [];

async function startProbeAgentStep(payload: {
  nodeId: string;
  delayMs: number;
}): Promise<{ sandboxId: string }> {
  "use step";
  await sleep(payload.delayMs);
  return { sandboxId: `sbx-${payload.nodeId}` };
}
startProbeAgentStep.maxRetries = 0;

async function pollProbeAgentStep(payload: {
  nodeId: string;
  tick: number;
  delayMs: number;
  ticks: number;
  flakyOnce: boolean;
}): Promise<{ done: boolean }> {
  "use step";
  await sleep(payload.delayMs);
  // Production steps retry. A retry adds step_retrying events and moves the
  // completion of one sibling relative to the others, so the probe covers it.
  if (payload.flakyOnce) {
    const key = `${payload.nodeId}:${payload.tick}`;
    if (!probeFlakedPolls.has(key)) {
      probeFlakedPolls.add(key);
      throw new Error(`transient poll failure for ${key}`);
    }
  }
  return { done: payload.tick >= payload.ticks };
}
const probeFlakedPolls = new Set<string>();

async function finishProbeAgentStep(payload: {
  nodeId: string;
  delayMs: number;
}): Promise<{ feedback: string }> {
  "use step";
  await sleep(payload.delayMs);
  return { feedback: `${payload.nodeId} reviewed the head commit.` };
}
finishProbeAgentStep.maxRetries = 0;

async function runProbeActionStep(payload: {
  nodeId: string;
  delayMs: number;
}): Promise<void> {
  "use step";
  await sleep(payload.delayMs);
}
runProbeActionStep.maxRetries = 0;

async function persistProbeAttemptStartStep(payload: {
  nodeId: string;
  attempt: number;
  activationScopeId: string;
}): Promise<number> {
  "use step";
  probeAttemptIds += 1;
  return probeAttemptIds;
}
persistProbeAttemptStartStep.maxRetries = 0;
let probeAttemptIds = 0;

async function persistProbeObservationStep(payload: {
  attemptId: number;
  kind: string;
}): Promise<void> {
  "use step";
  probeObservationWrites.push(`${payload.attemptId}:${payload.kind}`);
}
persistProbeObservationStep.maxRetries = 0;
const probeObservationWrites: string[] = [];

async function logProbeExecutionErrorStep(payload: {
  nodeId: string;
  diagnosticId: string;
}): Promise<void> {
  "use step";
}
logProbeExecutionErrorStep.maxRetries = 0;

async function persistProbeAttemptFinishStep(payload: {
  attemptId: number;
  state: string;
}): Promise<void> {
  "use step";
}
persistProbeAttemptFinishStep.maxRetries = 0;

// --- Probe input ---

export interface ProbeConcurrentInput {
  runId: string;
  definition: WorkflowDefinitionV2;
  entryTriggerId: string;
  triggerOutput: BlockOutput;
  maxConcurrency: number;
  /** Per-node step timings, so completion order differs from admission order
   * the way three real review agents at 104s / 111s / 68s do. */
  timings: Record<string, { startMs: number; pollMs: number; ticks: number }>;
  /** Nodes that park on a hook mid-flight, so several blocks suspend at once
   * and each resumes across a real replay. */
  parks: Array<{ nodeId: string; token: string; tick: number }>;
  /** Poll ticks that fail once before succeeding, exercising step retries. */
  flakyPolls: Array<{ nodeId: string; tick: number }>;
  /** Synchronous in-VM work per step boundary, standing in for the prompt
   * compilation and output sanitizing a production block does between steps. */
  vmWorkPerStep: number;
  /** Nodes that fail. A failing block reports through a differently named step
   * than a succeeding one, so on a mixed fan-in the order the scheduler consumes
   * results in IS the recorded step-name sequence, even though the graph fans
   * straight back into one block. */
  failNodes: string[];
}

interface PendingCapture {
  attemptId: Promise<number | null>;
  observations: V2InvocationObservation[];
  tail: Promise<void>;
}

export async function probeV2ConcurrentFanOut(input: ProbeConcurrentInput) {
  "use workflow";

  // Closure state written from inside block execution and from the hooks,
  // exactly as agent.ts holds it around executeV2Graph.
  const blockStatuses: Record<string, BlockRunState> = {};
  const activeBlockIds = new Set<string>();
  let currentBlockId: string | null = null;
  const startOrder: string[] = [];
  const finishOrder: string[] = [];
  let lastAttempt = 1;

  const writeBlockStatuses = () =>
    recordProbeBlockStatusesStep({
      runId: input.runId,
      blockStatuses: { ...blockStatuses },
    }).catch(() => {});

  // Fire-and-forget durable capture, mirroring createV2RunObservationHooks:
  // the scheduler never awaits these, so their step calls land between the
  // authored blocks' step calls at whatever moment the event loop allows.
  const captures = new Map<string, PendingCapture>();
  const captureTasks = new Set<Promise<void>>();
  const track = (task: Promise<void>): void => {
    captureTasks.add(task);
    void task.finally(() => captureTasks.delete(task));
  };
  const captureKey = (identity: V2InvocationIdentity): string =>
    `${identity.activationScopeId}\0${identity.nodeId}\0${identity.attempt}`;
  const beginCapture = (identity: V2InvocationIdentity): void => {
    const key = captureKey(identity);
    if (captures.has(key)) return;
    captures.set(key, {
      attemptId: persistProbeAttemptStartStep({
        nodeId: identity.nodeId,
        attempt: identity.attempt,
        activationScopeId: identity.activationScopeId,
      }).then(
        (id) => id,
        () => null,
      ),
      observations: [],
      tail: Promise.resolve(),
    });
  };
  const flushCapture = (identity: V2InvocationIdentity, state: string): void => {
    const key = captureKey(identity);
    const capture = captures.get(key);
    if (!capture) return;
    captures.delete(key);
    const observations = capture.observations.splice(0);
    const task = capture.tail
      .then(async () => {
        const attemptId = await capture.attemptId;
        if (attemptId === null) return;
        for (const observation of observations) {
          await persistProbeObservationStep({
            attemptId,
            kind: observation.kind,
          });
        }
        await persistProbeAttemptFinishStep({ attemptId, state });
      })
      .catch(() => {});
    capture.tail = task;
    track(task);
  };

  const timingFor = (nodeId: string) =>
    input.timings[nodeId] ?? { startMs: 0, pollMs: 0, ticks: 0 };

  // Deterministic in-VM work: it burns microtasks and CPU between a step
  // delivery and the next step call, which is where the runtime's grace window
  // for consuming the next recorded event lives.
  const burnVmWork = (units: number): number => {
    let acc = 0;
    for (let index = 0; index < units; index += 1) {
      acc = (acc * 31 + index) % 1_000_003;
    }
    return acc;
  };
  let vmWorkSink = 0;

  const executeBlock: V2BlockExecutor = async (
    node,
    _steps,
    resolvedInputs,
    invocation,
  ) => {
    invocation.cancellation.throwIfCancelled();
    // The unrecorded closure write AIW-233 suspects: concurrent invocations
    // clobber each other's value here.
    lastAttempt = invocation.attempt;
    const timing = timingFor(node.id);

    if (node.type === "review_agent") {
      vmWorkSink += burnVmWork(input.vmWorkPerStep);
      const sandbox = await startProbeAgentStep({
        nodeId: node.id,
        delayMs: timing.startMs,
      });
      for (let tick = 1; tick <= timing.ticks; tick += 1) {
        const park = input.parks.find(
          (entry) => entry.nodeId === node.id && entry.tick === tick,
        );
        if (park) {
          // A real cross-process suspension in the middle of the fan-out: the
          // siblings keep polling while this one parks on a hook.
          const hook = createHook<{ answer: string }>({ token: park.token });
          try {
            await hook;
          } finally {
            hook.dispose();
          }
        }
        vmWorkSink += burnVmWork(input.vmWorkPerStep);
        const poll = await pollProbeAgentStep({
          nodeId: node.id,
          tick,
          delayMs: timing.pollMs,
          ticks: timing.ticks,
          flakyOnce: input.flakyPolls.some(
            (entry) => entry.nodeId === node.id && entry.tick === tick,
          ),
        });
        if (poll.done) break;
      }
      vmWorkSink += burnVmWork(input.vmWorkPerStep);
      if (input.failNodes.includes(node.id)) {
        return {
          kind: "execution_error",
          error: {
            nodeId: node.id,
            category: "provider",
            message: "The review agent could not complete.",
            detail: `${node.id} failed`,
          },
        } as Awaited<ReturnType<V2BlockExecutor>>;
      }
      const finished = await finishProbeAgentStep({
        nodeId: node.id,
        delayMs: timing.pollMs,
      });
      return {
        kind: "next",
        output: {
          status: "reviewed",
          decision: "approve",
          feedback: `${finished.feedback} (${sandbox.sandboxId})`,
          findings: [],
        },
      };
    }

    await runProbeActionStep({ nodeId: node.id, delayMs: timing.startMs });
    switch (node.type) {
      case "create_pr_check":
        return {
          kind: "next",
          output: {
            status: "ok",
            check: { id: "check-1", headSha: "abc123", name: "AI / Review" },
          },
        };
      case "prepare_workspace":
        return {
          kind: "next",
          output: {
            status: "ok",
            sandboxId: "sbx-probe",
            repositories: ["github:acme/app"],
            workspace: {
              id: "sbx-probe",
              repositories: ["github:acme/app"],
            },
          },
        };
      case "post_pr_review":
        return {
          kind: "next",
          output: {
            status: "ok",
            decision: "approve",
            summary: "Every review approved this commit.",
            inlineCommentCount: 0,
            summaryFallbackCount: 0,
          },
        };
      case "complete_pr_check":
        return {
          kind: "next",
          output: {
            status: "ok",
            check: resolvedInputs.check as BlockOutput[string],
            conclusion: node.configuration.conclusion ?? "success",
          },
        };
      default:
        return { kind: "next", output: { status: "ok" } };
    }
  };

  const hooks: V2SchedulerHooks = {
    onTriggerActivated(event) {
      beginCapture(event);
      flushCapture(event, "completed");
    },
    async onNodeStart(event) {
      // agent.ts's onBlockStart: a budget step, then closure writes, then a
      // status step. Order matters because siblings run the same code.
      await readProbeClockStep();
      currentBlockId = event.nodeId;
      activeBlockIds.add(event.nodeId);
      startOrder.push(event.nodeId);
      blockStatuses[event.nodeId] = {
        status: "running",
        attempt: event.attempt,
      };
      await writeBlockStatuses();
      beginCapture(event);
    },
    async onNodeFinish(event) {
      flushCapture(event, event.runtimeState);
      blockStatuses[event.nodeId] = event.state;
      finishOrder.push(event.nodeId);
      await writeBlockStatuses();
      activeBlockIds.delete(event.nodeId);
      // Set iteration order is insertion order, so this reads back whichever
      // sibling happened to start last in wall-clock terms.
      currentBlockId = [...activeBlockIds].at(-1) ?? null;
      await readProbeClockStep();
    },
    async onNodeSkipped(event) {
      blockStatuses[event.nodeId] = { status: "ok", attempt: event.attempt };
      await writeBlockStatuses();
    },
    async onExecutionError(event) {
      // agent.ts logs a failure through its own step, which is a different step
      // name from the status write a success takes.
      await logProbeExecutionErrorStep({
        nodeId: event.state.nodeId,
        diagnosticId: event.state.diagnosticId,
      });
    },
    observationHooksFor: (identity) => {
      const capture = captures.get(captureKey(identity));
      return {
        emit(observation) {
          if (!capture) return;
          capture.observations.push(structuredClone(observation));
        },
      };
    },
  };

  const walk = await executeV2Graph({
    runId: input.runId,
    definition: input.definition,
    entryTriggerId: input.entryTriggerId,
    triggerOutput: input.triggerOutput,
    executeBlock,
    hooks,
    maxConcurrency: input.maxConcurrency,
  });

  await Promise.allSettled([...captureTasks]);

  return {
    outcome: walk.outcome,
    executionError: walk.executionError ?? null,
    startOrder,
    finishOrder,
    currentBlockId,
    lastAttempt,
    statusWrites: probeStatusWrites.length,
    observationWrites: probeObservationWrites.length,
    vmWorkSink,
    blockStatuses: walk.state.scopes.root
      ? Object.fromEntries(
          Object.entries(walk.state.scopes.root.nodeStates).map(
            ([nodeId, nodeState]) => [nodeId, nodeState.status],
          ),
        )
      : {},
  };
}

// --- Probe 2: does result-consumption order survive a replay? ---
//
// The fan-out probe above cannot answer that, and this is why: post-pr-review
// fans three reviewers straight back into one Post PR review block, so whichever
// order the scheduler consumes the three results in, the next step call is the
// same one. Consuming out of order is therefore invisible to the runtime's
// divergence check, which compares the step NAME behind a correlation id, not
// its arguments.
//
// This probe removes that cover: each concurrent block has its own successor,
// and each successor calls a DIFFERENTLY NAMED step. Now consumption order is
// the step-name sequence. If the scheduler's Promise.race over the running
// invocations can pick a different winner on a replay than the event log
// recorded, this run must die with a replay divergence.
//
// The asymmetry is deliberate: after its own step resolves, each block burns a
// different number of microtask hops before its invocation promise settles.
// That is the exact hazard the SDK documents for hook/wait deliveries and
// guards with pendingDeliveryBarriers, a mechanism that covers hook and wait
// deliveries only, never step completions.

async function branchStepAlpha(delayMs: number): Promise<string> {
  "use step";
  await sleep(delayMs);
  return "alpha";
}
branchStepAlpha.maxRetries = 0;

async function branchStepBeta(delayMs: number): Promise<string> {
  "use step";
  await sleep(delayMs);
  return "beta";
}
branchStepBeta.maxRetries = 0;

async function branchStepGamma(delayMs: number): Promise<string> {
  "use step";
  await sleep(delayMs);
  return "gamma";
}
branchStepGamma.maxRetries = 0;

async function successorStepAlpha(): Promise<string> {
  "use step";
  return "alpha-done";
}
successorStepAlpha.maxRetries = 0;

async function successorStepBeta(): Promise<string> {
  "use step";
  return "beta-done";
}
successorStepBeta.maxRetries = 0;

async function successorStepGamma(): Promise<string> {
  "use step";
  return "gamma-done";
}
successorStepGamma.maxRetries = 0;

export interface ProbeDivergentSuccessorsInput {
  runId: string;
  maxConcurrency: number;
  /** Per-branch step delay and post-step microtask hop count. */
  branches: Array<{ id: string; delayMs: number; hops: number }>;
}

function genericNode(id: string): WorkflowDefinitionV2Node {
  return {
    id,
    type: "generic_agent",
    x: 0,
    y: 0,
    configuration: { workspaceMode: "none" } as Record<string, JsonValue>,
    inputs: {},
    additionalInputs: [],
  };
}

export async function probeV2ConsumptionOrder(
  input: ProbeDivergentSuccessorsInput,
) {
  "use workflow";

  const branchSteps: Record<string, (delayMs: number) => Promise<string>> = {
    alpha: branchStepAlpha,
    beta: branchStepBeta,
    gamma: branchStepGamma,
  };
  const successorSteps: Record<string, () => Promise<string>> = {
    alpha: successorStepAlpha,
    beta: successorStepBeta,
    gamma: successorStepGamma,
  };

  const nodes: WorkflowDefinitionV2Node[] = [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      x: 0,
      y: 0,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
  ];
  const edges: WorkflowDefinitionV2["edges"] = [];
  for (const branch of input.branches) {
    nodes.push(genericNode(branch.id), genericNode(`${branch.id}-next`));
    edges.push({ id: `trigger-${branch.id}`, from: "trigger", to: branch.id });
    edges.push({
      id: `${branch.id}-next-edge`,
      from: branch.id,
      to: `${branch.id}-next`,
    });
  }

  const consumptionOrder: string[] = [];
  const executeBlock: V2BlockExecutor = async (node) => {
    const branch = input.branches.find((entry) => entry.id === node.id);
    if (branch) {
      await branchSteps[branch.id]!(branch.delayMs);
      // Asymmetric settle latency: the invocation promise this block hands to
      // the scheduler's Promise.race resolves a different number of microtask
      // hops after its step did.
      for (let hop = 0; hop < branch.hops; hop += 1) {
        await Promise.resolve();
      }
      return { kind: "next", output: { status: "completed", body: node.id } };
    }
    const successorId = node.id.replace(/-next$/, "");
    await successorSteps[successorId]!();
    return { kind: "next", output: { status: "completed", body: node.id } };
  };

  const walk = await executeV2Graph({
    runId: input.runId,
    definition: { schemaVersion: 2, nodes, edges },
    entryTriggerId: "trigger",
    triggerOutput: { status: "fired", ticket: { identifier: "AIW-1" } },
    executeBlock,
    maxConcurrency: input.maxConcurrency,
    hooks: {
      onNodeFinish(event) {
        // Records the order the scheduler consumed the results in, which is the
        // order it admitted the successors in.
        consumptionOrder.push(event.nodeId);
      },
    },
  });

  return {
    outcome: walk.outcome,
    executionError: walk.executionError ?? null,
    consumptionOrder,
  };
}

// --- Probe 3: the shared budget counter that gates step calls ---
//
// This is the production shape from run wrun_01KZ9AZCJY5GSPM9X3F4J8RH26, whose
// divergence named two steps called from INSIDE concurrent blocks
// (writeAndStartPhase against readRunBudgetClockStep), never a successor's step.
//
// It mirrors agent.ts:2941-2952 and blocks/poll-phase.ts:25-87 exactly:
//   observeSharedBudget() is observeBudgetAtBoundary: a read-modify-write of
//   run-global activeElapsedMs / lastClockMs across an await on a clock step.
//   Every concurrently running block calls it from its own poll loop.
//   pollLoop() is pollPhaseUntilDone: it derives its sleep length from that
//   run-global remainingDurationMs, adds it to a local phase counter, and loops
//   until the counter reaches the cap. So the run-global counter decides HOW
//   MANY times each block calls its steps.
//
// The graph deliberately has NO successors after the concurrent blocks. If this
// diverges, the scheduler's join cannot be the cause and the shared counter is.

async function probeReadClockStep(): Promise<number> {
  "use step";
  // agent.ts's readRunBudgetClockStep: a real wall clock, recorded per call.
  return Date.now();
}
probeReadClockStep.maxRetries = 0;

async function probeStartPhaseStep(payload: { nodeId: string }): Promise<string> {
  "use step";
  return `${payload.nodeId}-command`;
}
probeStartPhaseStep.maxRetries = 0;

async function probeTickStep(payload: { ms: number }): Promise<void> {
  "use step";
  await sleep(payload.ms);
}
probeTickStep.maxRetries = 0;

async function probeCheckDoneStep(payload: {
  nodeId: string;
  tick: number;
  doneAtTick: number;
}): Promise<boolean> {
  "use step";
  return payload.tick >= payload.doneAtTick;
}
probeCheckDoneStep.maxRetries = 0;

export interface ProbeSharedBudgetInput {
  runId: string;
  maxConcurrency: number;
  /** The run-global duration budget, the thing every block charges against. */
  limitMs: number;
  /** Per-block poll cap, pollPhaseUntilDone's maxMinutes. */
  phaseLimitMs: number;
  /** The 30s poll tick. */
  tickMs: number;
  /**
   * Which way the shared counter reaches the event log.
   *  - "sleep": it shortens the wait, exactly as poll-phase.ts:35 does, so a
   *    divergent counter shows up as a differing wait resumeAt.
   *  - "continue": every wait is the full tick and the counter only decides
   *    whether to loop again, as poll-phase.ts:36 and :75 also do.
   *  - "continue-no-wait": as "continue", but the tick is a sleeping STEP rather
   *    than a workflow wait. With no wait in the loop the runtime has no
   *    resumeAt to check, so the only signal left is the global step index, and
   *    the divergence surfaces as the production error text: a step_created
   *    belonging to one function consumed by another.
   */
  gateMode:
    | "sleep"
    | "continue"
    | "continue-no-wait"
    | "constant-wait"
    | "constant-wait-no-race"
    | "constant-step"
    | "shared-wait"
    | "shared-wait-race";
  /**
   * Where the elapsed-time counter lives. "run-global" is production today:
   * agent.ts:2939-2946 holds budgetState and lastBudgetClockMs outside every
   * block, so concurrent blocks interleave their read-modify-writes into it.
   * "per-invocation" gives each block its own, which is the proposed fix.
   */
  budgetScope: "run-global" | "per-invocation";
  blocks: Array<{ id: string; doneAtTick: number; workUnits: number }>;
}

export async function probeV2SharedBudgetGate(input: ProbeSharedBudgetInput) {
  "use workflow";

  // The run-global budget state agent.ts holds outside every block.
  let activeElapsedMs = 0;
  let lastClockMs = await probeReadClockStep();

  interface BudgetCell {
    activeElapsedMs: number;
    lastClockMs: number;
  }
  const perInvocation = new Map<string, BudgetCell>();

  // Both scopes make the SAME number of clock step calls in the same places, so
  // the only difference between them is whether siblings share the accumulator.
  const observeBudget = async (nodeId: string): Promise<number> => {
    const now = await probeReadClockStep();
    if (input.budgetScope === "run-global") {
      activeElapsedMs += Math.max(0, now - lastClockMs);
      lastClockMs = Math.max(lastClockMs, now);
      return Math.max(0, input.limitMs - activeElapsedMs);
    }
    const cell = perInvocation.get(nodeId) ?? {
      activeElapsedMs: 0,
      lastClockMs: now,
    };
    cell.activeElapsedMs += Math.max(0, now - cell.lastClockMs);
    cell.lastClockMs = Math.max(cell.lastClockMs, now);
    perInvocation.set(nodeId, cell);
    return Math.max(0, input.limitMs - cell.activeElapsedMs);
  };

  const burn = (units: number): number => {
    let acc = 0;
    for (let index = 0; index < units; index += 1) {
      acc = (acc * 31 + index) % 1_000_003;
    }
    return acc;
  };
  let burnSink = 0;

  const nodes: WorkflowDefinitionV2Node[] = [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      x: 0,
      y: 0,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
  ];
  const edges: WorkflowDefinitionV2["edges"] = [];
  for (const block of input.blocks) {
    nodes.push(genericNode(block.id));
    edges.push({ id: `trigger-${block.id}`, from: "trigger", to: block.id });
  }

  const ticksByNode: Record<string, number> = {};
  const { sleep: workflowSleep } = await import("workflow");
  // Stands in for the invocation cancellation promise poll-phase.ts races the
  // sleep against. It never resolves in a healthy run, exactly like the real one.
  const cancellationOf = (_nodeId: string): Promise<void> =>
    new Promise<void>(() => {});

  // One tick wait per RUN rather than one per block. Whichever poller reaches
  // the tick first creates the single sleep; the others await the same promise,
  // so the runtime only ever has one wait in flight and only ever installs one
  // wait consumer. The slot is cleared when the wait resolves so the next tick
  // creates the next one.
  let sharedTickWait: Promise<void> | null = null;
  let sharedTickCreations = 0;
  const awaitSharedTick = async (ms: number): Promise<void> => {
    if (!sharedTickWait) {
      sharedTickCreations += 1;
      const pending = workflowSleep(`${ms}ms`).then(() => {
        if (sharedTickWait === pending) sharedTickWait = null;
      });
      sharedTickWait = pending;
    }
    await sharedTickWait;
  };

  const executeBlock: V2BlockExecutor = async (node) => {
    const block = input.blocks.find((entry) => entry.id === node.id)!;
    burnSink += burn(block.workUnits);
    await probeStartPhaseStep({ nodeId: node.id });

    // The controls that remove the shared counter entirely: a fixed number of
    // fixed-length waits, so nothing in the loop reads any mutable state. If
    // these diverge, concurrent waits alone are the cause and no amount of
    // budget-state scoping can fix it. "constant-wait" keeps
    // poll-phase.ts:50-53's Promise.race against the cancellation promise;
    // "constant-wait-no-race" awaits the wait directly.
    if (
      input.gateMode === "constant-wait" ||
      input.gateMode === "constant-wait-no-race" ||
      input.gateMode === "constant-step" ||
      input.gateMode === "shared-wait" ||
      input.gateMode === "shared-wait-race"
    ) {
      for (let tick = 1; tick <= block.doneAtTick; tick += 1) {
        burnSink += burn(block.workUnits);
        if (input.gateMode === "constant-wait") {
          const cancelled = await Promise.race([
            workflowSleep(`${input.tickMs}ms`).then(() => false),
            cancellationOf(node.id).then(() => true),
          ]);
          if (cancelled) break;
        } else if (input.gateMode === "shared-wait") {
          await awaitSharedTick(input.tickMs);
        } else if (input.gateMode === "shared-wait-race") {
          const cancelled = await Promise.race([
            awaitSharedTick(input.tickMs).then(() => false),
            cancellationOf(node.id).then(() => true),
          ]);
          if (cancelled) break;
        } else if (input.gateMode === "constant-step") {
          // Identical shape, identical timing, but the tick is a step rather
          // than a workflow wait. This is the only variable that changes.
          await probeTickStep({ ms: input.tickMs });
        } else {
          await workflowSleep(`${input.tickMs}ms`);
        }
        await probeCheckDoneStep({
          nodeId: node.id,
          tick,
          doneAtTick: block.doneAtTick,
        });
      }
      ticksByNode[node.id] = block.doneAtTick;
      return {
        kind: "next",
        output: { status: "completed", body: node.id },
      };
    }
    let phaseElapsedMs = 0;
    let ticks = 0;
    while (phaseElapsedMs < input.phaseLimitMs) {
      const remainingDurationMs = await observeBudget(node.id);
      const sleepMs =
        input.gateMode === "sleep"
          ? Math.min(
              input.tickMs,
              input.phaseLimitMs - phaseElapsedMs,
              remainingDurationMs,
            )
          : Math.min(input.tickMs, input.phaseLimitMs - phaseElapsedMs);
      if (sleepMs <= 0 || remainingDurationMs <= 0) break;
      // Asymmetric work between the shared read-modify-write and the next step
      // call, which is what production has as prompt compilation and sanitizing.
      burnSink += burn(block.workUnits);
      if (input.gateMode === "continue-no-wait") {
        await probeTickStep({ ms: Math.ceil(sleepMs) });
      } else {
        await workflowSleep(`${Math.ceil(sleepMs)}ms`);
      }
      phaseElapsedMs += sleepMs;
      ticks += 1;
      if ((await observeBudget(node.id)) <= 0) break;
      const done = await probeCheckDoneStep({
        nodeId: node.id,
        tick: ticks,
        doneAtTick: block.doneAtTick,
      });
      if (done) break;
    }
    ticksByNode[node.id] = ticks;
    return {
      kind: "next",
      output: { status: "completed", body: `${node.id}:${ticks}` },
    };
  };

  const walk = await executeV2Graph({
    runId: input.runId,
    definition: { schemaVersion: 2, nodes, edges },
    entryTriggerId: "trigger",
    triggerOutput: { status: "fired", ticket: { identifier: "AIW-1" } },
    executeBlock,
    maxConcurrency: input.maxConcurrency,
  });

  return {
    outcome: walk.outcome,
    executionError: walk.executionError ?? null,
    ticksByNode,
    activeElapsedMs,
    sharedTickCreations,
    burnSink,
  };
}
