import type { WorkflowDefinitionNode } from "@shared/contracts";
import type {
  BlockExecutionContext,
  BlockExecutionResult,
  StepsRecord,
} from "../../workflow-definition/interpreter.js";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type { PhaseUsage } from "../../sandbox/agents/types.js";
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
  recordUsage(label: string, usage: PhaseUsage | null, model: string): void;
  /**
   * Mark a phase as launched so a timeout before usage parsing reconciles to
   * "cost unknown" instead of a misleading zero cost.
   */
  markLaunched(label: string): void;
}

export type {
  BlockExecutionResult,
  StepsRecord,
} from "../../workflow-definition/interpreter.js";
export { executionError } from "../../workflow-definition/interpreter.js";

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
