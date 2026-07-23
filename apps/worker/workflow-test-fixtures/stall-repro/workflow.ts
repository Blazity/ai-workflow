import { createHook } from "workflow";
import type {
  BlockOutput,
  BlockRunState,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import {
  buildRuntimeGraph,
  executeGraph,
  WorkflowExecutionError,
  type BlockExecutor,
  type ExecuteGraphHooks,
  type StepsRecord,
  type WorkflowExecutionLogEvent,
} from "../../src/workflow-definition/interpreter.js";
import { isRunControlError } from "../../src/workflows/run-control-error.js";

// Probes that mirror the production agent workflow's error paths against the
// real Workflow SDK: the interpreter runs inside a "use workflow" function and
// every persistence hook is a registered "use step", exactly like agent.ts.

// --- Steps (mirroring agent.ts's error-path step shapes) ---

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
  probeStatusWrites.push(payload);
}
recordProbeBlockStatusesStep.maxRetries = 0;
const probeStatusWrites: Array<{ runId: string }> = [];

async function logProbeExecutionErrorStep(
  event: WorkflowExecutionLogEvent,
): Promise<void> {
  "use step";
  console.error("probe_workflow_execution_error", event);
}
logProbeExecutionErrorStep.maxRetries = 0;

async function markProbeRunFailedStep(runId: string): Promise<void> {
  "use step";
  console.error("probe_run_failed", runId);
}
markProbeRunFailedStep.maxRetries = 0;

async function notifyProbeFailureStep(
  phase: string,
  reason: string,
): Promise<void> {
  "use step";
  console.error("probe_failure_notified", phase, reason.slice(0, 200));
}
notifyProbeFailureStep.maxRetries = 0;

async function prepareProbeHookStep(
  token: string,
): Promise<{ hookToken: string }> {
  "use step";
  return { hookToken: token };
}

async function publishProbeHookStep(_token: string): Promise<void> {
  "use step";
}

async function supersedeProbeHookStep(_token: string): Promise<void> {
  "use step";
}

async function repairProbeLabelStep(): Promise<void> {
  "use step";
}

async function throwProbeTimeoutStep(): Promise<never> {
  "use step";
  // Mirrors runPrePrChecksStep's AbortSignal.timeout failure: a DOMException
  // is not an Error subclass, so the SDK's error serializer degrades it.
  throw new DOMException("The operation timed out", "TimeoutError");
}
throwProbeTimeoutStep.maxRetries = 0;

// --- Graph helpers ---

function node(
  id: string,
  type: WorkflowDefinitionNode["type"],
  inputs: WorkflowDefinitionNode["inputs"] = {},
  params: WorkflowDefinitionNode["params"] = {},
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params, inputs };
}

const TRIGGER_OUTPUT: BlockOutput = {
  status: "fired",
  ticket: { identifier: "AIW-1", title: "Probe ticket" },
};

function bindingStallGraph() {
  return buildRuntimeGraph({
    nodes: [
      node("trigger", "trigger_ticket_ai"),
      node("planning", "human_question", {}, { questions: "Which greeting?" }),
      node("implementation", "implementation_agent", {
        // Mirrors prod definition v4: the resumed planning output carries only
        // {status:"answered", answer}, so this binding cannot resolve.
        plan: "steps.planning.output.plan",
        ticket: "trigger.ticket",
      }),
    ],
    edges: [
      { from: "trigger", to: "planning", fromPort: "out" },
      { from: "planning", to: "implementation", fromPort: "out" },
    ],
  });
}

interface ProbeHooksOptions {
  runId: string;
  clarificationExit: ExecuteGraphHooks["clarificationExit"];
}

function buildProbeHooks(opts: ProbeHooksOptions): ExecuteGraphHooks {
  const blockStatuses: Record<string, BlockRunState> = {};
  const writeBlockStatuses = () =>
    recordProbeBlockStatusesStep({
      runId: opts.runId,
      blockStatuses: { ...blockStatuses },
    }).catch(() => {});
  return {
    onExecutionError: logProbeExecutionErrorStep,
    async onBlockStart(nodeId, attempt) {
      await readProbeClockStep();
      blockStatuses[nodeId] = { status: "running", attempt };
      await writeBlockStatuses();
    },
    async onBlockFinish(nodeId, state) {
      blockStatuses[nodeId] = state;
      await writeBlockStatuses();
      await readProbeClockStep();
    },
    clarificationExit: opts.clarificationExit,
    async failureExit(phase, reason) {
      await markProbeRunFailedStep(opts.runId);
      await notifyProbeFailureStep(phase, reason);
    },
    async terminate() {
      await writeBlockStatuses();
    },
  };
}

async function runProbeGraph(opts: {
  runId: string;
  graph: ReturnType<typeof buildRuntimeGraph>;
  executeBlock: BlockExecutor;
  hooks: ExecuteGraphHooks;
  resume?: NonNullable<Parameters<typeof executeGraph>[0]["resume"]>;
}): Promise<"completed" | "stopped" | "ended"> {
  const walk = await executeGraph({
    runId: opts.runId,
    graph: opts.graph,
    entryTriggerId: "trigger",
    triggerOutput: TRIGGER_OUTPUT,
    executeBlock: opts.executeBlock,
    hooks: opts.hooks,
    shouldRethrowExecutionError: isRunControlError,
    maxTotalExecutions: 200,
    // The registry validator is orthogonal to these probes; prod validation
    // passed on both stalled runs, so the probes skip it to keep the trigger
    // envelope minimal.
    outputValidator: () => [],
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  if (walk.executionError) {
    // Mirrors agentWorkflow: a terminal execution error surfaces as a thrown
    // WorkflowExecutionError so the run fails with its diagnostic id.
    throw new WorkflowExecutionError(walk.executionError);
  }
  return walk.outcome;
}

// --- Probe 1: interpreter resume path (checkpointed waiting node) ---

export async function probeResumeBindingStall(runId: string) {
  "use workflow";
  const executeBlock: BlockExecutor = async () => {
    throw new Error("unreachable: bindings must throw before any block runs");
  };
  return runProbeGraph({
    runId,
    graph: bindingStallGraph(),
    executeBlock,
    hooks: buildProbeHooks({
      runId,
      clarificationExit: async () => {
        throw new Error("unreachable: the resumed run must not park again");
      },
    }),
    resume: {
      waitingNodeId: "planning",
      clarificationAnswer: "Use this exact greeting: Hi hi",
      priorSteps: {},
      controlState: { attempts: { planning: 1 }, executions: 1 },
    },
  });
}

// --- Probe 2: real hook suspension resumed mid-run (prod run 1's shape) ---

export async function probeHookResumeBindingStall(hookToken: string) {
  "use workflow";
  const executeBlock: BlockExecutor = async (block) => {
    if (block.id === "planning") {
      const questions = ["Which greeting?"];
      return {
        kind: "needs_human_input",
        output: { status: "needs_human_input", questions },
        questions,
      };
    }
    throw new Error("unreachable: bindings must throw before implementation");
  };

  const awaitClarification: ExecuteGraphHooks["clarificationExit"] = async (
    _questions,
    nodeId,
    _suggestedAnswers,
    checkpointSteps?: StepsRecord,
  ): Promise<string> => {
    if (!nodeId || !checkpointSteps) {
      throw new Error("clarification is missing its waiting block context");
    }
    const clarification = await prepareProbeHookStep(hookToken);
    const hook = createHook<
      | {
          answer: string;
          answeredById: string;
          answeredByLabel: string;
          answeredAt: string;
        }
      | { expired: true }
    >({ token: clarification.hookToken });
    try {
      const conflict = await hook.getConflict();
      if (conflict) {
        throw new Error(
          `clarification hook ${clarification.hookToken} is already owned by run ${conflict.runId}`,
        );
      }
      await publishProbeHookStep(clarification.hookToken);
      const answered = await hook;
      await readProbeClockStep();
      if ("expired" in answered) {
        throw new Error("clarification expired before it was answered");
      }
      await repairProbeLabelStep();
      return answered.answer;
    } catch (error) {
      await supersedeProbeHookStep(clarification.hookToken).catch(() => undefined);
      throw error;
    } finally {
      hook.dispose();
    }
  };

  return runProbeGraph({
    runId: hookToken,
    graph: bindingStallGraph(),
    executeBlock,
    hooks: buildProbeHooks({ runId: hookToken, clarificationExit: awaitClarification }),
  });
}

// --- Probe 3: unserializable step failure caught in-workflow (prod run 2) ---

export async function probeUnserializableStepErrorStall(runId: string) {
  "use workflow";
  const graph = buildRuntimeGraph({
    nodes: [
      node("trigger", "trigger_ticket_ai"),
      node("checks", "run_pre_pr_checks"),
      node("comment", "post_ticket_comment"),
    ],
    edges: [
      { from: "trigger", to: "checks", fromPort: "out" },
      { from: "checks", to: "comment", fromPort: "out" },
    ],
  });
  const executeBlock: BlockExecutor = async (block) => {
    if (block.id === "checks") {
      // Mirrors agent.ts's run_pre_pr_checks case: the failed step is caught,
      // a budget observation step still completes, then the error is rethrown
      // into the interpreter's executeBlock catch.
      try {
        return await throwProbeTimeoutStep();
      } catch (err) {
        if (isRunControlError(err)) throw err;
        await readProbeClockStep();
        throw err;
      }
    }
    throw new Error("unreachable: the checks block must fail first");
  };
  return runProbeGraph({
    runId,
    graph,
    executeBlock,
    hooks: buildProbeHooks({
      runId,
      clarificationExit: async () => {
        throw new Error("unreachable: this probe never parks");
      },
    }),
  });
}
