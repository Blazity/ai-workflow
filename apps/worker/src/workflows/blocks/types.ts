import type { WorkflowDefinitionNode } from "@shared/contracts";
import type {
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
import type { WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import type { WorkspacePublicationResult } from "../workspace-publication.js";
import type { LoadedPrompts } from "../prompts-step.js";
import type { AgentWorkflowInput } from "../agent-input.js";

/**
 * Frozen contract between the graph engine (agent.ts, wired in stage C4) and
 * the block executors in this directory. The engine builds one EngineCtx per
 * run and passes the same object to every executor.
 *
 * Mutation contract (executors write back through the shared object):
 * - prepare_workspace sets `sandboxId`, `selectedRepositories`,
 *   `repositoryContexts`, `preSandboxAdditions`, and `arthur.taskId`.
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
  branchName: string;
  /** Null until prepare_workspace provisions a sandbox. */
  sandboxId: string | null;
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
  /** Record a phase's parsed usage under a display label for run telemetry. */
  recordUsage(label: string, usage: PhaseUsage | null, model: string): void;
  /**
   * Mark a phase as launched so a timeout before usage parsing reconciles to
   * "cost unknown" instead of a misleading zero cost.
   */
  markLaunched(label: string): void;
  /**
   * Unregister the run from the run registry exactly once before pull requests
   * are created (mirrors agent.ts's beforeCreatePullRequests +
   * runUnregisteredBeforePr dedupe). The engine owns the dedupe flag.
   */
  unregisterBeforePr(): Promise<void>;
}

export type {
  BlockExecutionResult,
  StepsRecord,
} from "../../workflow-definition/interpreter.js";

/** Executor signature every block module in this directory exports. */
export type BlockExecuteFn = (
  block: WorkflowDefinitionNode,
  steps: StepsRecord,
  ctx: EngineCtx,
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
