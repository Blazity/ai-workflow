/**
 * How a block invocation is interpreted: what an executor is handed, what it
 * may report back, and the one construction path for the failure it reports.
 *
 * The execution-error class, the sentence a user reads and the operator log
 * event are engine concerns and live in the worker
 * (`engine/helpers/execution-error.ts`); the recorded failure state is plain
 * data and lives in `@shared/contracts`. The run budget an invocation is
 * charged against is a worker concern too: it is carried beside this context
 * as `RunBudgetHooks` (`engine/helpers/run-budget.ts`), because enforcing a
 * Harness Profile limit is runtime work this package may not do. What stays
 * here is what an executor and the scheduler both need.
 */
import type {
  AgentProtocolDiagnostic,
  BlockOutput,
  ExecutionErrorCategory,
  ExecutionErrorShape,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import {
  deriveFailureMessage,
  type FailureEvidence,
} from "./failure-message";

/** Accumulated block outputs keyed by node id, readable by later condition evaluation. */
export type StepsRecord = Record<string, { output: BlockOutput }>;

/**
 * The contracts execution error plus the one field only the engine understands.
 * Anything scheduling does with a failure it does through the contracts shape.
 */
export interface BlockExecutionError extends ExecutionErrorShape {
  /** Redacted internal provider-protocol context. Never persist or expose it. */
  diagnostic?: AgentProtocolDiagnostic;
}

/** Exported so the AIW-254 invariant test can assert that no surface renders one
 *  of these on its own. */
export const SAFE_EXECUTION_ERROR_MESSAGES: Record<
  ExecutionErrorCategory,
  string
> = {
  sandbox: "The workspace environment could not complete this block.",
  provider: "An external service could not complete this block.",
  engine: "The workflow engine could not continue.",
  binding: "A block input could not be resolved.",
  timeout: "The block timed out.",
  parsing: "The block response could not be parsed.",
  schema: "The block returned an invalid result.",
  checks: "The checks could not be started.",
  configuration: "This deployment's configuration does not allow this run to continue.",
  unknown: "The block could not be completed.",
};

/**
 * The publication gate having no record, which is NOT the checks failing.
 *
 * UP-4847: `missing_gate` (workflows/workspace-gate.ts) fires when the stored
 * configuration applies to a changed repository and no gating selection minted
 * a gate for this workspace. The scripts may well have run and passed, because
 * only the gating selection records a gate: a node that named its groups never
 * does, and a cold scheduler resume can lose one. Leading such a failure with
 * the checks sentence sent operators hunting a check failure that never
 * happened.
 *
 * Kept under SNIPPET_MAX_LENGTH (failure-message.ts) on purpose. The thrower
 * uses this exact string as its detail, so derivation sees a snippet identical
 * to the lead and returns the lead alone; a longer sentence would be clamped
 * into a different string and appended to itself in parentheses.
 */
export const WORKSPACE_GATE_NOT_RECORDED_MESSAGE =
  "No repository scripts gate was recorded for this Run Workspace, so publication " +
  "was refused; the scripts themselves may have passed.";

/**
 * Checks-category failures that are not a check failing, each keyed by the
 * exact safe sentence its thrower composed.
 *
 * A table rather than an if, for the same reason SAFE_EXECUTION_ERROR_MESSAGES
 * is one: the next checks-category cause that deserves its own lead is a row
 * here, and every one of them stays in this file where the invariant test can
 * see it.
 */
/**
 * The publication boundary refusing because the workspace itself no longer
 * matches what passed, which is again NOT the checks failing to start.
 *
 * A run reaches this with green scripts and a dirty tree: a group configured
 * with restoreTree false leaves tracked files behind by design. The operator's
 * question is which files and who wrote them, so the lead has to name the
 * workspace rather than the checks, and the culprit rides in as evidence so it
 * survives the snippet clamp.
 */
export const WORKSPACE_NOT_VERIFIABLE_MESSAGE =
  "The Run Workspace could not be verified at the publication boundary.";

/** Opening of the missing-gate lead, for surfaces that need to recognise the
 *  class without matching the whole sentence. A run whose scripts reported
 *  failures no longer reaches it at all: the boundary refuses with the failing
 *  command instead (workflows/blocks/repository-scripts-output.ts). */
export const WORKSPACE_GATE_NOT_RECORDED_PREFIX =
  "No repository scripts gate was recorded for this Run Workspace";

const CHECKS_CATEGORY_LEADS: readonly string[] = [
  WORKSPACE_GATE_NOT_RECORDED_MESSAGE,
  WORKSPACE_NOT_VERIFIABLE_MESSAGE,
];

/** The lead a checks-category detail earns for itself, or undefined when it is
 *  an ordinary "the checks could not be started" failure. */
function checksCategoryLead(
  category: ExecutionErrorCategory,
  detail: string,
): string | undefined {
  if (category !== "checks") return undefined;
  return CHECKS_CATEGORY_LEADS.find((lead) => detail.includes(lead));
}

/**
 * The single construction path for a block execution error. Every call site in
 * the tree goes through here (v2-scheduler's `runtimeError` delegates to it), so
 * derivation cannot be bypassed by forgetting it.
 *
 * `options.message` is a leading sentence, NOT a finished message: it used to
 * short-circuit derivation entirely, which is why every agent phase failure read
 * as the generic category line while its captured cause went unread (AIW-254).
 */
export function executionError(
  detail: string,
  options: {
    category?: ExecutionErrorCategory;
    message?: string;
    phase?: string;
    diagnostic?: AgentProtocolDiagnostic;
    /** Captured output and structured provider errors to classify and surface. */
    evidence?: FailureEvidence;
  } = {},
): Extract<BlockExecutionResult, { kind: "execution_error" }> {
  const category = options.category ?? "unknown";
  const lead = options.message ?? checksCategoryLead(category, detail);
  return {
    kind: "execution_error",
    error: {
      category,
      message: deriveFailureMessage({
        category,
        detail,
        genericMessage: SAFE_EXECUTION_ERROR_MESSAGES[category],
        ...(lead ? { explicitMessage: lead } : {}),
        ...(options.evidence ? { evidence: options.evidence } : {}),
      }),
      detail,
      ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
      ...(options.phase ? { phase: options.phase } : {}),
    },
  };
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
  | { kind: "ended"; output: BlockOutput }
  /** The block succeeded and the whole walk is already satisfied: everything
   * downstream of it is skipped and the run ends successfully. Distinct from
   * "ended", which parks the run while it awaits a human. */
  | { kind: "terminal_success"; output: BlockOutput };

/**
 * Runs a single action-category block and reports how the walk should proceed.
 *
 * The context is the caller's: an engine that carries more per invocation than
 * this package knows about (a run budget, say) names its own context here, and
 * everything this package reads of it is still declared below.
 */
export type BlockExecutor<
  TContext extends BlockExecutionContext = BlockExecutionContext,
> = (
  block: WorkflowDefinitionNode,
  steps: StepsRecord,
  resolvedInputs: Record<string, unknown>,
  execution?: TContext,
) => Promise<BlockExecutionResult>;

/** Invocation metadata supplied to every block. Clarification answers are
 * present only when resuming the checkpointed block. */
export interface BlockExecutionContext {
  attempt?: number;
  /** V2 activation containing this exact invocation. */
  activationScopeId?: string;
  clarificationAnswer?: string;
  cancellation?: import("./invocation-context").V2InvocationCancellation;
  /** V2 replay-safe diagnostic capture for this exact invocation. */
  observations?: import("./invocation-context").V2InvocationObservationHooks;
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
