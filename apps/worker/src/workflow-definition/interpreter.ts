import {
  BLOCK_TYPE_SPECS,
  EXECUTION_DIAGNOSTIC_PREFIX,
  FAILURE_PORT,
  isTriggerBlockType,
  wirablePorts,
} from "@shared/contracts";
import type {
  BlockOutput,
  BlockRunState,
  WorkflowDefinitionV1,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import type { AgentProtocolDiagnostic } from "../sandbox/agents/types.js";
import { evaluateCondition, parseCondition } from "@shared/conditions";
import {
  resolveWorkflowInputBindings,
  type WorkflowRunBindingValues,
} from "./bindings.js";
import { validateBlockOutputForDefinition } from "./block-registry.js";
import { deriveFailureMessage } from "./failure-message.js";

/** Resolved graph shape the walker consumes: node lookup, per-port targets, and triggers. */
export interface RuntimeGraph {
  nodes: Map<string, WorkflowDefinitionNode>;
  outEdges: Map<string, Map<string, string>>;
  triggers: WorkflowDefinitionNode[];
}

/** Build a walk-ready graph, resolving each edge's port to `fromPort` or the source type's first port. */
export function buildRuntimeGraph(
  def: Pick<WorkflowDefinitionV1, "nodes" | "edges">,
): RuntimeGraph {
  const nodes = new Map<string, WorkflowDefinitionNode>();
  for (const node of def.nodes) nodes.set(node.id, node);

  const outEdges = new Map<string, Map<string, string>>();
  for (const edge of def.edges) {
    const source = nodes.get(edge.from);
    if (!source) continue;
    const port = edge.fromPort ?? BLOCK_TYPE_SPECS[source.type].ports[0];
    if (port === undefined) continue;
    let ports = outEdges.get(edge.from);
    if (!ports) {
      ports = new Map<string, string>();
      outEdges.set(edge.from, ports);
    }
    ports.set(port, edge.to);
  }

  const triggers = def.nodes.filter((node) => isTriggerBlockType(node.type));
  return { nodes, outEdges, triggers };
}

/** Accumulated block outputs keyed by node id, readable by later condition evaluation. */
export type StepsRecord = Record<string, { output: BlockOutput }>;

export type ExecutionErrorCategory =
  | "sandbox"
  | "provider"
  | "engine"
  | "binding"
  | "timeout"
  | "parsing"
  | "schema"
  | "checks"
  | "unknown";

export interface BlockExecutionError {
  category: ExecutionErrorCategory;
  /** Safe text that may be persisted or shown to a user. */
  message: string;
  /** Internal context for correlated server logs. Never persist or expose it. */
  detail?: string;
  /** Redacted internal provider-protocol context. Never persist or expose it. */
  diagnostic?: AgentProtocolDiagnostic;
  phase?: string;
}

export interface WorkflowExecutionErrorState
  extends Omit<BlockExecutionError, "detail" | "diagnostic"> {
  diagnosticId: string;
  nodeId: string;
  attempt: number;
}

const SAFE_EXECUTION_ERROR_MESSAGES: Record<ExecutionErrorCategory, string> = {
  sandbox: "The workspace environment could not complete this block.",
  provider: "An external service could not complete this block.",
  engine: "The workflow engine could not continue.",
  binding: "A block input could not be resolved.",
  timeout: "The block timed out.",
  parsing: "The block response could not be parsed.",
  schema: "The block returned an invalid result.",
  checks: "The checks could not be started.",
  unknown: "The block could not be completed.",
};

export function executionError(
  detail: string,
  options: {
    category?: ExecutionErrorCategory;
    message?: string;
    phase?: string;
    diagnostic?: AgentProtocolDiagnostic;
  } = {},
): Extract<BlockExecutionResult, { kind: "execution_error" }> {
  const category = options.category ?? "unknown";
  return {
    kind: "execution_error",
    error: {
      category,
      message:
        options.message ??
        deriveFailureMessage({
          category,
          detail,
          genericMessage: SAFE_EXECUTION_ERROR_MESSAGES[category],
        }),
      detail,
      ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
      ...(options.phase ? { phase: options.phase } : {}),
    },
  };
}

export function formatExecutionErrorForUser(
  error: Pick<WorkflowExecutionErrorState, "message" | "diagnosticId">,
): string {
  return `${error.message} Diagnostic ID: ${error.diagnosticId}`;
}

export function createWorkflowExecutionErrorState(
  runId: string,
  nodeId: string,
  attempt: number,
  error: BlockExecutionError,
): WorkflowExecutionErrorState {
  return {
    category: error.category,
    message: error.message,
    ...(error.phase ? { phase: error.phase } : {}),
    diagnosticId: `${EXECUTION_DIAGNOSTIC_PREFIX}${runId}-${nodeId}-${attempt}`,
    nodeId,
    attempt,
  };
}

export class WorkflowExecutionError extends Error {
  readonly code: string;

  constructor(error: WorkflowExecutionErrorState) {
    super(formatExecutionErrorForUser(error));
    this.name = "WorkflowExecutionError";
    this.code = error.diagnosticId;
  }
}

/** Outcome an action block reports back to the engine. */
export type BlockExecutionResult =
  | { kind: "next"; output: BlockOutput; port?: string }
  | {
      kind: "needs_human_input";
      output: BlockOutput;
      questions: string[];
      suggestedAnswers?: string[];
    }
  | { kind: "execution_error"; error: BlockExecutionError; output?: never }
  | { kind: "ended"; output: BlockOutput };

/** Runs a single action-category block and reports how the walk should proceed. */
export type BlockExecutor = (
  block: WorkflowDefinitionNode,
  steps: StepsRecord,
  resolvedInputs: Record<string, unknown>,
  execution?: BlockExecutionContext,
) => Promise<BlockExecutionResult>;

/** Invocation metadata supplied to every block. Clarification answers are
 * present only when resuming the checkpointed block. */
export interface BlockExecutionContext {
  attempt?: number;
  clarificationAnswer?: string;
  cancellation?: import("./invocation-context.js").V2InvocationCancellation;
  /**
   * V2 Harness Profile budget seam. The workflow-level budget remains on
   * EngineCtx; this observer additionally enforces only the profile selected
   * for the current invocation.
   */
  observeBudget?: (
    requireRemainingDuration?: boolean,
  ) => Promise<import("../workflows/run-budget.js").RunBudgetObservation>;
  /** Record usage against the current invocation's Harness Profile limits. */
  recordBudgetUsage?: (
    usage: import("../sandbox/agents/types.js").PhaseUsage | null,
    model: string,
  ) => void;
  /**
   * V2-only compiler seam. Agent executors call it after assembling the exact
   * runtime context and workspace, immediately before launching the provider.
   */
  compileEffectivePrompt?: (input: {
    blockPrompt: string;
    runtimeData: string;
    sandboxId: string | null;
  }) => Promise<
    | { ok: true; prompt: string }
    | {
        ok: false;
        result: Extract<BlockExecutionResult, { kind: "execution_error" }>;
      }
  >;
  /**
   * Definition-local, collision-free identity for runtime artifact names.
   * V1 omits it so existing phase names remain unchanged.
   */
  agentArtifactKey?: string;
}

export interface ClarificationResume {
  waitingNodeId: string;
  clarificationAnswer: string;
  priorSteps: StepsRecord;
  controlState?: InterpreterControlState;
}

export interface InterpreterControlState {
  attempts: Record<string, number>;
  executions: number;
}

export type BlockOutputValidator = (
  block: WorkflowDefinitionNode,
  output: BlockOutput,
  requireNormalOutput: boolean,
) => string[];

/** Side-effect callbacks the engine invokes as it walks; all persistence lives here. */
export interface ExecuteGraphHooks {
  onBlockStart(nodeId: string, attempt: number): Promise<void>;
  onBlockFinish(nodeId: string, state: BlockRunState): Promise<void>;
  clarificationExit(
    questions: string[],
    nodeId: string,
    suggestedAnswers?: string[],
    steps?: StepsRecord,
    controlState?: InterpreterControlState,
  ): Promise<string | void>;
  failureExit(phase: string, reason: string, nodeId: string): Promise<void>;
  onExecutionError?(event: WorkflowExecutionLogEvent): Promise<void>;
  terminate(
    params: {
      terminalStatus: "waiting_for_human" | "failed" | "skipped" | "done";
      postComment?: string;
    },
    nodeId: string,
    steps?: StepsRecord,
    controlState?: InterpreterControlState,
  ): Promise<void>;
}

export interface WorkflowExecutionLogEvent {
  diagnosticId: string;
  nodeId: string;
  attempt: number;
  category: ExecutionErrorCategory;
  phase?: string;
  detail?: string;
  agentProtocol?: AgentProtocolDiagnostic;
}

export interface ExecuteGraphResult {
  outcome: "completed" | "stopped" | "ended";
  steps: StepsRecord;
  executionError?: WorkflowExecutionErrorState;
}

const ERROR_MAX_LENGTH = 500;
const DEFAULT_MAX_TOTAL_EXECUTIONS = 200;

function truncate(text: string): string {
  return text.length > ERROR_MAX_LENGTH ? text.slice(0, ERROR_MAX_LENGTH) : text;
}

function defaultPortOf(node: WorkflowDefinitionNode): string | undefined {
  return BLOCK_TYPE_SPECS[node.type].ports[0];
}

function defaultOutputValidator(
  block: WorkflowDefinitionNode,
  output: BlockOutput,
  requireNormalOutput: boolean,
): string[] {
  return validateBlockOutputForDefinition(block.type, block.params, output, {
    requireNormalOutput,
  });
}

function contractViolation(node: WorkflowDefinitionNode, issues: string[]): string {
  return truncate(
    `block "${node.id}" (${node.type}) returned output that violates its contract: ${issues.join("; ")}`,
  );
}

/** Walk the graph from a trigger, driving action blocks through `executeBlock` and control blocks inline. */
export async function executeGraph(opts: {
  runId?: string;
  graph: RuntimeGraph;
  entryTriggerId: string;
  triggerOutput: BlockOutput;
  runValues?: WorkflowRunBindingValues;
  executeBlock: BlockExecutor;
  hooks: ExecuteGraphHooks;
  maxTotalExecutions?: number;
  resume?: ClarificationResume;
  /** Dependency seam for focused interpreter tests. Production callers use
   * the registry-backed validator by omitting this option. */
  outputValidator?: BlockOutputValidator;
  /** Run-level control errors (for example a hard budget stop) must escape the
   * block failure graph. Ordinary executor/provider errors are normalized to
   * execution errors so an authored failure edge can run cleanup. */
  shouldRethrowExecutionError?: (error: unknown) => boolean;
}): Promise<ExecuteGraphResult> {
  const { graph, entryTriggerId, triggerOutput, executeBlock, hooks } = opts;
  const runId = opts.runId ?? "test-run";
  const maxTotalExecutions = opts.maxTotalExecutions ?? DEFAULT_MAX_TOTAL_EXECUTIONS;
  let primaryExecutionError: WorkflowExecutionErrorState | undefined;
  let failureExitCalled = false;

  const recordExecutionError = async (
    nodeId: string,
    attempt: number,
    error: BlockExecutionError,
  ): Promise<WorkflowExecutionErrorState> => {
    const state = createWorkflowExecutionErrorState(
      runId,
      nodeId,
      attempt,
      error,
    );
    await hooks.onExecutionError?.({
      diagnosticId: state.diagnosticId,
      nodeId,
      attempt,
      category: state.category,
      ...(state.phase ? { phase: state.phase } : {}),
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.diagnostic
        ? { agentProtocol: serializableProtocolDiagnostic(error.diagnostic) }
        : {}),
    });
    primaryExecutionError ??= state;
    await hooks.onBlockFinish(nodeId, {
      status: "fail",
      attempt,
      error: state.message,
      diagnosticId: state.diagnosticId,
    });
    return state;
  };
  const finish = async (
    outcome: ExecuteGraphResult["outcome"],
  ): Promise<ExecuteGraphResult> => {
    if (primaryExecutionError && !failureExitCalled) {
      failureExitCalled = true;
      await hooks.failureExit(
        primaryExecutionError.phase ?? primaryExecutionError.category,
        formatExecutionErrorForUser(primaryExecutionError),
        primaryExecutionError.nodeId,
      );
    }
    return {
      outcome,
      steps,
      ...(primaryExecutionError
        ? { executionError: primaryExecutionError }
        : {}),
    };
  };

  const steps: StepsRecord = Object.create(null) as StepsRecord;
  for (const [nodeId, state] of Object.entries(opts.resume?.priorSteps ?? {})) {
    steps[nodeId] = state;
  }

  const entry = graph.nodes.get(entryTriggerId);
  if (!entry) {
    await recordExecutionError(
      entryTriggerId,
      1,
      executionError(
        `entry trigger "${entryTriggerId}" is not present in the graph`,
        { category: "engine", phase: "engine" },
      ).error,
    );
    return finish("stopped");
  }

  const resume = opts.resume;
  if (resume && !graph.nodes.has(resume.waitingNodeId)) {
    await recordExecutionError(
      resume.waitingNodeId,
      (resume.controlState?.attempts[resume.waitingNodeId] ?? 0) + 1,
      executionError(
        `clarification waiting node "${resume.waitingNodeId}" is not present in the graph`,
        { category: "engine", phase: "engine" },
      ).error,
    );
    return finish("stopped");
  }

  const outputValidator = opts.outputValidator ?? defaultOutputValidator;
  // Stored runs and clarification checkpoints created before typed trigger
  // inputs may carry the legacy minimal envelope. Validate every field they do
  // carry, but reserve normal-output guarantees for new authored bindings.
  const triggerIssues = outputValidator(entry, triggerOutput, false);
  if (triggerIssues.length > 0) {
    await recordExecutionError(
      entryTriggerId,
      1,
      executionError(contractViolation(entry, triggerIssues), {
        category: "schema",
        phase: "contract",
      }).error,
    );
    return finish("stopped");
  }
  steps[entryTriggerId] = { output: triggerOutput };
  const attempts = new Map<string, number>(
    Object.entries(resume?.controlState?.attempts ?? {}),
  );
  let executions = resume?.controlState?.executions ?? 0;
  let resumeAnswerPending = resume !== undefined;
  const controlState = (): InterpreterControlState => ({
    attempts: Object.fromEntries(attempts),
    executions,
  });

  const entryPort = defaultPortOf(entry);
  let current = resume?.waitingNodeId ??
    (entryPort === undefined ? undefined : graph.outEdges.get(entryTriggerId)?.get(entryPort));

  while (current !== undefined) {
    const id = current;

    executions += 1;
    if (executions > maxTotalExecutions) {
      await recordExecutionError(
        id,
        (attempts.get(id) ?? 0) + 1,
        executionError(
          `workflow exceeded the maximum of ${maxTotalExecutions} block executions`,
          { category: "engine", phase: "engine" },
        ).error,
      );
      return finish("stopped");
    }

    const node = graph.nodes.get(id);
    if (!node) {
      await recordExecutionError(
        id,
        (attempts.get(id) ?? 0) + 1,
        executionError(`workflow referenced an unknown block "${id}"`, {
          category: "engine",
          phase: "engine",
        }).error,
      );
      return finish("stopped");
    }

    const resumingWaitingNode =
      resumeAnswerPending && id === resume?.waitingNodeId;

    if (
      resumingWaitingNode &&
      node.type === "loop" &&
      node.params.onExhaust === "human"
    ) {
      const maxAttempts = Number(node.params.maxAttempts);
      const attempt = attempts.get(id) ?? maxAttempts + 1;
      await hooks.onBlockStart(id, attempt);
      const output: BlockOutput = {
        status: "exhausted",
        attempt: maxAttempts,
        answer: resume.clarificationAnswer,
      };
      steps[id] = { output };
      await hooks.onBlockFinish(id, { status: "ok", attempt, output });
      resumeAnswerPending = false;
      current = graph.outEdges.get(id)?.get("exhausted");
      continue;
    }

    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    await hooks.onBlockStart(id, attempt);

    const category = BLOCK_TYPE_SPECS[node.type].category;

    if (
      resumingWaitingNode &&
      (node.type === "human_question" ||
        (node.type === "terminate" && node.params.terminalStatus === "waiting_for_human"))
    ) {
      const output: BlockOutput = node.type === "human_question"
        ? { status: "answered", answer: resume.clarificationAnswer }
        : { status: "done", answer: resume.clarificationAnswer };
      steps[id] = { output };
      await hooks.onBlockFinish(id, { status: "ok", attempt, output });
      resumeAnswerPending = false;
      const port = defaultPortOf(node);
      current = port === undefined ? undefined : graph.outEdges.get(id)?.get(port);
      continue;
    }

    if (category === "control") {
      if (node.type === "branch") {
        const conditionSrc = String(node.params.condition ?? "");
        const parsed = parseCondition(conditionSrc);
        let value: boolean;
        if (parsed.ok) {
          try {
            value = evaluateCondition(parsed.ast, steps);
            // evaluateCondition throws when the condition references a block that
            // never produced an output on this path, or when a boolean position
            // holds a non-boolean (ConditionTypeError). Neither is coerced: the
            // run fails here with the reason rather than taking an arbitrary port.
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await recordExecutionError(
              id,
              attempt,
              executionError(message, {
                category: "engine",
                phase: "branch",
              }).error,
            );
            return finish("stopped");
          }
        } else {
          const message = parsed.error;
          await recordExecutionError(
            id,
            attempt,
            executionError(message, {
              category: "engine",
              phase: "branch",
            }).error,
          );
          return finish("stopped");
        }

        const path = value ? "true" : "false";
        const output: BlockOutput = { status: "ok", path, reason: conditionSrc };
        steps[id] = { output };
        await hooks.onBlockFinish(id, { status: "ok", attempt, output });
        current = graph.outEdges.get(id)?.get(path);
        continue;
      }

      if (node.type === "loop") {
        const maxAttempts = Number(node.params.maxAttempts);
        const onExhaust = String(node.params.onExhaust ?? "");
        const exhaustedTarget = graph.outEdges.get(id)?.get("exhausted");

        if (attempt <= maxAttempts) {
          const output: BlockOutput = { status: "ok", attempt };
          steps[id] = { output };
          await hooks.onBlockFinish(id, { status: "ok", attempt, output });
          current = graph.outEdges.get(id)?.get("continue");
          continue;
        }

        const output: BlockOutput = { status: "exhausted", attempt: maxAttempts };
        steps[id] = { output };

        if (onExhaust === "continue") {
          await hooks.onBlockFinish(id, { status: "ok", attempt, output });
          current = exhaustedTarget;
          continue;
        }

        if (onExhaust === "human") {
          const label = node.name ?? id;
          const message = `Loop "${label}" exhausted after ${maxAttempts} attempts. How should we proceed?`;
          const answer = await hooks.clarificationExit(
            [message],
            id,
            undefined,
            steps,
            controlState(),
          );
          if (answer === undefined) {
            await hooks.onBlockFinish(id, { status: "warn", attempt, error: message, output });
            return finish("stopped");
          }
          const answeredOutput: BlockOutput = {
            status: "exhausted",
            attempt: maxAttempts,
            answer,
          };
          steps[id] = { output: answeredOutput };
          await hooks.onBlockFinish(id, { status: "ok", attempt, output: answeredOutput });
          current = exhaustedTarget;
          continue;
        }

        if (exhaustedTarget !== undefined) {
          await hooks.onBlockFinish(id, { status: "ok", attempt, output });
          current = exhaustedTarget;
          continue;
        }
        const message = `loop "${id}" exhausted after ${maxAttempts} attempts`;
        await hooks.onBlockFinish(id, { status: "fail", attempt, error: message, output });
        if (primaryExecutionError) return finish("stopped");
        await hooks.failureExit("loop", message, id);
        return { outcome: "stopped", steps };
      }

      if (node.type === "terminate") {
        const terminalStatus = node.params.terminalStatus as
          | "waiting_for_human"
          | "failed"
          | "skipped"
          | "done";
        const postComment =
          typeof node.params.postComment === "string" ? node.params.postComment : undefined;
        let output: BlockOutput = { status: terminalStatus };
        steps[id] = { output };
        if (terminalStatus === "waiting_for_human") {
          const answer = await hooks.clarificationExit(
            [postComment ?? "Waiting for human input."],
            id,
            undefined,
            steps,
            controlState(),
          );
          if (answer !== undefined) {
            output = { status: "done", answer };
            steps[id] = { output };
            await hooks.onBlockFinish(id, { status: "ok", attempt, output });
            return finish("completed");
          }
        }
        const finishStatus = terminalStatus === "failed" ? "fail" : terminalStatus === "waiting_for_human" ? "warn" : "ok";
        await hooks.onBlockFinish(id, { status: finishStatus, attempt, output });
        if (!primaryExecutionError) {
          await hooks.terminate({ terminalStatus, postComment }, id, steps, controlState());
        }
        return finish("stopped");
      }
    }

    let resolvedInputs: Record<string, unknown>;
    try {
      resolvedInputs = resolveWorkflowInputBindings(
        node.inputs,
        triggerOutput,
        steps,
        opts.runValues,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordExecutionError(
        id,
        attempt,
        executionError(truncate(message), {
          category: "binding",
          phase: "bindings",
        }).error,
      );
      return finish("stopped");
    }

    const execution: BlockExecutionContext = {
      attempt,
      ...(resumingWaitingNode
        ? { clarificationAnswer: resume.clarificationAnswer }
        : {}),
    };
    resumeAnswerPending = false;
    let result: BlockExecutionResult;
    try {
      result = await executeBlock(node, steps, resolvedInputs, execution);
    } catch (error) {
      if (opts.shouldRethrowExecutionError?.(error)) throw error;
      result = executionError(
        error instanceof Error ? error.stack ?? error.message : String(error),
        { phase: node.type },
      );
    }

    if (result.kind !== "execution_error") {
      const outputIssues = outputValidator(
        node,
        result.output,
        result.kind === "next" || result.kind === "ended",
      );
      if (outputIssues.length > 0) {
        const message = contractViolation(node, outputIssues);
        await recordExecutionError(
          id,
          attempt,
          executionError(message, {
            category: "schema",
            phase: "contract",
          }).error,
        );
        return finish("stopped");
      }
    }

    if (result.kind === "next") {
      const output = result.output;
      const port = result.port ?? defaultPortOf(node);
      if (
        port === undefined ||
        port === FAILURE_PORT ||
        !wirablePorts(node.type).includes(port)
      ) {
        await recordExecutionError(
          id,
          attempt,
          executionError(
            `block "${id}" returned an unknown port "${String(port)}"`,
            { category: "engine", phase: "engine" },
          ).error,
        );
        return finish("stopped");
      }
      steps[id] = { output };
      await hooks.onBlockFinish(id, { status: "ok", attempt, output });
      current = graph.outEdges.get(id)?.get(port);
      continue;
    }

    if (result.kind === "needs_human_input") {
      const output = result.output;
      steps[id] = { output };
      const error = truncate(result.questions.join("; "));
      const answer = await hooks.clarificationExit(
        result.questions,
        id,
        result.suggestedAnswers,
        steps,
        controlState(),
      );
      if (answer === undefined) {
        await hooks.onBlockFinish(id, { status: "warn", attempt, output, error });
        return finish("stopped");
      }
      const answeredOutput: BlockOutput = { status: "answered", answer };
      steps[id] = { output: answeredOutput };
      await hooks.onBlockFinish(id, { status: "ok", attempt, output: answeredOutput });
      const port = defaultPortOf(node);
      current = port === undefined ? undefined : graph.outEdges.get(id)?.get(port);
      continue;
    }

    if (result.kind === "execution_error") {
      await recordExecutionError(id, attempt, result.error);
      const failureTarget = graph.outEdges.get(id)?.get(FAILURE_PORT);
      if (failureTarget !== undefined) {
        current = failureTarget;
        continue;
      }
      return finish("stopped");
    }

    // result.kind === "ended": a block (e.g. send_plan_approval) parked the run
    // cleanly while it awaits a human. Distinct from "stopped" so agent.ts can
    // record it as a success instead of the default failed outcome.
    const output = result.output;
    steps[id] = { output };
    await hooks.onBlockFinish(id, { status: "warn", attempt, output });
    return finish("ended");
  }

  return finish("completed");
}

function serializableProtocolDiagnostic(
  diagnostic: AgentProtocolDiagnostic,
): AgentProtocolDiagnostic {
  try {
    JSON.stringify(diagnostic);
    return diagnostic;
  } catch {
    return {
      provider: diagnostic.provider,
      packageName: diagnostic.packageName,
      cliVersion: diagnostic.cliVersion,
      protocol: diagnostic.protocol,
      phase: diagnostic.phase,
      failureKind: diagnostic.failureKind,
      exitCode: diagnostic.exitCode,
    };
  }
}
