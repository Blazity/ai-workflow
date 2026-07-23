import type {
  WorkflowDefinitionNode,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import type {
  BlockExecutionContext,
  BlockExecutionResult,
  StepsRecord,
} from "../../workflow-definition/interpreter.js";
import { executionError } from "../../workflow-definition/interpreter.js";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type { AgentProtocolResult, PhaseUsage } from "../../sandbox/agents/types.js";
import type {
  IssueTrackerMoveTarget,
  TicketContent,
} from "../../adapters/issue-tracker/types.js";
import type {
  PreSandboxPromptAddition,
  SelectedRepositoryPromptContext,
} from "../../sandbox/context.js";
import type {
  WorkspaceManifest,
  WorkspaceRepositoryInput,
} from "../../sandbox/repo-workspace.js";
import type { WorkspacePublicationResult } from "../workspace-publication.js";
import type { LoadedPrompts } from "../prompts-step.js";
import type { AgentWorkflowInput } from "../agent-input.js";
import type { RunBudgetObservation } from "../run-budget.js";
import type { WorkspaceGate } from "../workspace-gate.js";

/**
 * Frozen contract between the graph engine (agent.ts, wired in stage C4) and
 * the block executors in this directory. The engine builds one EngineCtx per
 * run and passes the same object to every executor.
 *
 * Mutation contract (executors write back through the shared object):
 * - prepare_workspace sets `sandboxId` (and appends to `sandboxIds`),
 *   `workspaceManifest`, `selectedRepositories`, `repositoryContexts`,
 *   `preSandboxAdditions`, and `arthur.taskId`.
 * - fetch_pr_context refreshes `repositoryContexts`.
 * - finalize_workspace sets `publication`.
 * All other fields are read-only from the executors' perspective.
 */
export interface EngineCtx {
  /** Durable workflow run id (getWorkflowMetadata().workflowRunId). */
  runId: string;
  schemaVersion: 1 | 2;
  definitionId: number | null;
  definitionVersion: number | null;
  /**
   * Nodes of the loaded definition. prepare_workspace scans these with the
   * resolve-agent helpers to provision every agent CLI the graph can need.
   */
  definitionNodes: WorkflowDefinitionNode[];
  /** What started this run. */
  entry: AgentWorkflowInput;
  ticket: TicketContent;
  /** Ticket URL in the issue tracker (JIRA_BASE_URL/browse/<key>); empty when the
   *  run has no ticket. Backs the {{ticket_url}} prompt variable so open_pr and
   *  comment templates can link back to the ticket. */
  ticketUrl: string;
  /** Summary of what the agent changed, carried from the implementation phase.
   *  Backs {{change_summary}} for the open_pr description; empty until the
   *  implementation phase produces one. */
  changeSummary: string;
  /** Answered Q&A history for the ticket, injected into fix-phase context so a
   *  resumed run sees what a human already answered; absent when there is none. */
  clarifications?: Array<{
    questions: string[];
    answer: string;
    answeredBy?: string;
    answeredAt?: string;
  }>;
  branchName: string;
  /** Null until prepare_workspace provisions a sandbox. */
  sandboxId: string | null;
  /** Manager-authored repository identity, routing, and baseline metadata.
   * Never replace this with a manifest read after agent code has run. */
  workspaceManifest: WorkspaceManifest | null;
  /** Agent-only scratch sandboxes used by planning and workspace-free Generic
   *  blocks. They never contain checked-out repositories and therefore do not
   * satisfy modular workspace consumers. */
  agentSandboxIds: Partial<Record<AgentKind, string>>;
  /**
   * Authoritative in-memory terminal-cleanup set for every code and agent-only
   * scratch sandbox provisioned by this run. Every id is also persisted as a
   * durable owner child for external cancel/reconcile crash cleanup.
   */
  sandboxIds: Set<string>;
  /** Empty until prepare_workspace selects repositories. */
  selectedRepositories: WorkspaceRepositoryInput[];
  /** Per-repository PR context (full comment bodies, check results, conflicts). */
  repositoryContexts: SelectedRepositoryPromptContext[];
  /**
   * Pre-sandbox prompt additions grouped by target phase. Empty arrays until
   * prepare_workspace runs the pre-sandbox phase and populates them.
   */
  preSandboxAdditions: {
    research: PreSandboxPromptAddition[];
    implementation: PreSandboxPromptAddition[];
    review: PreSandboxPromptAddition[];
  };
  /** Markdown plan produced by planning_agent; empty string before it runs. */
  researchPlanMarkdown: string;
  /** Result of finalize_workspace / open_pr; null before publication. */
  publication: WorkspacePublicationResult | null;
  /**
   * Exact check configuration and clean workspace fingerprint most recently
   * approved for publication. Any shared-workspace mutation clears the gate.
   */
  prePrGate: WorkspaceGate | null;
  /** Run-level default agent kind (ticket label override applied). */
  runDefaultKind: AgentKind;
  /** Default model per agent kind (env CLAUDE_MODEL / CODEX_MODEL). */
  defaults: { claude: string; codex: string };
  prompts: LoadedPrompts;
  moveTargets: { backlog: IssueTrackerMoveTarget; aiReview: IssueTrackerMoveTarget };
  /**
   * Arthur observability wiring. prepare_workspace ensures the run's Arthur
   * task (named after the ticket) and writes back the resolved `taskId`.
   */
  arthur: { taskId: string | null };
  /** Observe and enforce the run budget before further agent work. */
  observeBudget(requireRemainingDuration?: boolean): Promise<RunBudgetObservation>;
  /** Record a phase's parsed usage under a display label for run telemetry. */
  recordUsage(
    label: string,
    usage: PhaseUsage | null,
    model: string,
    attempt?: number,
  ): void;
  /**
   * Mark a phase as launched so a timeout before usage parsing reconciles to
   * "cost unknown" instead of a misleading zero cost.
   */
  markLaunched(label: string, attempt?: number): void;
}

export type {
  BlockExecutionResult,
  StepsRecord,
} from "../../workflow-definition/interpreter.js";
export { executionError };

export function agentProtocolExecutionError(
  result: Extract<AgentProtocolResult<unknown>, { ok: false }>,
): Extract<BlockExecutionResult, { kind: "execution_error" }> {
  return executionError(result.diagnostic.detail ?? result.diagnostic.failureKind, {
    category: result.category,
    message: result.message,
    phase: result.diagnostic.phase,
    diagnostic: result.diagnostic,
  });
}

/** Executor signature every block module in this directory exports. */
export type BlockExecuteFn = (
  block: WorkflowDefinitionNode,
  steps: StepsRecord,
  ctx: EngineCtx,
  resolvedInputs?: Record<string, unknown>,
  execution?: BlockExecutionContext,
) => Promise<BlockExecutionResult>;

/**
 * Collapse a block id to the shell/file-safe token ([a-z0-9-]) the agent
 * adapters produce with sanitizePhase, so phase labels like
 * `fix-<sanitizeBlockId(id)>` map to unique artifact paths. Ids that differ
 * only in case or punctuation collide after sanitization; keep ids sluggy.
 */
export function sanitizeBlockId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Assign a short, deterministic, collision-free key to each node in one
 * immutable v2 definition. The key is deliberately independent of the node id:
 * distinct valid ids may collapse to the same provider-safe phase token.
 */
export function buildV2AgentArtifactKeys(
  nodes: readonly Pick<WorkflowDefinitionV2Node, "id">[],
): ReadonlyMap<string, string> {
  return new Map(nodes.map((node, index) => [node.id, (index + 1).toString(36)]));
}

/**
 * Keep legacy artifact paths byte-for-byte stable, while v2 uses the
 * definition-local identity supplied by the scheduler adapter. The attempt is
 * part of the v2 name so loop and clarification invocations of one node cannot
 * reuse a live phase's files.
 */
export function agentArtifactPhase(
  legacyPhase: string,
  execution?: BlockExecutionContext,
): string {
  if (execution?.agentArtifactKey === undefined) return legacyPhase;
  return `${legacyPhase}-v2-${execution.agentArtifactKey}-a${execution.attempt ?? 1}`;
}

export function markBlockPhaseLaunched(
  ctx: Pick<EngineCtx, "markLaunched">,
  label: string,
  execution?: BlockExecutionContext,
): void {
  if (execution?.attempt === undefined) {
    ctx.markLaunched(label);
  } else {
    ctx.markLaunched(label, execution.attempt);
  }
}

export function recordBlockPhaseUsage(
  ctx: Pick<EngineCtx, "recordUsage">,
  label: string,
  usage: PhaseUsage | null,
  model: string,
  execution?: BlockExecutionContext,
): void {
  if (execution?.attempt === undefined) {
    ctx.recordUsage(label, usage, model);
  } else {
    ctx.recordUsage(label, usage, model, execution.attempt);
  }
}
