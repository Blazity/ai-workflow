import { createHook, getWorkflowMetadata } from "workflow";
import { branchForTicket } from "../lib/workflow-naming.js";
import { ticketRunUrl, ticketPageUrl, hasDashboardLinkComment } from "../lib/dashboard-links.js";
import { computeUsageTotals, type UsageTotals } from "../sandbox/usage.js";
import type {
  AgentOutput, AgentProtocolResult, CollectedPhaseArtifacts, PhaseUsage, PhaseKind,
  PhaseArtifactPaths, ResearchResult, ReviewOutput,
} from "../sandbox/agents/types.js";
import type { AgentKind } from "../sandbox/agents/index.js";
import type {
  IssueTrackerMoveTarget,
  TicketAttachment,
} from "../adapters/issue-tracker/types.js";
import type { TicketEvent } from "../adapters/messaging/types.js";
import type { ActiveRunOwner } from "../lib/active-run-owner.js";
import type { DownloadedAttachment } from "../sandbox/attachments.js";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import {
  buildRuntimeGraph,
  createWorkflowExecutionErrorState,
  executionError,
  executeGraph,
  formatExecutionErrorForUser,
  WorkflowExecutionError,
  type RuntimeGraph,
  type StepsRecord,
  type WorkflowExecutionLogEvent,
  type WorkflowExecutionErrorState,
} from "../workflow-definition/interpreter.js";
import {
  executeV2Graph,
  type V2BlockExecutor,
  type V2SchedulerCheckpoint,
  type V2SchedulerHooks,
} from "../workflow-definition/v2-scheduler.js";
import {
  buildV2ReplayGraphSnapshot,
  createV2RunObservationHooks,
  type V2RunObservationHooks,
} from "../run-observability/runtime-hooks.js";
import { configuredReplaySecrets } from "../run-observability/configured-secrets.js";
import {
  emitAgentInvocationObservations,
  emitTimedOutAgentInvocationObservations,
} from "../run-observability/agent-observations.js";
import {
  sanitizeReplayAttemptOutcome,
  sanitizeReplayGraphSnapshot,
  sanitizeReplayValue,
} from "../run-observability/sanitizer.js";
import {
  safeReplayAgentProtocolMetadata,
  safeWorkflowExecutionLogEvent,
} from "../run-observability/safe-execution-log.js";
import { replayCaptureWithinTimeout } from "../run-observability/capture-timeout.js";
import { executeTransform } from "../workflow-definition/transform.js";
import {
  isJsonValue,
  parseWorkflowDataReferenceV2,
  resolveWorkflowPromptDataTokensV2,
  type V2BindingResolutionContext,
} from "../workflow-definition/v2-bindings.js";
import type {
  BlockExecutionContext,
  BlockExecutionResult,
  BlockExecutor,
  ExecuteGraphHooks,
} from "../workflow-definition/interpreter.js";
import { resolveBlockAgent, resolveRunDefaultKind } from "../workflow-definition/resolve-agent.js";
import { resolveTicketMoveTarget } from "./ticket-move-target.js";
import {
  type AgentWorkflowInput,
} from "./agent-input.js";
import type { TicketTransitionOwner } from "../lib/ticket-transition.js";
import { moveTicketStep } from "./ticket-transition-step.js";
import {
  agentArtifactPhase,
  agentProtocolExecutionError as agentProtocolBlockError,
  blockBudgetObserver,
  buildV2AgentArtifactKeys,
  recordBlockPhaseUsage,
  type BlockExecuteFn,
  type EngineCtx,
} from "./blocks/types.js";
import {
  buildPromptVariables,
  substituteNodePromptParams,
  substitutePromptVariables,
  VARIABLE_PARAM_KEYS,
  type PromptVariableValues,
} from "./prompt-vars.js";
import {
  compatibilityPromptSourceForV2Node,
  compileEffectivePrompt,
  effectivePromptProfileSource,
} from "./effective-prompt.js";
import { loadInvocationRepositoryInstructionSources } from "./repository-instructions.js";
import type { HumanDecision } from "../lib/human-decisions-memory.js";
import type { WorkspacePublicationResult } from "./workspace-publication.js";
import {
  invalidateWorkspaceGate,
  recordSuccessfulWorkspaceGate,
} from "./workspace-gate.js";
import { resolveReviewFeedbackInput } from "./review-feedback.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import {
  ensureWorkspace,
  execute as executePrepareWorkspace,
  requiredAgentsForDefinition,
} from "./blocks/prepare-workspace.js";
import {
  ensureAgentSandbox,
  prepareHarnessAgentInvocationStep,
} from "./blocks/agent-sandbox.js";
import { execute as executeFinalizeWorkspace } from "./blocks/finalize-workspace.js";
import { execute as executeFixAgent } from "./blocks/fix-agent.js";
import { execute as executeGenericAgent } from "./blocks/generic-agent.js";
import {
  execute as executeCallLlm,
  resolveCallLlmTarget,
} from "./blocks/call-llm.js";
import { pollPhaseUntilDone } from "./blocks/poll-phase.js";
import {
  RunBudgetError,
  addActiveElapsed,
  createRunBudgetState,
  durationBudgetFailure,
  isDurationAbortError,
  missingRequiredPriceFailure,
  observeRunBudget,
  recordBudgetUsage,
  runBudgetFailureFromError,
  type RunBudgetLimits,
  type RunBudgetFailure,
  type RunBudgetObservation,
  type RunBudgetState,
} from "./run-budget.js";
import { isRunControlError } from "./run-control-error.js";
import { execute as executeFetchPrContext } from "./blocks/fetch-pr-context.js";
import { execute as executeRunChecks } from "./blocks/run-checks.js";
import { execute as executePostTicketComment } from "./blocks/post-ticket-comment.js";
import { execute as executePostPrComment } from "./blocks/post-pr-comment.js";
import { execute as executeHumanQuestion } from "./blocks/human-question.js";
import { execute as executeArthurInjectionCheck } from "./blocks/arthur-injection-check.js";
import { execute as executeSendPlanApproval } from "./blocks/send-plan-approval.js";
import {
  BLOCK_TYPE_SPECS,
  DEFAULT_OPEN_PR_BODY,
  DEFAULT_OPEN_PR_TITLE,
  isTriggerBlockType,
} from "@shared/contracts";
import type {
  BlockOutput,
  BlockRunState,
  JsonValue,
  ReplayAttemptOutcome,
  ReplayObservationKind,
  ReplaySanitizedEnvelope,
  ResolvedPromptReference,
  TransformConfiguration,
  WorkflowBlockType,
  WorkflowBlockTypeV1,
  WorkflowDefinition,
  WorkflowDefinitionNode,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
  WorkflowParamValue,
  WorkflowReplayGraphSnapshot,
  WorkflowReplaySelectedTransition,
  HarnessRunManifestRecord,
} from "@shared/contracts";
import {
  combineHarnessRuntimeLimits,
  type ResolvedHarnessRuntime,
} from "../sandbox/harness-runtime.js";

/** The agent-block prompt override: a non-empty `prompt` param replaces the
 *  built-in phase template. Empty / whitespace / non-string falls through to the
 *  built-in prompt. */
const promptOverride = (node: WorkflowDefinitionNode): string | undefined => {
  const raw = node.params.prompt;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
};

export function resolveV2PromptDataConfiguration(
  node: WorkflowDefinitionV2Node,
  context: V2BindingResolutionContext,
  options: { preserveAgentPromptSource?: boolean } = {},
): WorkflowDefinitionV2Node["configuration"] {
  const keys = VARIABLE_PARAM_KEYS[node.type];
  if (!keys) return node.configuration;
  let changed = false;
  const configuration = { ...node.configuration };
  for (const key of keys) {
    if (
      options.preserveAgentPromptSource &&
      isV2AgentPromptField(node.type, key)
    ) {
      continue;
    }
    const value = node.configuration[key];
    if (typeof value === "string") {
      const resolved = resolveWorkflowPromptDataTokensV2(value, context);
      if (resolved !== value) {
        configuration[key] = resolved;
        changed = true;
      }
      continue;
    }
    if (!Array.isArray(value)) continue;
    let arrayChanged = false;
    const resolved = value.map((item) => {
      if (typeof item !== "string") return item;
      const next = resolveWorkflowPromptDataTokensV2(item, context);
      if (next !== item) arrayChanged = true;
      return next;
    });
    if (arrayChanged) {
      configuration[key] = resolved;
      changed = true;
    }
  }
  return changed ? configuration : node.configuration;
}

export function v2NonAgentPromptPlaceholderIssue(
  type: WorkflowBlockType,
  configuration: Readonly<Record<string, unknown>>,
): string | null {
  for (const field of VARIABLE_PARAM_KEYS[type] ?? []) {
    if (isV2AgentPromptField(type, field)) continue;
    const value = configuration[field];
    const values = typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    if (values.some((item) => item.includes("{{") || item.includes("}}"))) {
      return `${type} ${field} contains an unresolved placeholder.`;
    }
  }
  return null;
}

export function substituteNodePromptParamsForSchema(
  rawNode: WorkflowDefinitionNode,
  variables: PromptVariableValues,
  schemaVersion: 1 | 2,
): WorkflowDefinitionNode {
  return schemaVersion === 2
    ? rawNode
    : substituteNodePromptParams(rawNode, variables);
}

function isV2AgentPromptField(
  type: WorkflowBlockType,
  key: string,
): boolean {
  return (
    (
      type === "planning_agent" ||
      type === "implementation_agent" ||
      type === "review_agent" ||
      type === "generic_agent"
    ) &&
    key === "prompt"
  ) || (type === "fix_agent" && key === "instructions");
}

export function v2OpenPrRepositoriesProvenanceIssue(input: {
  node: WorkflowDefinitionV2Node;
  definition: WorkflowDefinitionV2;
  steps: Readonly<Record<string, { output: BlockOutput }>>;
  resolvedInputs: Readonly<Record<string, unknown>>;
  publication: WorkspacePublicationResult | null;
}): string | null {
  if (input.node.type !== "open_pr") return null;
  const binding = input.node.inputs.repositories;
  if (binding?.kind !== "reference") {
    return "Open PR/MR repositories must come from a Finalize Workspace output.";
  }
  const parsed = parseWorkflowDataReferenceV2(binding.reference);
  const source =
    parsed?.root === "steps"
      ? input.definition.nodes.find((node) => node.id === parsed.nodeId)
      : undefined;
  if (
    parsed?.root !== "steps" ||
    parsed.path.length !== 1 ||
    parsed.path[0] !== "repositories" ||
    source?.type !== "finalize_workspace"
  ) {
    return "Open PR/MR repositories must bind exactly to a Finalize Workspace repositories output.";
  }
  const sourceRepositories =
    input.steps[parsed.nodeId]?.output.repositories;
  if (
    !Array.isArray(sourceRepositories) ||
    JSON.stringify(sourceRepositories) !==
      JSON.stringify(input.resolvedInputs.repositories)
  ) {
    return "Open PR/MR repositories do not match the bound Finalize Workspace output.";
  }
  if (
    input.publication?.status !== "finalized" ||
    JSON.stringify(input.publication.repositories) !==
      JSON.stringify(sourceRepositories)
  ) {
    return "Open PR/MR has no matching finalized publication boundary.";
  }
  return null;
}

const BLOCK_EXECUTORS: Partial<Record<WorkflowBlockType, BlockExecuteFn>> = {
  prepare_workspace: executePrepareWorkspace,
  finalize_workspace: executeFinalizeWorkspace,
  fix_agent: executeFixAgent,
  generic_agent: executeGenericAgent,
  call_llm: executeCallLlm,
  fetch_pr_context: executeFetchPrContext,
  run_checks: executeRunChecks,
  post_ticket_comment: executePostTicketComment,
  post_pr_comment: executePostPrComment,
  human_question: executeHumanQuestion,
  arthur_injection_check: executeArthurInjectionCheck,
  send_plan_approval: executeSendPlanApproval,
};

// Action blocks executed by the inline switch inside executeBlock (they need
// run-scoped closure state, so they can't live in the registry above). Kept in
// sync with the switch cases; blockTypesMissingExecutor() (asserted in tests)
// turns any drift into a loud failure instead of a silent no-op.
const INLINE_EXECUTED_BLOCK_TYPES: readonly WorkflowBlockType[] = [
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "run_pre_pr_checks",
  "open_pr",
  "send_slack_message",
  "update_ticket_status",
];

/** V1 action block types with no executor wired in either BLOCK_EXECUTORS or
 *  the inline switch. V2-only blocks are owned by the v2 scheduler. */
export function blockTypesMissingExecutor(): WorkflowBlockTypeV1[] {
  return (Object.keys(BLOCK_TYPE_SPECS) as WorkflowBlockType[])
    .filter((type): type is WorkflowBlockTypeV1 => type !== "transform")
    .filter(
      (type) =>
        BLOCK_TYPE_SPECS[type].category === "action" &&
        BLOCK_EXECUTORS[type] === undefined &&
        !INLINE_EXECUTED_BLOCK_TYPES.includes(type),
    );
}

export function buildImplementationAgentSuccessOutput(input: {
  workspaceId: string;
  workspaceManifest: WorkspaceManifest;
  commits: Array<{ provider: "github" | "gitlab"; repoPath: string; sha: string }>;
  summary?: string | null;
  verification?: BlockOutput["verification"];
}): BlockOutput {
  const changedRepositories = new Set(
    input.commits.map((commit) => `${commit.provider}:${commit.repoPath}`),
  );
  return {
    status: "implemented",
    workspaceId: input.workspaceId,
    branches: input.workspaceManifest.repositories
      .filter((repository) =>
        changedRepositories.has(`${repository.provider}:${repository.repoPath}`),
      )
      .map((repository) => ({
        provider: repository.provider,
        repoPath: repository.repoPath,
        branch: repository.branchName,
      })),
    commits: input.commits.map((commit) => ({ ...commit })),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    summary: input.summary?.trim() || "Implementation completed.",
  };
}

export function buildReviewAgentSuccessOutput(
  review: Pick<ReviewOutput, "feedback" | "issues">,
): BlockOutput {
  const feedback = review.feedback.trim();
  return {
    status: "reviewed",
    findings: review.issues.map((finding) => ({ ...finding })),
    decision: review.issues.some((finding) => finding.severity === "critical")
      ? "request_changes"
      : "approve",
    ...(feedback ? { feedback } : {}),
  };
}

type PublishedPullRequests = Extract<
  WorkspacePublicationResult,
  { status: "published" }
>["prs"];

export function buildOpenPrSuccessOutput(prs: PublishedPullRequests): BlockOutput {
  const primary = prs[0];
  if (!primary) throw new Error("published workspace has no pull requests");
  return {
    status: "ok",
    prs: prs.map((pr) => ({
      provider: pr.provider,
      repoPath: pr.repoPath,
      id: pr.id,
      url: pr.url,
      branch: pr.branch,
      isNew: pr.isNew,
    })),
    // Kept for dashboard telemetry and bindings authored against PR #118.
    prUrl: primary.url,
    prNumber: primary.id,
  };
}

export function modelsRequiringPriceLookup(
  nodes: WorkflowDefinitionNode[],
  runDefaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): Set<string> {
  const models = new Set<string>();
  for (const node of nodes) {
    if (
      node.type === "planning_agent" ||
      node.type === "implementation_agent" ||
      node.type === "review_agent" ||
      node.type === "fix_agent" ||
      node.type === "generic_agent"
    ) {
      const resolved = resolveBlockAgent(node.params, runDefaultKind, defaults);
      if (resolved.kind === "codex") models.add(resolved.model);
    } else if (node.type === "call_llm") {
      models.add(resolveCallLlmTarget(node.params, runDefaultKind, defaults).model);
    }
  }
  return models;
}

export function modelsRequiringPriceLookupForRun(
  graph: RuntimeGraph,
  entryTriggerId: string,
  runDefaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): Set<string> {
  const reachable: WorkflowDefinitionNode[] = [];
  const pending = [entryTriggerId];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const node = graph.nodes.get(id);
    if (!node) continue;
    reachable.push(node);
    for (const target of graph.outEdges.get(id)?.values() ?? []) pending.push(target);
  }

  const models = modelsRequiringPriceLookup(reachable, runDefaultKind, defaults);
  const defaultModelCanLaunch = compatibilityPathCanLaunchDefaultModel(
    graph,
    entryTriggerId,
    runDefaultKind,
    defaults,
  );
  if (runDefaultKind === "codex" && defaultModelCanLaunch) models.add(defaults.codex);
  return models;
}

function compatibilityPathCanLaunchDefaultModel(
  graph: RuntimeGraph,
  entryTriggerId: string,
  runDefaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): boolean {
  if (runDefaultKind !== "codex") return false;

  const pending = [{ id: entryTriggerId, implementationUsesDefault: true }];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stateKey = `${current.id}:${current.implementationUsesDefault}`;
    if (seen.has(stateKey)) continue;
    seen.add(stateKey);

    const node = graph.nodes.get(current.id);
    if (!node) continue;
    if (node.type === "finalize_workspace") return true;
    if (
      current.implementationUsesDefault &&
      (node.type === "run_pre_pr_checks" || node.type === "open_pr")
    ) {
      return true;
    }

    let implementationUsesDefault = current.implementationUsesDefault;
    if (node.type === "implementation_agent") {
      const resolved = resolveBlockAgent(node.params, runDefaultKind, defaults);
      implementationUsesDefault = resolved.kind === "codex" && resolved.model === defaults.codex;
    }
    for (const target of graph.outEdges.get(current.id)?.values() ?? []) {
      pending.push({ id: target, implementationUsesDefault });
    }
  }
  return false;
}

export function recordPrePrFixCycleUsages(
  ctx: Pick<EngineCtx, "markLaunched" | "recordUsage">,
  usages: ReadonlyArray<PhaseUsage | null>,
  model: string,
  budgetFailure: RunBudgetFailure | null = null,
  attempt?: number,
  blockId?: string,
): void {
  usages.forEach((usage, index) => {
    const label = blockId
      ? `Pre-PR ${blockId} Fix ${index + 1}`
      : `Pre-PR Fix ${index + 1}`;
    if (attempt === undefined) {
      ctx.markLaunched(label);
      ctx.recordUsage(label, usage, model);
    } else {
      ctx.markLaunched(label, attempt);
      ctx.recordUsage(label, usage, model, attempt);
    }
  });
  if (budgetFailure) throw new RunBudgetError(budgetFailure);
}

export function shouldReconcilePhaseUsageOnBlockFinish(
  schemaVersion: 1 | 2,
): boolean {
  return schemaVersion === 1;
}

export function blockRunStateSummary(state: BlockRunState): BlockRunState {
  const { output: _output, ...summary } = state;
  return summary;
}

export function resolveSlackMessageInput(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
): string {
  return typeof resolvedInputs.message === "string"
    ? resolvedInputs.message.trim()
    : typeof params.message === "string"
      ? params.message.trim()
      : "";
}

export function resolveTicketStatusInput(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
): string {
  const target = typeof resolvedInputs.target === "string" ? resolvedInputs.target : params.target;
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error("Update Ticket Status requires a non-empty status target.");
  }
  return target.trim();
}

/** The implementation block's own account of what it changed, read from the
 *  durable step outputs so it survives workflow replay (the implementation case
 *  may be skipped on resume, yet its output persists in `steps`). Backs
 *  {{change_summary}} for the open_pr description; empty until an
 *  implementation_agent block has produced a summary. */
export function implementationChangeSummary(
  steps: StepsRecord,
  nodes: WorkflowDefinitionNode[],
): string {
  for (const node of nodes) {
    if (node.type !== "implementation_agent") continue;
    const summary = steps[node.id]?.output?.summary;
    if (typeof summary === "string" && summary.trim() !== "") return summary;
  }
  return "";
}

/** open_pr title: a binding wins, else the authored (already {{var}}-substituted)
 *  template param, else the default template resolved against `vars`. */
export function resolveOpenPrTitle(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
  vars: PromptVariableValues,
): string {
  const bound = typeof resolvedInputs.title === "string" ? resolvedInputs.title.trim() : "";
  if (bound !== "") return bound;
  const authored = typeof params.title === "string" ? params.title.trim() : "";
  if (authored !== "") return authored;
  return substitutePromptVariables(DEFAULT_OPEN_PR_TITLE, vars).trim();
}

/** open_pr body: same precedence as the title. Whitespace is preserved for the
 *  authored/bound value so markdown structure survives; only emptiness decides
 *  the fallback. */
export function resolveOpenPrBody(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
  vars: PromptVariableValues,
): string {
  const bound = typeof resolvedInputs.body === "string" ? resolvedInputs.body : "";
  if (bound.trim() !== "") return bound;
  const authored = typeof params.body === "string" ? params.body : "";
  if (authored.trim() !== "") return authored;
  return substitutePromptVariables(DEFAULT_OPEN_PR_BODY, vars);
}

function publicationPrForTelemetry(
  publication: WorkspacePublicationResult | null | undefined,
): { url: string; number: number } | null {
  if (publication?.status !== "published") return null;
  const primary = publication.prs[0];
  return primary ? { url: primary.url, number: primary.id } : null;
}

/** Append one durable answer round without duplicating a retry of the same answer. */
export function appendClarificationRound(
  history: HumanDecision[] | undefined,
  round: HumanDecision,
): HumanDecision[] {
  if (
    history?.some(
      (existing) =>
        existing.answer === round.answer &&
        existing.questions.join("\n") === round.questions.join("\n"),
    )
  ) {
    return history;
  }
  return [...(history ?? []), round];
}

/**
 * Scratch agent sandboxes are not part of the code-workspace checkpoint.
 * Detach them before a hook suspension so resume can never reuse an expired
 * sandbox ID.
 */
export function detachScratchSandboxesForClarification(
  ctx: Pick<EngineCtx, "agentSandboxIds" | "sandboxIds">,
): string[] {
  const sandboxIds = [...new Set(Object.values(ctx.agentSandboxIds))];
  for (const sandboxId of sandboxIds) ctx.sandboxIds.delete(sandboxId);
  for (const key of Object.keys(ctx.agentSandboxIds)) {
    delete ctx.agentSandboxIds[key];
  }
  return sandboxIds;
}

/** Build the planning clarification envelope once so persisted step output and
 * the interpreter-facing fields cannot drift apart. */
export function planningClarificationResult(
  questions: string[],
  suggestedAnswers?: string[],
): Extract<BlockExecutionResult, { kind: "needs_human_input" }> {
  const suggestions =
    suggestedAnswers && suggestedAnswers.length > 0 ? suggestedAnswers : undefined;
  return {
    kind: "needs_human_input",
    output: {
      status: "needs_human_input",
      questions,
      ...(suggestions ? { suggestedAnswers: suggestions } : {}),
    },
    questions,
    ...(suggestions ? { suggestedAnswers: suggestions } : {}),
  };
}

export async function ensurePlanningAgentSandboxForBlock(
  ctx: EngineCtx,
  kind: AgentKind,
  model: string,
  isolated = false,
  runtime?: ResolvedHarnessRuntime,
): Promise<
  | { kind: "ready"; sandboxId: string }
  | Extract<BlockExecutionResult, { kind: "execution_error" }>
> {
  try {
    const options = isolated
      ? { reuse: false, ...(runtime ? { runtime } : {}) }
      : runtime
        ? { runtime }
        : null;
    const sandboxId = options
      ? await ensureAgentSandbox(ctx, kind, model, options)
      : await ensureAgentSandbox(ctx, kind, model);
    return {
      kind: "ready",
      sandboxId,
    };
  } catch (error) {
    if (isRunControlError(error)) throw error;
    const { isAgentRuntimeError } = await import("../sandbox/agents/runtime-error.js");
    if (isAgentRuntimeError(error)) {
      return agentProtocolBlockError({
        ok: false,
        category: error.category,
        message: error.safeMessage,
        diagnostic: error.diagnostic,
      });
    }
    return executionError(error instanceof Error ? error.message : String(error), {
      category: "sandbox",
      phase: "research",
    });
  }
}

/** Entry kinds that own the ticket's main work thread and may run the re-pickup
 *  clarification housekeeping (label strip, pending supersede, awaiting flip). A
 *  pr_trigger / plan_approved run is a PR/plan follow-up that does not own the
 *  ticket's clarification state, so it must be excluded: superseding a live
 *  pending question or flipping the parked asking run to success would silently
 *  strand the human's question with nothing left to re-pick the ticket up. */
export function entryOwnsClarificationThread(
  entry: AgentWorkflowInput | AgentWorkflowInput["kind"],
): boolean {
  if (
    typeof entry !== "string" &&
    "continuation" in entry &&
    entry.continuation?.kind === "clarification"
  ) {
    return false;
  }
  const kind = typeof entry === "string" ? entry : entry.kind;
  return kind === "ticket";
}

function triggerTypeFor(entry: AgentWorkflowInput): WorkflowBlockType {
  if (entry.kind === "pr_trigger") return entry.triggerType;
  if (entry.kind === "plan_approved") return "trigger_plan_approved";
  return "trigger_ticket_ai";
}

export function triggerOutputFor(entry: AgentWorkflowInput): BlockOutput {
  return triggerOutputWithTicketContext(entry);
}

interface WorkflowTicketInputContext {
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  labels: string[];
  comments: Array<{ author: string; body: string; createdAt?: string }>;
  priorAnswers?: Array<{
    questions: string[];
    answer: string;
    answeredBy?: string;
    answeredAt?: string;
  }>;
  clarifications?: Array<{
    questions: string[];
    answer: string;
    answeredBy?: string;
    answeredAt?: string;
  }>;
}

function ticketBindingFields(
  entry: AgentWorkflowInput,
  ticket: WorkflowTicketInputContext | undefined,
): Record<string, JsonValue> {
  if (
    !ticket ||
    (entry.kind === "pr_trigger" &&
      (entry.scope !== "workflow_owned" || entry.ticketKey === undefined))
  ) {
    return {};
  }
  const comments = ticket.comments.map((comment) => ({
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt ?? "",
  }));
  const priorAnswers = (ticket.clarifications ?? []).map((answer) => ({
    questions: answer.questions,
    answer: answer.answer,
    ...(answer.answeredBy === undefined ? {} : { answeredBy: answer.answeredBy }),
    ...(answer.answeredAt === undefined ? {} : { answeredAt: answer.answeredAt }),
  }));
  return {
    ticket: {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      labels: ticket.labels,
      comments,
      priorAnswers,
    },
    comments,
    priorAnswers,
  };
}

export function triggerOutputWithTicketContext(
  entry: AgentWorkflowInput,
  ticket?: WorkflowTicketInputContext,
): BlockOutput {
  const ticketFields = ticketBindingFields(entry, ticket);
  if (entry.kind === "pr_trigger") {
    const { pr } = entry;
    const output: BlockOutput = {
      status: "fired",
      ...(entry.scope === "workflow_owned" && entry.ticketKey
        ? { ticketKey: entry.ticketKey }
        : {}),
      provider: pr.provider,
      repoPath: pr.repoPath,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      headRef: pr.headRef,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      title: pr.title,
      author: pr.author,
      isDraft: pr.isDraft,
      ...ticketFields,
    };
    if (pr.failedChecks) {
      output.failedChecks = pr.failedChecks.map((check) => ({
        name: check.name,
        conclusion: check.conclusion,
        ...(check.detailsUrl !== undefined ? { detailsUrl: check.detailsUrl } : {}),
      }));
    }
    if (pr.review) {
      output.review = {
        state: pr.review.state,
        author: pr.review.author,
        body: pr.review.body,
      };
    }
    if (pr.mergeSha) output.mergeSha = pr.mergeSha;
    if (pr.mergedAt) output.mergedAt = pr.mergedAt;
    return output;
  }
  if (entry.kind === "plan_approved") {
    return {
      status: "fired",
      ticketKey: entry.ticketKey,
      approvedPlan: entry.approvedPlan.markdown,
      approver: entry.approval.approver,
      approvedAt: entry.approval.approvedAt,
      ...ticketFields,
    };
  }
  return { status: "fired", ticketKey: entry.ticketKey, ...ticketFields };
}

export function resolveImplementationPlanInput(
  resolvedInputs: Record<string, unknown>,
  legacyPlan: string,
): string {
  if (!Object.prototype.hasOwnProperty.call(resolvedInputs, "plan")) return legacyPlan;
  if (typeof resolvedInputs.plan !== "string") {
    throw new Error('Implementation input "plan" must be a string.');
  }
  return resolvedInputs.plan;
}

function resolveAgentTicketInput(
  resolvedInputs: Record<string, unknown>,
  fallback: WorkflowTicketInputContext,
  liveClarifications?: HumanDecision[],
): WorkflowTicketInputContext {
  const base = resolveAgentTicketInputFromBindings(resolvedInputs, fallback);
  if (!liveClarifications || liveClarifications.length === 0) return base;
  // Same-run clarification rounds (answered via the in-run hook) postdate both
  // the journaled trigger output and the run-start ticket snapshot, so a
  // re-executed agent phase would otherwise never see the answer it just asked
  // for. Merge them in; appendClarificationRound dedupes rounds the snapshot
  // already carries. Mirrors fix-agent's live read of ctx.clarifications.
  let clarifications = base.clarifications;
  for (const round of liveClarifications) {
    clarifications = appendClarificationRound(clarifications, round);
  }
  if (clarifications === base.clarifications) return base;
  return { ...base, clarifications };
}

function resolveAgentTicketInputFromBindings(
  resolvedInputs: Record<string, unknown>,
  fallback: WorkflowTicketInputContext,
): WorkflowTicketInputContext {
  if (!Object.prototype.hasOwnProperty.call(resolvedInputs, "ticket")) return fallback;
  if (
    resolvedInputs.ticket === null ||
    typeof resolvedInputs.ticket !== "object" ||
    Array.isArray(resolvedInputs.ticket)
  ) {
    throw new Error('Agent input "ticket" must be a ticket context object.');
  }
  const ticket = resolvedInputs.ticket as WorkflowTicketInputContext;
  const comments = Object.prototype.hasOwnProperty.call(resolvedInputs, "comments")
    ? resolvedInputs.comments
    : ticket.comments;
  const priorAnswers = Object.prototype.hasOwnProperty.call(resolvedInputs, "priorAnswers")
    ? resolvedInputs.priorAnswers
    : ticket.priorAnswers ?? ticket.clarifications ?? [];
  if (!Array.isArray(comments)) {
    throw new Error('Planning input "comments" must be an array.');
  }
  if (!Array.isArray(priorAnswers)) {
    throw new Error('Planning input "priorAnswers" must be an array.');
  }
  return {
    ...ticket,
    comments: comments as WorkflowTicketInputContext["comments"],
    ...(priorAnswers.length === 0
      ? {}
      : {
          clarifications:
            priorAnswers as NonNullable<WorkflowTicketInputContext["clarifications"]>,
        }),
  };
}

// --- Step Functions ---

async function fetchAttachments(
  ticketIdentifier: string,
  attachments: TicketAttachment[],
) {
  "use step";
  const { logger } = await import("../lib/logger.js");
  const log = logger.child({ ticket_identifier: ticketIdentifier, step: "fetchAttachments" });
  log.info({ count: attachments.length }, "fetchAttachments: start");

  if (attachments.length === 0) {
    log.info({}, "fetchAttachments: no attachments");
    return [];
  }

  const { env } = await import("../../env.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { fetchAttachmentsWithRetry } = await import("../sandbox/attachments.js");
  const { issueTracker } = createStepAdapters();

  // downloadAttachment is optional on IssueTrackerAdapter — not all trackers
  // support it. If absent, skip attachments cleanly.
  if (typeof issueTracker.downloadAttachment !== "function") {
    log.warn(
      { tracker: issueTracker.constructor.name },
      "issue tracker does not support attachment downloads; skipping",
    );
    return [];
  }

  const downloader = issueTracker as {
    downloadAttachment: (url: string, opts?: { timeoutMs?: number }) => Promise<Buffer>;
  };

  const result = await fetchAttachmentsWithRetry(
    downloader,
    attachments,
    {
      maxFileSizeBytes: env.ATTACHMENT_MAX_FILE_SIZE_MB * 1024 * 1024,
      maxTotalSizeBytes: env.ATTACHMENT_MAX_TOTAL_SIZE_MB * 1024 * 1024,
      maxCount: env.ATTACHMENT_MAX_COUNT,
      downloadTimeoutMs: env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    },
    log,
  );
  log.info(
    {
      succeeded: result.filter((a) => !a.failed).length,
      failed: result.filter((a) => a.failed).length,
    },
    "fetchAttachments: done",
  );
  return result;
}
fetchAttachments.maxRetries = 0;

async function writeAttachments(
  sandboxId: string,
  attachments: DownloadedAttachment[],
): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  const log = logger.child({ sandboxId, step: "writeAttachments" });

  const toWrite = attachments.filter((a) => a.content && !a.failed);
  log.info(
    { count: toWrite.length, totalReceived: attachments.length },
    "writeAttachments: start",
  );
  if (toWrite.length === 0) {
    log.info({}, "writeAttachments: nothing to write");
    return;
  }

  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Ensure target directory exists — writeFiles does not guarantee mkdir -p semantics.
  await sandbox.runCommand("mkdir", ["-p", "/tmp/attachments"]);

  await sandbox.writeFiles(
    toWrite.map((a) => ({
      path: `/tmp/attachments/${a.filename}`,
      content: Buffer.isBuffer(a.content)
        ? (a.content as Buffer)
        : Buffer.from(a.content as unknown as Uint8Array),
    })),
  );
  log.info({ count: toWrite.length }, "writeAttachments: done");
}
writeAttachments.maxRetries = 0;

async function writeAndStartPhase(
  sandboxId: string,
  agentKind: AgentKind,
  phase: PhaseKind,
  inputFilePath: string,
  inputContent: string,
  scriptPath: string,
  scriptContent: string,
  runtime?: ResolvedHarnessRuntime,
): Promise<
  | { ok: true; commandId: string }
  | { ok: false; failure: Extract<AgentProtocolResult<unknown>, { ok: false }> }
> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const { commandProtocolFailure, protocolFailure } = await import(
    "../sandbox/agents/protocol.js"
  );
  const spec = createAgentAdapter(agentKind, runtime?.cliSpec).cliSpec;
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../sandbox/credentials.js");
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    await sandbox.writeFiles([
      { path: inputFilePath, content: Buffer.from(inputContent) },
      { path: scriptPath, content: Buffer.from(scriptContent) },
    ]);
    const chmod = await sandbox.runCommand("chmod", ["+x", scriptPath]);
    if (chmod.exitCode !== 0) {
      return {
        ok: false,
        failure: await commandProtocolFailure({
          spec,
          phase,
          result: chmod,
          failureKind: "setup_failed",
          message: "The current agent phase could not be completed.",
          detail: "The agent phase wrapper could not be made executable.",
        }),
      };
    }

    const command = await sandbox.runCommand({
      cmd: "bash",
      args: [scriptPath],
      cwd: "/vercel/sandbox",
      detached: true,
    });
    if (command.exitCode !== null && command.exitCode !== 0) {
      return {
        ok: false,
        failure: await commandProtocolFailure({
          spec,
          phase,
          result: command,
          failureKind: "cli_exit",
          message: "The current agent phase could not be completed.",
          detail: "The agent phase process could not be launched.",
        }),
      };
    }
    return { ok: true, commandId: command.cmdId };
  } catch (error) {
    const { isRunControlError } = await import("./run-control-error.js");
    if (isRunControlError(error)) throw error;
    const failure = protocolFailure({
      spec,
      phase,
      artifacts: { stdout: "", stderr: "", structuredOutput: null, exitCode: null },
      failureKind: "provider_error",
      category: "provider",
      message: "The current agent phase could not be completed.",
      detail: "The agent phase process could not be launched.",
    });
    if (failure.ok) throw new Error("unreachable");
    return { ok: false, failure };
  }
}
writeAndStartPhase.maxRetries = 0;

async function fetchModelPriceStep(model: string): Promise<{ input: number; cached_input: number; output: number } | null> {
  "use step";
  const { fetchModelPrice } = await import("../sandbox/agents/pricing.js");
  try {
    return await fetchModelPrice(model);
  } catch (err) {
    const { logger } = await import("../lib/logger.js");
    logger.warn({ err: (err as Error).message, model }, "pricing_fetch_failed");
    return null;
  }
}
fetchModelPriceStep.maxRetries = 0;

async function readRunBudgetClockStep(): Promise<number> {
  "use step";
  return Date.now();
}
readRunBudgetClockStep.maxRetries = 0;

async function setCommitGuardStep(
  sandboxId: string,
  agentKind: AgentKind,
  enabled: boolean,
  runtime?: ResolvedHarnessRuntime,
): Promise<AgentProtocolResult<void>> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const agent = createAgentAdapter(agentKind, runtime?.cliSpec);
  try {
    await agent.setCommitGuard(sandbox, enabled, runtime?.paths);
    return { ok: true, value: undefined };
  } catch (error) {
    const { isAgentRuntimeError } = await import("../sandbox/agents/runtime-error.js");
    if (!isAgentRuntimeError(error)) throw error;
    return {
      ok: false,
      category: error.category,
      message: error.safeMessage,
      diagnostic: error.diagnostic,
    };
  }
}

// Step wrappers around the AgentAdapter class methods. The adapter classes
// transitively reach the pino logger (via installArthurTracer); the workflow
// bundler can't tolerate that, so all adapter method calls happen inside
// step bundles rather than the workflow body.
async function planPhaseStep(
  agentKind: AgentKind,
  phase: PhaseKind,
  model: string,
  jsonSchema?: string,
  runtime?: ResolvedHarnessRuntime,
): Promise<{ paths: PhaseArtifactPaths; script: string }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  const paths = a.artifactPaths(phase);
  const script = a.buildPhaseScript({
    phase,
    model,
    paths,
    jsonSchema,
    ...(runtime ? { runtime: runtime.paths } : {}),
  });
  return { paths, script };
}

async function parseResearchStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: PhaseKind = "research",
  runtime?: ResolvedHarnessRuntime,
): Promise<{ result: AgentProtocolResult<ResearchResult>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  return {
    result: a.parseResearchProtocol(artifacts, phase),
    usage: a.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

async function parseAgentOutputStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: PhaseKind = "impl",
  runtime?: ResolvedHarnessRuntime,
): Promise<{ result: AgentProtocolResult<AgentOutput>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  return {
    result: a.parseAgentOutputProtocol(artifacts, phase),
    usage: a.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

async function parseReviewStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: PhaseKind = "review",
  runtime?: ResolvedHarnessRuntime,
): Promise<{ result: AgentProtocolResult<ReviewOutput>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  return {
    result: a.parseReviewOutputProtocol(artifacts, phase),
    usage: a.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

export async function postPrLinksComment(
  ticketId: string,
  prs: Array<{ provider: SelectedRepository["provider"]; repoPath: string; url: string; id: number }>,
  owner: ActiveRunOwner,
  heading = "Pull requests ready for review:",
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const lines = prs.map((pr) => `- ${pr.provider}:${pr.repoPath}: #${pr.id} ${pr.url}`);
  try {
    await assertActiveRunOwner(getDb(), owner);
    await issueTracker.postComment(ticketId, `${heading}\n${lines.join("\n")}`);
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { ticketId, prs, err: errorMessage(err) },
      "pr_links_comment_failed",
    );
  }
}
postPrLinksComment.maxRetries = 0;

export async function postTicketComment(
  ticketId: string,
  comment: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  await assertActiveRunOwner(getDb(), owner);
  await issueTracker.postComment(ticketId, comment);
}

export async function notifyTicket(
  ticketKey: string,
  event: TicketEvent,
  owner: ActiveRunOwner,
) {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await assertActiveRunOwner(getDb(), owner);
  await messaging.notifyForTicket(ticketKey, event);
}

export async function notifyTicketBestEffort(
  ticketKey: string,
  event: TicketEvent,
  owner: ActiveRunOwner,
): Promise<void> {
  try {
    await notifyTicket(ticketKey, event, owner);
  } catch (error) {
    if (isRunControlError(error)) throw error;
    console.error(`Ticket notification failed for ${ticketKey}`);
  }
}

async function logPhaseFailure(
  ticketKey: string,
  phase: string,
  reason: string,
): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  logger.warn(
    { ticketKey, phase, reason: reason.slice(0, 1_000) },
    "agent_phase_failed",
  );
}
logPhaseFailure.maxRetries = 0;

/**
 * Records the run's "failed" status before its failure-handling backlog move
 * fires the self-triggered "ticket left the AI column" webhook, so that webhook
 * cannot cancel the run out of a genuine failure. See markRunFailedOnSelfMove.
 */
async function markRunFailedOnSelfMoveStep(runId: string): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markRunFailedOnSelfMove } = await import("../lib/telemetry/run-telemetry.js");
  await markRunFailedOnSelfMove(getDb(), runId);
}
markRunFailedOnSelfMoveStep.maxRetries = 0;

/**
 * Records the run's "success" status before its success-finalizing AI Review
 * move fires the self-triggered "ticket left the AI column" webhook, so that
 * webhook cannot cancel the run out of a genuine success. See
 * markRunSucceededOnSelfMove.
 */
async function markRunSucceededOnSelfMoveStep(runId: string): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markRunSucceededOnSelfMove } = await import("../lib/telemetry/run-telemetry.js");
  await markRunSucceededOnSelfMove(getDb(), runId);
}
markRunSucceededOnSelfMoveStep.maxRetries = 0;

async function logWorkflowExecutionErrorStep(
  event: WorkflowExecutionLogEvent,
): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  logger.error(event, "workflow_execution_error");
}
logWorkflowExecutionErrorStep.maxRetries = 0;

export function clarificationExitDisposition(providerParked: boolean): {
  outcome: "awaiting";
  notify: boolean;
} {
  return { outcome: "awaiting", notify: providerParked };
}

export type TerminalStatus =
  | "waiting_for_human"
  | "failed"
  | "skipped"
  | "done";

export function terminalStatusDisposition(
  terminalStatus: TerminalStatus,
): {
  runOutcome: "success" | "failed" | "awaiting";
  shouldRunFailureSideEffects: boolean;
} {
  if (terminalStatus === "waiting_for_human") {
    return {
      runOutcome: "awaiting",
      shouldRunFailureSideEffects: false,
    };
  }
  if (terminalStatus === "failed") {
    return {
      runOutcome: "failed",
      shouldRunFailureSideEffects: true,
    };
  }
  return {
    runOutcome: "success",
    shouldRunFailureSideEffects: false,
  };
}

export function v2TerminalBlockResult(input: {
  terminalStatus: TerminalStatus;
  postComment?: string;
  clarificationAnswer?: string;
}): BlockExecutionResult {
  if (input.terminalStatus === "failed") {
    return executionError(
      input.postComment?.trim() || "Terminated by workflow.",
      { category: "engine", phase: "terminate" },
    );
  }
  if (input.terminalStatus === "waiting_for_human") {
    if (input.clarificationAnswer !== undefined) {
      return { kind: "next", output: { status: "done" } };
    }
    return {
      kind: "needs_human_input",
      output: { status: "waiting_for_human" },
      questions: [
        input.postComment?.trim() || "Waiting for human input.",
      ],
    };
  }
  return {
    kind: "next",
    output: { status: input.terminalStatus },
  };
}

export async function parkForClarificationStep(
  ticketId: string,
  backlogTarget: IssueTrackerMoveTarget,
  _clarificationRequestId: string,
  owner: TicketTransitionOwner,
): Promise<boolean> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { updateTicketLabelsForRun } = await import(
    "../lib/ticket-label-mutation.js"
  );
  const db = getDb();
  const { issueTracker } = createStepAdapters();
  // The questions live durably in the clarification store and the overview reads
  // awaiting state from the DB; the caller also posts a best-effort Jira comment
  // with the questions separately (postClarificationQuestionsCommentStep). This
  // step only moves the label/column. The label is ticket-status truth only now
  // (it no longer drives any Jira scan). Best-effort, so a label failure never
  // blocks the park.
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await updateTicketLabelsForRun({
        db,
        issueTracker,
        ticketKey: ticketId,
        owner,
        requiredOwnerState: "bound",
        changes: { add: [NEEDS_CLARIFICATION_LABEL] },
      });
    } catch (err) {
      if (isRunControlError(err)) throw err;
      const { logger } = await import("../lib/logger.js");
      logger.warn(
        { ticketId, err: errorMessage(err) },
        "clarification_label_add_failed",
      );
    }
  }
  const { moveTicketForRun } = await import("../lib/ticket-transition.js");
  await moveTicketForRun({
    db,
    issueTracker,
    ticketKey: ticketId,
    target: backlogTarget,
    owner,
  });
  return true;
}

export async function reconcileClarificationsOnPickup(
  ticketKey: string,
  currentRunId: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { updateTicketLabelsForRun } = await import(
    "../lib/ticket-label-mutation.js"
  );
  const { reconcileClarificationPickupState } = await import(
    "../clarifications/store.js"
  );
  const { issueTracker } = createStepAdapters();
  const db = getDb();
  // Re-pickup housekeeping, all idempotent so default step retries are safe:
  //  - drop the awaiting-input label (best-effort; a label error must not fail
  //    the fresh run),
  //  - supersede any still-pending clarification (a no-op for a
  //    clarification_answered entry whose row was already answered),
  //  - flip parked predecessor runs off "awaiting" so they don't linger.
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await updateTicketLabelsForRun({
        db,
        issueTracker,
        ticketKey,
        owner,
        requiredOwnerState: "bound",
        changes: { remove: [NEEDS_CLARIFICATION_LABEL] },
      });
    } catch (err) {
      if (isRunControlError(err)) throw err;
      const { logger } = await import("../lib/logger.js");
      logger.warn(
        { ticketKey, err: errorMessage(err) },
        "clarification_label_remove_failed",
      );
    }
  }
  await reconcileClarificationPickupState(db, {
    ticketKey,
    currentRunId,
    owner,
  });
}

export async function postPickupCommentStep(
  ticketKey: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { env } = await import("../../env.js");
  const { issueTracker } = createStepAdapters();
  // No run param: the ticket view auto-selects the newest run. The link doubles
  // as the idempotency marker (hasDashboardLinkComment), so this must post at
  // most once per ticket. Best-effort: a post failure must not fail the run.
  const url = ticketPageUrl(env.DASHBOARD_ORIGIN, ticketKey);
  try {
    await assertActiveRunOwner(getDb(), owner);
    await issueTracker.postComment(
      ticketKey,
      `AI workflow picked this ticket up. Follow progress and answer questions in the dashboard: ${url}`,
    );
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { ticketKey, err: errorMessage(err) },
      "pickup_comment_failed",
    );
  }
}
postPickupCommentStep.maxRetries = 0;

export async function postClarificationQuestionsCommentStep(
  ticketKey: string,
  input: {
    questions: string[];
    suggestedAnswers: string[] | null;
    dashboardUrl: string;
    expiresAtIso: string | null;
  },
  owner: ActiveRunOwner,
): Promise<string | null> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { env } = await import("../../env.js");
  const { formatClarificationQuestionsComment } = await import(
    "../clarifications/comment-format.js"
  );
  const { issueTracker } = createStepAdapters();
  // Best-effort: surfacing the questions in Jira must never fail the paused run.
  // Returns the comment deep-link on success, null on any failure. A run-control
  // error still rethrows so the workflow ownership CAS is honored.
  try {
    await assertActiveRunOwner(getDb(), owner);
    return await issueTracker.postComment(
      ticketKey,
      formatClarificationQuestionsComment({
        questions: input.questions,
        suggestedAnswers: input.suggestedAnswers,
        dashboardUrl: input.dashboardUrl,
        aiColumnName: env.COLUMN_AI,
        expiresAtIso: input.expiresAtIso,
      }),
    );
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { ticketKey, err: errorMessage(err) },
      "clarification_questions_comment_failed",
    );
    return null;
  }
}
postClarificationQuestionsCommentStep.maxRetries = 0;

async function loadClarificationHistoryStep(
  ticketKey: string,
): Promise<Array<{ questions: string[]; answer: string; answeredBy?: string; answeredAt?: string }>> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { listAnsweredForTicket } = await import("../clarifications/store.js");
  const rows = await listAnsweredForTicket(getDb(), ticketKey);
  return rows
    .filter((r) => r.answer !== null)
    .map((r) => ({
      questions: r.questions,
      answer: r.answer as string,
      ...(r.answeredByLabel ? { answeredBy: r.answeredByLabel } : {}),
      ...(r.answeredAt ? { answeredAt: r.answeredAt.toISOString() } : {}),
    }));
}

async function logClarificationHistoryFailure(ticketKey: string, reason: string): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  logger.warn(
    { ticketKey, reason: reason.slice(0, 1_000) },
    "clarification_history_load_failed",
  );
}
logClarificationHistoryFailure.maxRetries = 0;

async function validateReviewSafePlanStep(
  nodes: WorkflowDefinitionNode[],
  edges: Array<{ from: string; to: string; fromPort?: string }>,
): Promise<string[]> {
  "use step";
  const { validateAnyScopeReviewSafety } = await import("../workflow-definition/schema.js");
  return validateAnyScopeReviewSafety({ schemaVersion: 1, nodes, edges });
}
validateReviewSafePlanStep.maxRetries = 0;

async function resolveAgentKindOverride(labels: readonly string[]): Promise<AgentKind | null> {
  "use step";
  const { parseAgentKindOverride } = await import("../sandbox/agents/index.js");
  return parseAgentKindOverride(labels);
}

async function resolveHarnessRuntimesStep(
  definition: WorkflowDefinition,
  defaultProvider: AgentKind,
): Promise<Record<string, ResolvedHarnessRuntime>> {
  "use step";
  if (definition.schemaVersion === 1) {
    const { resolveHarnessRuntimesWithLoader } = await import(
      "../workflow-definition/harness-profile-runtime.js"
    );
    return resolveHarnessRuntimesWithLoader(
      definition,
      defaultProvider,
      async () => null,
    );
  }
  const { env } = await import("../../env.js");
  const { getDb } = await import("../db/client.js");
  const {
    dashboardOrganizationId,
    resolveHarnessRuntimesForDefinition,
  } = await import("../workflow-definition/harness-profile-runtime.js");
  const db = getDb();
  const organizationId = await dashboardOrganizationId(
    db,
    env.DASHBOARD_ORG_SLUG,
  );
  return resolveHarnessRuntimesForDefinition(db, {
    definition,
    organizationId,
    defaultProvider,
  });
}
resolveHarnessRuntimesStep.maxRetries = 0;

async function runPrePrChecksStep(
  sandboxId: string,
  agentKind: AgentKind,
  model: string,
  maxFixCycles?: number,
  timeoutMs?: number,
  budget?: {
    state: RunBudgetState;
    limits: RunBudgetLimits;
    price: { input: number; cached_input: number; output: number } | null;
  },
  runtime?: ResolvedHarnessRuntime,
  arthurTaskId?: string | null,
): Promise<{
  configurationVersion: number | null;
  outcome: "passed" | "failed" | "missing_configuration";
  passed: boolean;
  fixCycles: number;
  fixCycleUsages: Array<PhaseUsage | null>;
  budgetFailure: RunBudgetFailure | null;
  summary: string;
  agentFailure?: Extract<AgentProtocolResult<unknown>, { ok: false }>;
}> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { getCurrentPrePrCheckConfig } = await import("../pre-pr-checks/store.js");
  const { emptyPrePrCheckConfig } = await import("../pre-pr-checks/config.js");
  const { runPrePrChecksWithFixes } = await import("../pre-pr-checks/runner.js");
  const { logger } = await import("../lib/logger.js");
  const current = await getCurrentPrePrCheckConfig(getDb());
  logger.info(
    { version: current?.version ?? null },
    "pre_pr_checks_config_version",
  );
  const result = await runPrePrChecksWithFixes(
    sandboxId,
    current?.config ?? emptyPrePrCheckConfig,
    agentKind,
    model,
    maxFixCycles,
    timeoutMs,
    budget,
    runtime,
    arthurTaskId,
  );
  return {
    ...result,
    configurationVersion: current?.version ?? null,
  };
}
runPrePrChecksStep.maxRetries = 0;

async function markTicketFailed(
  ticketIdentifier: string,
  runId: string,
  error: string,
  owner: TicketTransitionOwner,
) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  if (!owner.runId) throw new Error("Failed-ticket marking requires a bound run owner.");
  await runRegistry.markFailed(ticketIdentifier, {
    runId,
    error,
    failedAt: new Date().toISOString(),
  }, {
    subjectKey: owner.subjectKey,
    ownerToken: owner.ownerToken,
    runId: owner.runId,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateError(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text;
}

const FAILURE_PHASES = new Set(["research", "impl", "review", "pre-pr-checks", "push"]);

type NotifyPhase = "research" | "impl" | "review" | "pre-pr-checks" | "push";

function phaseKey(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base} #${attempt}`;
}

export interface HarnessInvocationBudget {
  limits: RunBudgetLimits;
  observeBudget(
    requireRemainingDuration?: boolean,
  ): Promise<RunBudgetObservation>;
  recordUsage(usage: PhaseUsage | null, model: string): void;
}

/**
 * Profile limits are invocation-local. The workflow observer still runs on
 * every boundary, while the local state contains only this invocation's usage
 * and active time.
 */
export async function createHarnessInvocationBudget(input: {
  workflowLimits: RunBudgetLimits;
  runtime: ResolvedHarnessRuntime;
  observeWorkflowBudget(
    requireRemainingDuration?: boolean,
  ): Promise<RunBudgetObservation>;
  readClock(): Promise<number>;
  priceLookup?(
    model: string,
  ): { input: number; cached_input: number; output: number } | null;
}): Promise<HarnessInvocationBudget> {
  const limits = combineHarnessRuntimeLimits(
    input.workflowLimits,
    input.runtime,
  );
  let state = createRunBudgetState();
  let lastClockMs = await input.readClock();
  return {
    limits,
    async observeBudget(requireRemainingDuration = true) {
      const workflow = await input.observeWorkflowBudget(
        requireRemainingDuration,
      );
      const now = await input.readClock();
      state = addActiveElapsed(state, now - lastClockMs);
      lastClockMs = Math.max(lastClockMs, now);
      const profile = observeRunBudget(
        state,
        limits,
        requireRemainingDuration,
      );
      return mergeBudgetObservations(workflow, profile);
    },
    recordUsage(usage, model) {
      state = recordBudgetUsage(
        state,
        usage,
        input.priceLookup?.(model) ?? null,
      );
    },
  };
}

function mergeBudgetObservations(
  workflow: RunBudgetObservation,
  profile: RunBudgetObservation,
): RunBudgetObservation {
  const remainingDurationMs = Math.min(
    workflow.remainingDurationMs,
    profile.remainingDurationMs,
  );
  if (workflow.check.status !== "ok") {
    return { ...workflow, remainingDurationMs };
  }
  if (profile.check.status !== "ok") {
    return { ...profile, remainingDurationMs };
  }
  const tighter =
    profile.remainingDurationMs < workflow.remainingDurationMs
      ? profile
      : workflow;
  return {
    ...tighter,
    check: { status: "ok" },
    remainingDurationMs,
  };
}

/**
 * Persist the run's cost/usage (+ agent PR + ticket) to the durable telemetry
 * table. Called from the workflow's outer finally so cost is recorded on every
 * exit — success, clarification, or failure. maxRetries = 0 and the caller
 * swallows errors: telemetry must never retry or fail the run.
 */
export async function recordRunTelemetryStep(payload: {
  runId: string;
  subjectKey: string;
  status: "success" | "failed" | "awaiting";
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  model: string | null;
  totals: UsageTotals;
  budgetFailure: RunBudgetFailure | null;
  pr: { url: string; number: number } | null;
  executionError: { message: string; code: string } | null;
  harnessManifests?: HarnessRunManifestRecord[];
}) {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { recordRunUsage } = await import("../lib/telemetry/run-telemetry.js");
  const { getWorld } = await import("workflow/runtime");
  const collectRunDetailMod = await import(
    "../lib/overview/collect-run-detail.js"
  );
  const capturedSteps = await collectRunDetailMod.captureRunStepsBestEffort(
    getWorld() as unknown as import("../lib/overview/collect-run-detail.js").RunDetailSource,
    payload.runId,
  );
  const steps = collectRunDetailMod.sanitizeRunStepsForDiagnosticError(
    capturedSteps,
    payload.executionError,
  );
  const { totals } = payload;
  await recordRunUsage(getDb(), {
    runId: payload.runId,
    // This is the agent workflow — its canonical identity (mirrors
    // WORKFLOW_MAP.agentWorkflow in lib/overview/collect-runs.ts). Recorded here
    // so the run is attributed even when no cron snapshot ever observes it.
    workflowId: "wf_agent",
    workflowName: "Agent",
    subjectKey: payload.subjectKey,
    status: payload.status,
    ticketKey: payload.ticketKey,
    ticketTitle: payload.ticketTitle,
    ticketUrl: payload.ticketUrl,
    model: payload.model,
    costUsd: totals.costUsd,
    costKnown: totals.costKnown,
    tokensInput: totals.tokensInput,
    tokensCached: totals.tokensCached,
    tokensOutput: totals.tokensOutput,
    phases: totals.phases,
    steps,
    budgetFailure: payload.budgetFailure,
    prUrl: payload.pr?.url ?? null,
    prNumber: payload.pr?.number ?? null,
    harnessManifests: payload.harnessManifests,
  });
}
recordRunTelemetryStep.maxRetries = 0;

async function recordBlockStatusesStep(payload: {
  runId: string;
  subjectKey: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  definitionVersion: number | null;
  definitionId: number | null;
  blockStatuses: Record<string, BlockRunState>;
  promptManifest?: ResolvedPromptReference[];
  harnessManifests?: HarnessRunManifestRecord[];
}) {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { recordBlockStatuses } = await import("../lib/telemetry/run-telemetry.js");
  await recordBlockStatuses(getDb(), payload);
}
recordBlockStatusesStep.maxRetries = 0;

async function markV2ReplayCaptureUnavailable(payload: {
  runId: string;
  organizationId: string;
}): Promise<void> {
  try {
    const { getDb } = await import("../db/client.js");
    const { markRunReplayCaptureUnavailable } = await import(
      "../run-observability/store.js"
    );
    await replayCaptureWithinTimeout(
      markRunReplayCaptureUnavailable({
        db: getDb(),
        ...payload,
      }),
    );
  } catch {
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { runId: payload.runId },
      "run_replay_capture_unavailable_marker_failed",
    );
  }
}

async function markV2RunObservationUnavailableStep(payload: {
  runId: string;
  organizationId: string;
}): Promise<void> {
  "use step";
  await markV2ReplayCaptureUnavailable(payload);
}
markV2RunObservationUnavailableStep.maxRetries = 0;

async function captureV2RunObservationStartStep(payload: {
  runId: string;
  definitionId: number | null;
  definitionVersion: number | null;
  graph: WorkflowReplayGraphSnapshot;
  runtimeManifest: ReplaySanitizedEnvelope;
}): Promise<{ organizationId: string } | null> {
  "use step";
  if (
    payload.definitionId === null ||
    payload.definitionVersion === null
  ) {
    return null;
  }
  let organizationId: string | null = null;
  let captureAbandoned = false;
  try {
    const capture = await replayCaptureWithinTimeout(
      (async () => {
        const { env } = await import("../../env.js");
        const { getDb } = await import("../db/client.js");
        const { dashboardOrganizationId } = await import(
          "../workflow-definition/harness-profile-runtime.js"
        );
        const { getWorkflowDefinitionRawState } = await import(
          "../workflow-definition/store.js"
        );
        const { captureRunObservationStart } = await import(
          "../run-observability/store.js"
        );
        const db = getDb();
        organizationId = await dashboardOrganizationId(
          db,
          env.DASHBOARD_ORG_SLUG,
        );
        if (captureAbandoned) {
          throw new Error("Replay capture was abandoned");
        }
        const definition = await getWorkflowDefinitionRawState(
          db,
          payload.definitionId!,
        );
        if (captureAbandoned) {
          throw new Error("Replay capture was abandoned");
        }
        const layout = definition?.layout ?? {
          nodes: Object.fromEntries(
            payload.graph.nodes.map((node) => [
              node.id,
              { x: node.x, y: node.y },
            ]),
          ),
          edges: {},
        };
        const graph = {
          ...payload.graph,
          nodes: payload.graph.nodes.map((node) => ({
            ...node,
            ...(layout.nodes[node.id] ?? { x: node.x, y: node.y }),
          })),
        };
        return captureRunObservationStart({
          db,
          runId: payload.runId,
          organizationId: organizationId!,
          definitionId: payload.definitionId!,
          definitionVersion: payload.definitionVersion!,
          definitionSchemaVersion: 2,
          graph,
          layout,
          runtimeManifest: payload.runtimeManifest,
          secrets: configuredReplaySecrets(),
        });
      })(),
    );
    if (!organizationId) {
      throw new Error("Replay capture organization could not be resolved");
    }
    if (capture.captureStatus !== "available") {
      await markV2ReplayCaptureUnavailable({
        runId: payload.runId,
        organizationId,
      });
      return null;
    }
    return organizationId ? { organizationId } : null;
  } catch {
    captureAbandoned = true;
    if (organizationId) {
      await markV2ReplayCaptureUnavailable({
        runId: payload.runId,
        organizationId,
      });
    }
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { runId: payload.runId },
      "run_replay_capture_start_failed",
    );
    return null;
  }
}
captureV2RunObservationStartStep.maxRetries = 0;

async function startV2RunObservationAttemptStep(payload: {
  runId: string;
  organizationId: string;
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  startedAt: string;
}): Promise<number | null> {
  "use step";
  try {
    const { getDb } = await import("../db/client.js");
    const { startWorkflowBlockAttempt } = await import(
      "../run-observability/store.js"
    );
    const result = await replayCaptureWithinTimeout(
      startWorkflowBlockAttempt({
        db: getDb(),
        runId: payload.runId,
        organizationId: payload.organizationId,
        nodeId: payload.nodeId,
        attempt: payload.attempt,
        activationScopeId: payload.activationScopeId,
        startedAt: new Date(payload.startedAt),
      }),
    );
    return result.attemptId;
  } catch {
    await markV2ReplayCaptureUnavailable(payload);
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      {
        runId: payload.runId,
        nodeId: payload.nodeId,
        attempt: payload.attempt,
      },
      "run_replay_attempt_start_failed",
    );
    return null;
  }
}
startV2RunObservationAttemptStep.maxRetries = 0;

interface SanitizedReplayObservation {
  kind: ReplayObservationKind;
  envelope: ReplaySanitizedEnvelope;
}

async function updateV2RunObservationWaitingStep(payload: {
  runId: string;
  organizationId: string;
  attemptId: number;
  selectedTransition: WorkflowReplaySelectedTransition;
  observations: SanitizedReplayObservation[];
}): Promise<boolean> {
  "use step";
  try {
    const { getDb } = await import("../db/client.js");
    const { updateWorkflowBlockAttemptState } = await import(
      "../run-observability/store.js"
    );
    const updated = await replayCaptureWithinTimeout(
      updateWorkflowBlockAttemptState({
        db: getDb(),
        runId: payload.runId,
        organizationId: payload.organizationId,
        attemptId: payload.attemptId,
        selectedTransition: payload.selectedTransition,
        state: "waiting_loop",
        observations: payload.observations,
      }),
    );
    if (!updated) {
      throw new Error("Replay attempt is no longer available");
    }
    return true;
  } catch {
    await markV2ReplayCaptureUnavailable(payload);
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { runId: payload.runId, attemptId: payload.attemptId },
      "run_replay_attempt_waiting_failed",
    );
    return false;
  }
}
updateV2RunObservationWaitingStep.maxRetries = 0;

async function finishV2RunObservationAttemptStep(payload: {
  runId: string;
  organizationId: string;
  attemptId: number;
  state:
    | "waiting_for_clarification"
    | "completed"
    | "failed"
    | "cancelled"
    | "skipped";
  outcome: ReplayAttemptOutcome;
  selectedTransition: WorkflowReplaySelectedTransition | null;
  diagnosticId: string | null;
  observations: SanitizedReplayObservation[];
  completedAt: string;
}): Promise<boolean> {
  "use step";
  try {
    const { getDb } = await import("../db/client.js");
    const { finishWorkflowBlockAttempt } = await import(
      "../run-observability/store.js"
    );
    const finished = await replayCaptureWithinTimeout(
      finishWorkflowBlockAttempt({
        db: getDb(),
        runId: payload.runId,
        organizationId: payload.organizationId,
        attemptId: payload.attemptId,
        state: payload.state,
        outcome: payload.outcome,
        selectedTransition: payload.selectedTransition,
        diagnosticId: payload.diagnosticId,
        observations: payload.observations,
        completedAt: new Date(payload.completedAt),
      }),
    );
    if (!finished) {
      throw new Error("Replay attempt is no longer available");
    }
    return true;
  } catch {
    await markV2ReplayCaptureUnavailable(payload);
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { runId: payload.runId, attemptId: payload.attemptId },
      "run_replay_attempt_finish_failed",
    );
    return false;
  }
}
finishV2RunObservationAttemptStep.maxRetries = 0;

// --- Main Workflow ---

export async function agentWorkflow(input: string | AgentWorkflowInput) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const legacyInput = typeof input === "string";
  const entry: AgentWorkflowInput = legacyInput
      ? {
        kind: "ticket",
        subjectKey: `ticket:jira:${input.trim().toUpperCase()}`,
        ticketKey: input,
        ownerToken: `legacy:${workflowRunId}`,
      }
    : input;
  if (!legacyInput) {
    const {
      acknowledgeApprovalDispatchStep,
      acknowledgePendingTriggerStep,
      acknowledgePrTriggerDispatchStep,
      bindWorkflowCandidateStep,
    } = await import("./run-ownership-steps.js");
    const bound = await bindWorkflowCandidateStep(
      entry.subjectKey,
      entry.ownerToken,
      workflowRunId,
    );
    if (!bound) return;
    await acknowledgeApprovalDispatchStep(entry, workflowRunId);
    if (!(await acknowledgePrTriggerDispatchStep(entry, workflowRunId))) return;
    await acknowledgePendingTriggerStep(entry);
  }
  const result = await agentWorkflowBody(entry, workflowRunId);
  if (result && typeof result === "object") {
    throw new WorkflowExecutionError(result.error);
  }
}

async function agentWorkflowBody(
  entry: AgentWorkflowInput,
  workflowRunId: string,
): Promise<
  | "success"
  | "failed"
  | "awaiting"
  | { kind: "execution_error"; error: WorkflowExecutionErrorState }
  | undefined
> {
  const budgetStartedAtMs = await readRunBudgetClockStep();

  const { env } = await import("../../env.js");
  const { assembleResearchPlanContext, assembleImplementationContext, assembleReviewContext } =
    await import("../sandbox/context.js");
  const {
    collectPhase,
    collectPhaseReplayDiagnostics,
    teardownSandboxes,
  } =
    await import("../sandbox/poll-agent.js");
  const { openPullRequestsForPublication } = await import("./workspace-publication.js");
  const { formatUsageReport } = await import("../sandbox/usage.js");
  const { AGENT_SCHEMA, RESEARCH_SCHEMA, REVIEW_SCHEMA } = await import("../sandbox/agents/types.js");
  const backlogMoveTarget = (): IssueTrackerMoveTarget =>
    env.JIRA_BACKLOG_TRANSITION_ID
      ? { name: env.COLUMN_BACKLOG, transitionId: env.JIRA_BACKLOG_TRANSITION_ID }
      : env.COLUMN_BACKLOG;
  const aiReviewMoveTarget = (): IssueTrackerMoveTarget =>
    env.JIRA_AI_REVIEW_TRANSITION_ID
      ? { name: env.COLUMN_AI_REVIEW, transitionId: env.JIRA_AI_REVIEW_TRANSITION_ID }
      : env.COLUMN_AI_REVIEW;

  const ticketId = entry.ticketKey ?? entry.subjectKey;
  const transitionOwner: TicketTransitionOwner = {
    subjectKey: entry.subjectKey,
    ownerToken: entry.ownerToken,
    runId: workflowRunId,
  };

  const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
  const ticket = await resolveWorkflowTicketStep(entry, env.COLUMN_AI);
  if (!ticket) return;

  // Re-pickup housekeeping (strip the awaiting-input label, supersede any pending
  // clarification, flip parked predecessor runs off "awaiting"). Gated to the
  // entry kinds that own the ticket's main work thread: a plain "ticket" pickup
  // or a clarification answer whose checkpoint could not be restored. A restored
  // continuation uses only the isolated label repair above. A pr_trigger /
  // plan_approved run is a PR/plan follow-up that must NOT touch the ticket's
  // clarification state. All operations inside are idempotent, so this is a safe
  // no-op on a first pickup too.
  if (entryOwnsClarificationThread(entry)) {
    await reconcileClarificationsOnPickup(
      ticket.identifier,
      workflowRunId,
      transitionOwner,
    );
  }

  // First pickup only: post exactly one dashboard link comment so a human can
  // follow progress and answer questions. The link itself is the idempotency
  // marker (hasDashboardLinkComment), so a re-picked ticket that already has it
  // posts nothing. Ticket-triggered runs only: pr_trigger and plan_approved
  // runs are follow-ups on a ticket the bot already commented on.
  if (
    entry.kind === "ticket" &&
    !("continuation" in entry && entry.continuation) &&
    !hasDashboardLinkComment(ticket.comments, ticket.identifier)
  ) {
    await postPickupCommentStep(ticket.identifier, transitionOwner);
  }

  const { loadPrompts } = await import("./prompts-step.js");
  const prompts = await loadPrompts();

  const { loadWorkflowDefinitionFor } = await import("./definition-step.js");
  const entryTriggerType = triggerTypeFor(entry);
  // An approved plan pins the definition version that produced it, so the run
  // replays the exact graph the human reviewed rather than the current head.
  const pinnedVersion = "definitionVersion" in entry ? entry.definitionVersion : undefined;
  const plan = await loadWorkflowDefinitionFor(entryTriggerType, entry.definitionId, pinnedVersion);
  if (!plan) {
    console.warn(
      `No runnable workflow definition for trigger ${entryTriggerType}; skipping run for ${ticket.identifier}`,
    );
    return;
  }
  if (entry.kind === "pr_trigger" && entry.scope === "any") {
    const issues = await validateReviewSafePlanStep(plan.nodes, plan.edges);
    if (issues.length > 0) {
      throw new Error(`scope:any workflow is not review-safe: ${issues.join("; ")}`);
    }
  }

  const agentKindOverride = await resolveAgentKindOverride(ticket.labels);
  const runDefaultKind: AgentKind = resolveRunDefaultKind(
    agentKindOverride,
    env.AGENT_KIND,
  );
  const modelDefaults = {
    claude: env.CLAUDE_MODEL,
    codex: env.CODEX_MODEL,
  };
  const defaultModel = modelDefaults[runDefaultKind];
  const harnessRuntimes = await resolveHarnessRuntimesStep(
    plan.definition,
    runDefaultKind,
  );
  const harnessManifests: HarnessRunManifestRecord[] = Object.values(
    harnessRuntimes,
  )
    .map((runtime) => structuredClone(runtime.safeManifest))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const budgetLimits: RunBudgetLimits = {
    maxDurationMs: plan.budgets?.maxDurationMs ?? env.JOB_TIMEOUT_MS,
    ...(plan.budgets?.maxTokens !== undefined
      ? { maxTokens: plan.budgets.maxTokens }
      : {}),
    ...(plan.budgets?.maxCostUsd !== undefined
      ? { maxCostUsd: plan.budgets.maxCostUsd }
      : {}),
  };
  let budgetState: RunBudgetState = createRunBudgetState();
  let lastBudgetClockMs = budgetStartedAtMs;
  const observeBudgetAtBoundary = async (
    requireRemainingDuration: boolean,
  ): Promise<RunBudgetObservation> => {
    const now = await readRunBudgetClockStep();
    budgetState = addActiveElapsed(budgetState, now - lastBudgetClockMs);
    lastBudgetClockMs = Math.max(lastBudgetClockMs, now);
    return observeRunBudget(budgetState, budgetLimits, requireRemainingDuration);
  };
  const enforceBudgetAtBoundary = async (requireRemainingDuration: boolean): Promise<void> => {
    const observation = await observeBudgetAtBoundary(requireRemainingDuration);
    if (observation.check.status !== "ok") throw new RunBudgetError(observation.check);
  };

  const { resolvePromptReferencesForRun } = await import("./prompt-references-step.js");
  const resolvedPrompts = await resolvePromptReferencesForRun(
    plan.nodes,
    plan.schemaVersion,
  );
  plan.nodes = resolvedPrompts.nodes;
  if (plan.schemaVersion === 2) {
    const definition = plan.definition as WorkflowDefinitionV2;
    const resolvedConfigurationByNodeId = new Map(
      plan.nodes.map((node) => [node.id, node.params] as const),
    );
    plan.definition = {
      ...definition,
      nodes: definition.nodes.map((node) => {
        const resolved = resolvedConfigurationByNodeId.get(node.id);
        if (!resolved) return node;
        const configuration = structuredClone(node.configuration);
        for (const key of VARIABLE_PARAM_KEYS[node.type] ?? []) {
          const value = resolved[key];
          if (value !== undefined) {
            configuration[key] = structuredClone(value);
          }
        }
        return { ...node, configuration };
      }),
    } as WorkflowDefinitionV2;
  }

  const blockStatuses: Record<string, BlockRunState> = Object.fromEntries(
    plan.nodes
      .filter((node) => !isTriggerBlockType(node.type))
      .map((node): [string, BlockRunState] => [node.id, { status: "pending" }]),
  );
  let currentBlockId: string | null = null;
  const activeBlockIds = new Set<string>();
  const writeBlockStatuses = () =>
    recordBlockStatusesStep({
      runId: workflowRunId,
      subjectKey: entry.subjectKey,
      ticketKey: entry.ticketKey ?? null,
      ticketTitle: ticket.title,
      ticketUrl: entry.ticketKey
        ? `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`
        : entry.kind === "pr_trigger"
          ? entry.pr.prUrl
          : null,
      definitionVersion: plan.version,
      definitionId: plan.definitionId,
      blockStatuses: { ...blockStatuses },
      promptManifest: resolvedPrompts.manifest,
      harnessManifests,
    }).catch(() => {});
  await writeBlockStatuses();
  let v2RunObservation: V2RunObservationHooks | null = null;
  if (plan.schemaVersion === 2) {
    const replayCaptureStartedAt = await readRunBudgetClockStep();
    const definition = plan.definition as WorkflowDefinitionV2;
    const replayGraph = sanitizeReplayGraphSnapshot(
      buildV2ReplayGraphSnapshot(definition),
      configuredReplaySecrets(),
    );
    const capture = replayGraph
      ? await captureV2RunObservationStartStep({
          runId: workflowRunId,
          definitionId: plan.definitionId,
          definitionVersion: plan.version,
          graph: replayGraph,
          runtimeManifest: sanitizeReplayValue(
            {
              defaultAgent: {
                provider: runDefaultKind,
                model: defaultModel,
              },
              harnesses: harnessManifests,
            },
            { secrets: configuredReplaySecrets() },
          ),
        })
      : null;
    if (capture) {
      const common = {
        runId: workflowRunId,
        organizationId: capture.organizationId,
      };
      const pendingObservations = new Map<
        number,
        SanitizedReplayObservation[]
      >();
      let replayCaptureUnavailable = false;
      const takePendingObservations = (
        attemptId: number,
        terminal: boolean,
      ): SanitizedReplayObservation[] => {
        const observations = pendingObservations.get(attemptId) ?? [];
        if (terminal) pendingObservations.delete(attemptId);
        else pendingObservations.set(attemptId, []);
        return observations;
      };
      v2RunObservation = createV2RunObservationHooks({
        nodeTypes: new Map(
          definition.nodes.map((node) => [node.id, node.type] as const),
        ),
        sink: {
          async start(identity, startedAt) {
            if (replayCaptureUnavailable) return null;
            const attemptId = await startV2RunObservationAttemptStep({
              ...common,
              ...identity,
              startedAt: startedAt.toISOString(),
            });
            if (replayCaptureUnavailable) return null;
            if (attemptId !== null && !pendingObservations.has(attemptId)) {
              pendingObservations.set(attemptId, []);
            }
            return attemptId;
          },
          async observe(attemptId, observation) {
            const observations = pendingObservations.get(attemptId);
            if (!observations) return;
            observations.push({
              kind: observation.kind,
              envelope: sanitizeReplayValue(observation.value, {
                secrets: configuredReplaySecrets(),
                retain:
                  observation.kind === "log" ? "tail" : "head",
              }),
            });
          },
          async updateWaiting(attemptId, selectedTransition) {
            const captured = await updateV2RunObservationWaitingStep({
              ...common,
              attemptId,
              selectedTransition,
              observations: takePendingObservations(attemptId, false),
            });
            if (!captured) {
              throw new Error("Replay waiting-state capture failed");
            }
          },
          async finish(attemptId, finish, completedAt) {
            const outcome =
              sanitizeReplayAttemptOutcome(
                finish.outcome,
                configuredReplaySecrets(),
              ) ?? {
                kind: finish.outcome.kind,
                status: "unavailable",
              };
            const captured = await finishV2RunObservationAttemptStep({
              ...common,
              attemptId,
              ...finish,
              outcome,
              observations: takePendingObservations(attemptId, true),
              completedAt: completedAt.toISOString(),
            });
            if (!captured) {
              throw new Error("Replay attempt finalization failed");
            }
          },
          async markUnavailable() {
            replayCaptureUnavailable = true;
            pendingObservations.clear();
            await markV2RunObservationUnavailableStep(common);
          },
        },
      });
    }
    const replayCaptureFinishedAt = await readRunBudgetClockStep();
    lastBudgetClockMs += Math.max(
      0,
      replayCaptureFinishedAt - replayCaptureStartedAt,
    );
  }

  const phaseUsages: Record<string, PhaseUsage | null> = {};
  const phaseModels: Record<string, string> = {};
  // The cumulative maps feed downstream notifications and the next checkpoint.
  // Run-local maps keep per-run telemetry additive instead of charging restored
  // predecessor usage a second time.
  const runPhaseUsages: Record<string, PhaseUsage | null> = {};
  const runPhaseModels: Record<string, string> = {};
  // Phases whose agent was launched. A phase that times out or exits before
  // its usage is parsed never gets a phaseUsages entry; the finally reconciles
  // any such launched-but-missing phase to null so computeUsageTotals flags
  // costKnown=false instead of reporting a misleading costUsd=0 / costKnown=true.
  const launchedPhases = new Set<string>();
  const reconcileMissingPhaseUsages = (): void => {
    for (const phase of launchedPhases) {
      if (phase in phaseUsages) continue;
      phaseUsages[phase] = null;
      runPhaseUsages[phase] = null;
      budgetState = recordBudgetUsage(budgetState, null, null);
    }
  };
  // Captured on the success path; written as run telemetry in the finally.
  let prForTelemetry: { url: string; number: number } | null = null;
  // Authoritative terminal status for telemetry, written in the finally on
  // every exit path. Defaults to "failed". The genuine PR-opened success flips
  // it to "success"; the clarification exits record "awaiting" (the run is
  // parked, not done: the answer endpoint or the re-pickup housekeeping later
  // flips it to success). Every phase failure / timeout / thrown error keeps
  // "failed".
  let runOutcome: "success" | "failed" | "awaiting" = "failed";
  let terminalExecutionError: WorkflowExecutionErrorState | null = null;
  let terminalBudgetFailure: RunBudgetFailure | null = null;
  // Seeded with the run default model once prepare_workspace provisions the
  // sandbox, then set to the implementation block's model once it runs.
  let activeModel: string | undefined;
  let priceLookup: ((m: string) => { input: number; cached_input: number; output: number } | null) | undefined;
  // Returns the formatted usage report when any phase has produced usage,
  // otherwise undefined so the messaging formatter can omit the trailing block.
  const usageReportOrUndefined = (): string | undefined =>
    Object.keys(phaseUsages).length
      ? formatUsageReport(phaseUsages, priceLookup, activeModel, phaseModels)
      : undefined;

  try {
    if (entry.ticketKey) {
      await notifyTicket(ticket.identifier, { kind: "started" }, transitionOwner);
    }

    const graph = buildRuntimeGraph({ nodes: plan.nodes, edges: plan.edges });
    const entryTrigger = plan.nodes.find((node) => node.type === entryTriggerType);
    if (!entryTrigger || !graph.nodes.has(entryTrigger.id)) {
      throw new Error("workflow definition has no runnable trigger block");
    }
    const branchName =
      entry.kind === "pr_trigger" && !entry.ticketKey
        ? entry.pr.headRef
        : branchForTicket(ticket.identifier);
    const downloadedAttachments = await fetchAttachments(ticket.identifier, ticket.attachments);

    // Ticket-backed history is reloaded from the DB. Same-run clarification
    // answers are appended to this local context when their hook resumes.
    let clarificationHistory:
      | Array<{ questions: string[]; answer: string; answeredBy?: string; answeredAt?: string }>
      | undefined;
    if (entry.ticketKey) {
      try {
        for (const round of await loadClarificationHistoryStep(ticket.identifier)) {
          clarificationHistory = appendClarificationRound(clarificationHistory, round);
        }
      } catch (err) {
        await logClarificationHistoryFailure(ticket.identifier, errorMessage(err));
      }
    }

    const ticketData = {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
      labels: ticket.labels,
      ...(clarificationHistory && clarificationHistory.length > 0
        ? { clarifications: clarificationHistory }
        : {}),
    };
    const triggerOutput: BlockOutput = triggerOutputWithTicketContext(entry, ticketData);

    const resolveAgentForNode = (node: WorkflowDefinitionNode) => {
      const runtime =
        plan.schemaVersion === 2 ? harnessRuntimes[node.id] : undefined;
      return runtime
        ? {
            kind: runtime.manifest.harness.provider,
            model: runtime.manifest.model.id,
            runtime,
          }
        : {
            ...resolveBlockAgent(
              node.params,
              runDefaultKind,
              modelDefaults,
            ),
            runtime: undefined,
          };
    };

    // Codex agents and every in-process Call LLM need token pricing. Fetch all
    // resolved models before any block can record usage so configured cost caps
    // fail closed instead of depending on network timing during execution.
    const pricedModels =
      plan.schemaVersion === 1
        ? modelsRequiringPriceLookupForRun(
            graph,
            entryTrigger.id,
            runDefaultKind,
            modelDefaults,
          )
        : new Set([
            ...Object.values(harnessRuntimes)
              .filter(
                (runtime) =>
                  runtime.manifest.harness.provider === "codex",
              )
              .map((runtime) => runtime.manifest.model.id),
            ...plan.nodes
              .filter((node) => node.type === "call_llm")
              .map(
                (node) =>
                  resolveCallLlmTarget(
                    node.params,
                    runDefaultKind,
                    modelDefaults,
                  ).model,
              ),
          ]);
    if (
      plan.schemaVersion === 2 &&
      runDefaultKind === "codex" &&
      plan.nodes.some((node) =>
        node.type === "run_pre_pr_checks" ||
        node.type === "finalize_workspace" ||
        node.type === "open_pr"
      )
    ) {
      pricedModels.add(env.CODEX_MODEL);
    }
    for (const [phase, usage] of Object.entries(phaseUsages)) {
      const model = phaseModels[phase];
      if (usage?.tokens && model) pricedModels.add(model);
    }
    if (pricedModels.size > 0) {
      const priceMap = new Map<string, { input: number; cached_input: number; output: number }>();
      for (const model of pricedModels) {
        const price = await fetchModelPriceStep(model);
        if (price) priceMap.set(model, price);
      }
      const missingPriceFailure = missingRequiredPriceFailure(
        budgetLimits.maxCostUsd,
        pricedModels,
        priceMap,
      );
      if (missingPriceFailure) throw new RunBudgetError(missingPriceFailure);
      priceLookup = (model) => priceMap.get(model) ?? null;
    }

    const state: {
      implementationModel: string;
      implementationKind: AgentKind | undefined;
      implementationRuntime: ResolvedHarnessRuntime | undefined;
      attempt: number;
    } = {
      implementationModel: defaultModel,
      implementationKind: undefined,
      implementationRuntime: undefined,
      attempt: 1,
    };

    const ctx: EngineCtx = {
      runId: workflowRunId,
      schemaVersion: plan.schemaVersion,
      definitionId: plan.definitionId,
      definitionVersion: plan.version,
      definitionNodes: plan.nodes,
      entry,
      ticket,
      ticketUrl: entry.ticketKey
        ? `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`
        : "",
      changeSummary: "",
      ...(clarificationHistory && clarificationHistory.length > 0
        ? { clarifications: clarificationHistory }
        : {}),
      branchName,
      sandboxId: null,
      workspaceManifest: null,
      agentSandboxIds: {},
      harnessRuntimes,
      sandboxIds: new Set<string>(),
      selectedRepositories: [],
      repositoryContexts: [],
      preSandboxAdditions: {
        research: [],
        implementation: [],
        review: [],
      },
      researchPlanMarkdown:
        entry.kind === "plan_approved"
          ? entry.approvedPlan.markdown
          : "",
      publication: null,
      prePrGate: null,
      runDefaultKind,
      defaults: { claude: env.CLAUDE_MODEL, codex: env.CODEX_MODEL },
      prompts,
      moveTargets: { backlog: backlogMoveTarget(), aiReview: aiReviewMoveTarget() },
      arthur: {
        taskId: null,
      },
      observeBudget: (requireRemainingDuration = true) =>
        observeBudgetAtBoundary(requireRemainingDuration),
      recordUsage: (label, usage, model, attempt) => {
        const key = phaseKey(label, attempt ?? state.attempt);
        phaseUsages[key] = usage;
        phaseModels[key] = model;
        runPhaseUsages[key] = usage;
        runPhaseModels[key] = model;
        budgetState = recordBudgetUsage(
          budgetState,
          usage,
          priceLookup?.(model) ?? null,
        );
      },
      markLaunched: (label, attempt) => {
        launchedPhases.add(phaseKey(label, attempt ?? state.attempt));
      },
    };

    try {
      const awaitClarification = async (
        questions: string[],
        nodeId?: string,
        suggestedAnswers?: string[],
        checkpointSteps?: StepsRecord,
      ): Promise<string> => {
        if (!nodeId || !checkpointSteps) {
          throw new Error("clarification is missing its waiting block context");
        }

        const {
          markClarificationHookCleanupStep,
          prepareClarificationHookStep,
          publishClarificationHookStep,
          recordClarificationHookSnapshotStep,
          supersedeClarificationHookStep,
          verifyWorkspaceManifestStep,
        } = await import("./clarification-hook-steps.js");
        const workspaceManifest = ctx.workspaceManifest;
        if (ctx.sandboxId) {
          if (!workspaceManifest) {
            throw new Error("code workspace is missing its trusted provisioned manifest");
          }
          await verifyWorkspaceManifestStep(ctx.sandboxId, workspaceManifest);
        } else if (workspaceManifest) {
          throw new Error("trusted workspace manifest exists without a code sandbox");
        }

        const clarification = await prepareClarificationHookStep({
          ticketKey: entry.ticketKey ?? null,
          subjectKey: entry.subjectKey,
          runId: workflowRunId,
          blockId: nodeId,
          definitionId: plan.definitionId,
          definitionVersion: plan.version,
          questions,
          suggestedAnswers: suggestedAnswers ?? null,
        });
        const hook = createHook<
          | {
              answer: string;
              answeredById: string;
              answeredByLabel: string;
              answeredAt: string;
            }
          | { expired: true }
        >({ token: clarification.hookToken });
        let snapshot:
          | { snapshotId: string; sourceSandboxId: string; expiresAt: string }
          | undefined;
        try {
          const conflict = await hook.getConflict();
          if (conflict) {
            throw new Error(
              `clarification hook ${clarification.hookToken} is already owned by run ${conflict.runId}`,
            );
          }

          const scratchSandboxIds =
            detachScratchSandboxesForClarification(ctx);
          await teardownSandboxes(scratchSandboxIds);

          if (ctx.sandboxId) {
            const snapshotBudget = await observeBudgetAtBoundary(true);
            if (snapshotBudget.check.status !== "ok") {
              throw new RunBudgetError(snapshotBudget.check);
            }
            const { snapshotClarificationSandboxStep } =
              await import("./clarification-snapshot-steps.js");
            snapshot = await snapshotClarificationSandboxStep({
              subjectKey: entry.subjectKey,
              ownerToken: entry.ownerToken,
              clarificationId: clarification.id,
              sandboxId: ctx.sandboxId,
              snapshotRequestedAt: clarification.snapshotRequestedAt,
              timeoutMs: Math.max(1, Math.floor(snapshotBudget.remainingDurationMs)),
            });
            await recordClarificationHookSnapshotStep(clarification.id, snapshot);
            const afterSnapshot = await observeBudgetAtBoundary(false);
            if (afterSnapshot.check.status !== "ok") {
              throw new RunBudgetError(afterSnapshot.check);
            }
          }

          await publishClarificationHookStep(clarification.id);
          if (entry.ticketKey) {
            await parkForClarificationStep(
              ticketId,
              backlogMoveTarget(),
              clarification.id,
              transitionOwner,
            ).catch((error) => {
              if (isRunControlError(error)) throw error;
              console.error(
                `Clarification ticket parking failed for ${clarification.id}`,
              );
              return false;
            });
            const questionsCommentUrl = await postClarificationQuestionsCommentStep(
              ticket.identifier,
              {
                questions,
                suggestedAnswers: suggestedAnswers ?? null,
                dashboardUrl: ticketRunUrl(env.DASHBOARD_ORIGIN, ticket.identifier, workflowRunId),
                expiresAtIso: clarification.expiresAt,
              },
              transitionOwner,
            );
            await notifyTicketBestEffort(ticket.identifier, {
              kind: "needs_clarification",
              dashboardUrl: ticketRunUrl(env.DASHBOARD_ORIGIN, ticket.identifier, workflowRunId),
              ...(questionsCommentUrl ? { commentUrl: questionsCommentUrl } : {}),
              questions,
              ...(suggestedAnswers && suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
              usageReport: usageReportOrUndefined(),
            }, transitionOwner);
          }

          const answered = await hook;
          lastBudgetClockMs = await readRunBudgetClockStep();
          if ("expired" in answered) {
            throw new Error("clarification expired before it was answered");
          }
          // Scratch agent sandboxes have a JOB_TIMEOUT_MS lifetime while the
          // hook stays answerable for days, so any cached id may point at an
          // expired sandbox after the park. Drop the cache so the re-executed
          // block re-provisions; the code workspace is restored from its
          // snapshot separately below.
          ctx.agentSandboxIds = {};
          // Hook suspension is free wall time; only active work counts against
          // the run duration budget.
          if (entry.ticketKey) {
            const { repairClarificationLabelStep } = await import(
              "./run-ownership-steps.js"
            );
            await repairClarificationLabelStep(ticket.identifier, transitionOwner);
          }

          if (snapshot) {
            const { restoreCheckpointSandboxReferences } = await import(
              "../clarifications/checkpoint.js"
            );
            const { restoreClarificationSandboxStep } = await import(
              "./clarification-snapshot-steps.js"
            );
            const { ensureArthurTask } = await import("./blocks/prepare-workspace.js");
            const requiredAgents = requiredAgentsForDefinition({
              schemaVersion: plan.schemaVersion,
              nodes: plan.nodes,
              defaultKind: runDefaultKind,
              defaults: modelDefaults,
              harnessRuntimes,
            });
            const restoreBudget = await observeBudgetAtBoundary(true);
            if (restoreBudget.check.status !== "ok") {
              throw new RunBudgetError(restoreBudget.check);
            }
            const restored = await restoreClarificationSandboxStep({
              snapshotId: snapshot.snapshotId,
              subjectKey: entry.subjectKey,
              ownerToken: entry.ownerToken,
              timeoutMs: Math.max(1, Math.floor(restoreBudget.remainingDurationMs)),
              agents: requiredAgents,
              arthurTaskId: await ensureArthurTask(ctx),
            });
            ctx.sandboxId = restored.sandboxId;
            invalidateWorkspaceGate(ctx);
            ctx.sandboxIds.add(restored.sandboxId);
            const restoredSteps = restoreCheckpointSandboxReferences(
              checkpointSteps,
              snapshot.sourceSandboxId,
              restored.sandboxId,
            );
            for (const key of Object.keys(checkpointSteps)) delete checkpointSteps[key];
            Object.assign(checkpointSteps, restoredSteps);
            if (ctx.selectedRepositories.length > 0) {
              const { blockFetchPrContextsStep } = await import("./blocks/fetch-pr-context.js");
              ctx.repositoryContexts = await blockFetchPrContextsStep(ctx.selectedRepositories);
            }
          }

          const round = {
            questions,
            answer: answered.answer,
            answeredBy: answered.answeredByLabel,
            answeredAt: answered.answeredAt,
          };
          clarificationHistory = appendClarificationRound(clarificationHistory, round);
          ctx.clarifications = appendClarificationRound(ctx.clarifications, round);

          if (snapshot) {
            const { deleteClarificationSnapshotStep } = await import(
              "./clarification-snapshot-steps.js"
            );
            try {
              await deleteClarificationSnapshotStep(snapshot.snapshotId);
              await markClarificationHookCleanupStep(clarification.id, { status: "deleted" });
            } catch (error) {
              await markClarificationHookCleanupStep(clarification.id, {
                status: "failed",
                error: errorMessage(error),
              });
            }
          }
          return answered.answer;
        } catch (error) {
          await supersedeClarificationHookStep(clarification.id).catch(() => undefined);
          throw error;
        } finally {
          hook.dispose();
        }
      };

      const clarificationExit = awaitClarification;

      const failureExit = async (phase: string, reason: string): Promise<void> => {
        // Commit the run's "failed" status BEFORE the backlog move below fires a
        // Jira webhook. That self-triggered "ticket left the AI column" event
        // would otherwise race in and cancel this still-finalizing run,
        // overwriting a genuine failure with a "cancelled"/"blocked" status the
        // errors KPI never counts. The cron never downgrades a frozen status, so
        // recording "failed" first keeps the outcome correct even if the cancel
        // still lands.
        await markRunFailedOnSelfMoveStep(workflowRunId);
        const usageReport = usageReportOrUndefined();
        const knownPhase = FAILURE_PHASES.has(phase) ? (phase as NotifyPhase) : undefined;
        const { handleWorkflowFailureExit } = await import("./workflow-failure-exit.js");
        await handleWorkflowFailureExit(entry.ticketKey ?? undefined, {
          logFailure: () => logPhaseFailure(entry.subjectKey, phase, reason),
          moveTicket: () =>
            moveTicketStep(ticketId, backlogMoveTarget(), transitionOwner),
          notifyTicket: () => notifyTicket(ticket.identifier, {
            kind: "failed",
            ...(knownPhase ? { phase: knownPhase } : {}),
            reason,
            usageReport,
          }, transitionOwner),
        });
      };

      const terminate = async (
        params: {
          terminalStatus: TerminalStatus;
          postComment?: string;
        },
      ): Promise<void> => {
        // terminate is dispatched inline by the interpreter, so it never passes
        // through executeBlock's substituteNodePromptParams wrapper. Substitute
        // {{variables}} into the comment here so every terminal read below sees
        // resolved text.
        const postComment =
          typeof params.postComment === "string"
            ? substitutePromptVariables(params.postComment, buildPromptVariables(ctx))
            : params.postComment;
        const disposition = terminalStatusDisposition(params.terminalStatus);
        if (disposition.runOutcome === "success") {
          if (postComment && entry.ticketKey) {
            await postTicketComment(ticket.identifier, postComment, transitionOwner);
          }
          runOutcome = disposition.runOutcome;
          return;
        }
        if (!disposition.shouldRunFailureSideEffects) {
          runOutcome = disposition.runOutcome;
          return;
        }
        if (!entry.ticketKey) {
          runOutcome = disposition.runOutcome;
          return;
        }
        // Persist "failed" before this backlog move fires the self-triggered
        // "ticket left the AI column" webhook (same race as failureExit).
        await markRunFailedOnSelfMoveStep(workflowRunId);
        await moveTicketStep(ticketId, backlogMoveTarget(), transitionOwner);
        await notifyTicket(ticket.identifier, {
          kind: "failed",
          reason: postComment ?? "Terminated by workflow.",
          usageReport: usageReportOrUndefined(),
        }, transitionOwner);
        runOutcome = disposition.runOutcome;
      };

      const noWorkspace = (type: WorkflowBlockType): BlockExecutionResult => ({
        ...executionError(`no workspace: connect prepare_workspace before ${type}`, {
          category: "sandbox",
        }),
      });

      const attachmentSandboxIds = new Set<string>();
      const writeAttachmentsOnce = async (sandboxId: string): Promise<void> => {
        if (attachmentSandboxIds.has(sandboxId)) return;
        await writeAttachments(sandboxId, downloadedAttachments);
        attachmentSandboxIds.add(sandboxId);
      };
      const materializedClarificationSignatures = new Map<string, string>();
      const materializeHumanDecisions = async (): Promise<void> => {
        if (!ctx.sandboxId || !ctx.clarifications?.length) return;
        const signature = JSON.stringify(ctx.clarifications);
        if (materializedClarificationSignatures.get(ctx.sandboxId) === signature) return;
        const { writeHumanDecisionsMemory } = await import(
          "../sandbox/write-human-decisions-memory.js"
        );
        await writeHumanDecisionsMemory(
          ctx.sandboxId,
          ctx.ticket.identifier,
          ctx.clarifications,
        );
        invalidateWorkspaceGate(ctx);
        materializedClarificationSignatures.set(ctx.sandboxId, signature);
      };
      const ensureCodeWorkspace = async (execution?: BlockExecutionContext): Promise<
        | { kind: "ready"; sandboxId: string }
        | { kind: "exit"; result: BlockExecutionResult }
      > => {
        const result = await ensureWorkspace(ctx, execution);
        if (result.kind !== "next") return { kind: "exit", result };
        if (!ctx.sandboxId) return { kind: "exit", result: noWorkspace("prepare_workspace") };
        await writeAttachmentsOnce(ctx.sandboxId);
        await materializeHumanDecisions();
        return { kind: "ready", sandboxId: ctx.sandboxId };
      };

      const executeBlock: BlockExecutor = async (
        rawNode,
        steps,
        resolvedInputs,
        execution,
      ): Promise<BlockExecutionResult> => {
        const invocationAttempt = execution?.attempt ?? state.attempt;
        // Refresh {{change_summary}} from the implementation block's durable
        // output before substituting, so open_pr's description reflects what the
        // agent changed even on a resumed run where the impl case was skipped.
        ctx.changeSummary = implementationChangeSummary(steps, ctx.definitionNodes);
        // Substitute {{variables}} into prompt-bearing params per execution: the
        // run context (research plan, publication, selected repos) mutates
        // mid-run, so each block sees the values current at its turn.
        const node = substituteNodePromptParamsForSchema(
          rawNode,
          buildPromptVariables(ctx),
          ctx.schemaVersion,
        );
        await materializeHumanDecisions();
        if (
          node.type === "implementation_agent" ||
          node.type === "fix_agent" ||
          node.type === "run_pre_pr_checks" ||
          (node.type === "generic_agent" && node.params.workspaceMode !== "none")
        ) {
          invalidateWorkspaceGate(ctx);
        }
        const blockExecute = BLOCK_EXECUTORS[node.type];
        if (blockExecute) {
          const result = await blockExecute(
            node,
            steps,
            ctx,
            resolvedInputs,
            execution,
          );
          if (node.type === "prepare_workspace" && result.kind === "next" && ctx.sandboxId) {
            activeModel ??= defaultModel;
            await writeAttachmentsOnce(ctx.sandboxId);
            await materializeHumanDecisions();
          }
          prForTelemetry ??= publicationPrForTelemetry(ctx.publication);
          return result;
        }

        switch (node.type) {
          case "planning_agent": {
            const researchLabel =
              ctx.schemaVersion === 2
                ? `Research ${node.id}`
                : "Research";
            const researchArtifactPhase = agentArtifactPhase("research", execution);
            const researchPhase = phaseKey(researchLabel, invocationAttempt);
            const { kind, model, runtime } = resolveAgentForNode(node);
            const provisioned = await ensurePlanningAgentSandboxForBlock(
              ctx,
              kind,
              model,
              ctx.schemaVersion === 2,
              runtime,
            );
            if (provisioned.kind === "execution_error") return provisioned;
            const sandboxId = provisioned.sandboxId;
            await writeAttachmentsOnce(sandboxId);
            phaseModels[researchPhase] = model;
            runPhaseModels[researchPhase] = model;
            const researchRuntime = await prepareHarnessAgentInvocationStep(
              sandboxId,
              kind,
              model,
              ctx.arthur.taskId,
              runtime,
            );
            if (!researchRuntime.ok) {
              return agentProtocolBlockError(researchRuntime);
            }
            const researchGuard = await setCommitGuardStep(
              sandboxId,
              kind,
              false,
              runtime,
            );
            if (!researchGuard.ok) return agentProtocolBlockError(researchGuard);

            // Review-remediation framing: when this ticket already has a
            // workflow-owned PR, pull its human review feedback in BEFORE the
            // plan exists so the plan targets the requested changes. Workspace
            // prep refreshes this later; here it would otherwise be empty
            // because planning runs before any code workspace is provisioned.
            if (ctx.entry.kind === "ticket" && ctx.repositoryContexts.length === 0) {
              const { resolveTicketWorkflowOwnedReposStep, blockFetchPrContextsStep } =
                await import("./blocks/fetch-pr-context.js");
              const ownedRepos = await resolveTicketWorkflowOwnedReposStep(ctx.ticket.identifier);
              if (ownedRepos.length > 0) {
                ctx.repositoryContexts = await blockFetchPrContextsStep(ownedRepos);
              }
            }

            const { paths: researchPaths, script: researchScript } =
              await planPhaseStep(
                kind,
                researchArtifactPhase,
                model,
                RESEARCH_SCHEMA,
                runtime,
              );
            const researchContext = {
              ticket: resolveAgentTicketInput(resolvedInputs, ticketData, ctx.clarifications),
              branchName,
              attachments: downloadedAttachments,
              preSandboxAdditions: ctx.preSandboxAdditions.research,
              repositoryContexts: ctx.repositoryContexts,
            };
            let researchInput: string;
            if (execution?.compileEffectivePrompt) {
              const compiled = await execution.compileEffectivePrompt({
                blockPrompt: promptOverride(node) ?? "",
                runtimeData: assembleResearchPlanContext({
                  ...researchContext,
                  prompt: "",
                }),
                sandboxId,
              });
              if (!compiled.ok) return compiled.result;
              researchInput = compiled.prompt;
            } else {
              researchInput = assembleResearchPlanContext({
                ...researchContext,
                prompt: promptOverride(node) ?? prompts.research,
              });
            }

            const researchLaunch = await writeAndStartPhase(
              sandboxId, kind, researchArtifactPhase,
              researchPaths.input, researchInput,
              researchPaths.wrapper, researchScript,
              runtime,
            );
            if (!researchLaunch.ok) return agentProtocolBlockError(researchLaunch.failure);
            const researchCommandId = researchLaunch.commandId;
            launchedPhases.add(researchPhase);

            const researchDone = await pollPhaseUntilDone(
              sandboxId,
              researchPaths.sentinel,
              20,
              researchCommandId,
              blockBudgetObserver(ctx, execution),
              execution?.cancellation,
            );
            if (!researchDone) {
              await emitTimedOutAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: researchArtifactPhase,
                collectArtifacts: () =>
                  collectPhaseReplayDiagnostics(
                    sandboxId,
                    researchPaths,
                  ),
              });
              return executionError("phase timed out", {
                category: "timeout",
                phase: "research",
              });
            }

            const researchArtifacts = await collectPhase(sandboxId, researchPaths);
            const { result: researchResult, usage: researchUsage } =
              await parseResearchStep(
                kind,
                researchArtifacts,
                researchArtifactPhase,
                runtime,
              );
            await emitAgentInvocationObservations({
              observations: execution?.observations,
              provider: kind,
              model,
              phase: researchArtifactPhase,
              artifacts: researchArtifacts,
              usage: researchUsage,
              result: researchResult,
            });
            recordBlockPhaseUsage(
              ctx,
              researchLabel,
              researchUsage,
              model,
              execution,
            );
            if (!researchResult.ok) return agentProtocolBlockError(researchResult);
            const research = researchResult.value;

            if (research.status === "clarification_needed") {
              // Prefer the structured questions the parser now folds out; fall
              // back to the legacy regex split of the freeform body for older
              // agent outputs that only populate research.body.
              let questions: string[];
              if (research.questions && research.questions.length > 0) {
                questions = research.questions;
              } else {
                const parsed = research.body.split("\n").filter((l) => /^\d+\./.test(l.trim()));
                questions = parsed.length > 0 ? parsed : [research.body];
              }
              const suggestedAnswers = research.suggestedAnswers;
              return planningClarificationResult(questions, suggestedAnswers);
            }

            if (research.status === "failed") {
              const reason = research.body.slice(0, 200);
              return executionError(reason, {
                category: "provider",
                phase: "research",
              });
            }

            ctx.researchPlanMarkdown = research.body;
            return { kind: "next", output: { status: "ready", plan: research.body } };
          }

          case "implementation_agent": {
            const workspace = await ensureCodeWorkspace(execution);
            if (workspace.kind === "exit") return workspace.result;
            const sandboxId = workspace.sandboxId;
            const implementationLabel =
              ctx.schemaVersion === 2
                ? `Impl ${node.id}`
                : "Impl";
            const implementationArtifactPhase = agentArtifactPhase("impl", execution);
            const implPhase = phaseKey(
              implementationLabel,
              invocationAttempt,
            );
            const { kind, model, runtime } = resolveAgentForNode(node);
            phaseModels[implPhase] = model;
            runPhaseModels[implPhase] = model;
            state.implementationModel = model;
            state.implementationKind = kind;
            state.implementationRuntime = runtime;
            // Mixed-run telemetry: the run's headline model is the impl block's.
            activeModel = model;
            const implementationRuntime =
              await prepareHarnessAgentInvocationStep(
                sandboxId,
                kind,
                model,
                ctx.arthur.taskId,
                runtime,
              );
            if (!implementationRuntime.ok) {
              return agentProtocolBlockError(implementationRuntime);
            }
            const implementationGuard = await setCommitGuardStep(
              sandboxId,
              kind,
              true,
              runtime,
            );
            if (!implementationGuard.ok) return agentProtocolBlockError(implementationGuard);

            const { paths: implPaths, script: implScript } =
              await planPhaseStep(
                kind,
                implementationArtifactPhase,
                model,
                AGENT_SCHEMA,
                runtime,
              );
            const implementationContext = {
              ticket: resolveAgentTicketInput(resolvedInputs, ticketData, ctx.clarifications),
              researchPlanMarkdown: resolveImplementationPlanInput(
                resolvedInputs,
                ctx.researchPlanMarkdown,
              ),
              attachments: downloadedAttachments,
              preSandboxAdditions: ctx.preSandboxAdditions.implementation,
              selectedRepositories: ctx.selectedRepositories,
              repositoryContexts: ctx.repositoryContexts,
            };
            let implInput: string;
            if (execution?.compileEffectivePrompt) {
              const compiled = await execution.compileEffectivePrompt({
                blockPrompt: promptOverride(node) ?? "",
                runtimeData: assembleImplementationContext({
                  ...implementationContext,
                  prompt: "",
                }),
                sandboxId,
              });
              if (!compiled.ok) return compiled.result;
              implInput = compiled.prompt;
            } else {
              implInput = assembleImplementationContext({
                ...implementationContext,
                prompt: promptOverride(node) ?? prompts.implement,
              });
            }

            const implLaunch = await writeAndStartPhase(
              sandboxId, kind, implementationArtifactPhase,
              implPaths.input, implInput,
              implPaths.wrapper, implScript,
              runtime,
            );
            if (!implLaunch.ok) return agentProtocolBlockError(implLaunch.failure);
            const implCommandId = implLaunch.commandId;
            launchedPhases.add(implPhase);

            const implDone = await pollPhaseUntilDone(
              sandboxId,
              implPaths.sentinel,
              35,
              implCommandId,
              blockBudgetObserver(ctx, execution),
              execution?.cancellation,
            );
            let implOutput: AgentOutput;

            if (implDone) {
              const implArtifacts = await collectPhase(sandboxId, implPaths);
              const { result, usage: implUsage } = await parseAgentOutputStep(
                kind,
                implArtifacts,
                implementationArtifactPhase,
                runtime,
              );
              await emitAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: implementationArtifactPhase,
                artifacts: implArtifacts,
                usage: implUsage,
                result,
              });
              recordBlockPhaseUsage(
                ctx,
                implementationLabel,
                implUsage,
                model,
                execution,
              );
              if (!result.ok) return agentProtocolBlockError(result);
              implOutput = result.value;
            } else {
              await emitTimedOutAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: implementationArtifactPhase,
                collectArtifacts: () =>
                  collectPhaseReplayDiagnostics(sandboxId, implPaths),
              });
              implOutput = { result: "failed", error: "Implementation phase timed out" };
            }

            if (implOutput.result === "clarification_needed") {
              const questions = implOutput.questions ?? [];
              const suggestedAnswers = implOutput.suggestedAnswers;
              return {
                kind: "needs_human_input",
                output: { status: "needs_human_input", questions },
                questions,
                ...(suggestedAnswers && suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
              };
            }

            if (implOutput.result === "failed") {
              const reason = implOutput.error ?? "unknown";
              return executionError(reason, {
                category: implDone ? "provider" : "timeout",
                phase: "impl",
              });
            }

            if (!ctx.workspaceManifest) {
              return executionError("implementation workspace manifest is unavailable", {
                category: "sandbox",
                phase: "impl",
              });
            }
            try {
              const { inspectFixWorkspace } = await import("./blocks/fix-workspace-state.js");
              const workspaceState = await inspectFixWorkspace(sandboxId);
              return {
                kind: "next",
                output: buildImplementationAgentSuccessOutput({
                  workspaceId: sandboxId,
                  workspaceManifest: ctx.workspaceManifest,
                  commits: workspaceState.commits,
                  summary: implOutput.summary,
                }),
              };
            } catch (error) {
              if (isRunControlError(error)) throw error;
              return executionError(
                `could not inspect implementation workspace: ${errorMessage(error)}`,
                { category: "sandbox", phase: "impl" },
              );
            }
          }

          case "review_agent": {
            const workspace = await ensureCodeWorkspace(execution);
            if (workspace.kind === "exit") return workspace.result;
            const reviewFeedback = resolveReviewFeedbackInput(resolvedInputs, {
              ambient: ctx.entry.kind === "pr_trigger" ? ctx.entry.pr.review : undefined,
              allowAmbientFallback: ctx.schemaVersion === 1,
            });
            if (!reviewFeedback.ok) {
              return executionError("invalid reviewFeedback binding", {
                category: "binding",
                message: reviewFeedback.message,
              });
            }
            const { kind, model, runtime } = resolveAgentForNode(node);
            if (!ctx.workspaceManifest) {
              return executionError("review source workspace manifest is unavailable", {
                category: "sandbox",
                phase: "review",
              });
            }
            const {
              provisionDisposableReviewWorkspaceStep,
              verifyDisposableReviewWorkspaceStep,
            } = await import("../sandbox/disposable-review-workspace.js");
            const provisioned = await provisionDisposableReviewWorkspaceStep({
              sourceSandboxId: workspace.sandboxId,
              workspaceManifest: ctx.workspaceManifest,
              subjectKey: ctx.entry.subjectKey,
              ownerToken: ctx.entry.ownerToken,
              agentKind: kind,
              model,
              arthurTaskId: ctx.arthur.taskId,
              runtime,
            });
            if (!provisioned.ok) {
              return agentProtocolBlockError(provisioned.failure);
            }
            const sandboxId = provisioned.sandboxId;
            ctx.sandboxIds.add(sandboxId);
            const reviewLabel =
              ctx.schemaVersion === 2
                ? `Review ${node.id}`
                : "Review";
            const reviewArtifactPhase = agentArtifactPhase("review", execution);
            const reviewPhase = phaseKey(reviewLabel, invocationAttempt);
            phaseModels[reviewPhase] = model;
            runPhaseModels[reviewPhase] = model;
            try {
              const reviewRuntime = await prepareHarnessAgentInvocationStep(
                sandboxId,
                kind,
                model,
                ctx.arthur.taskId,
                runtime,
              );
              if (!reviewRuntime.ok) {
                return agentProtocolBlockError(reviewRuntime);
              }
              const reviewGuard = await setCommitGuardStep(
                sandboxId,
                kind,
                false,
                runtime,
              );
              if (!reviewGuard.ok) {
                return agentProtocolBlockError(reviewGuard);
              }
              const { paths: reviewPaths, script: reviewScript } =
                await planPhaseStep(
                  kind,
                  reviewArtifactPhase,
                  model,
                  REVIEW_SCHEMA,
                  runtime,
                );
              const reviewContext = {
                ticket: ticketData,
                researchPlanMarkdown: ctx.researchPlanMarkdown,
                ...(reviewFeedback.value
                  ? { reviewFeedback: reviewFeedback.value }
                  : {}),
                attachments: downloadedAttachments,
                preSandboxAdditions: ctx.preSandboxAdditions.review,
                selectedRepositories: ctx.selectedRepositories,
              };
              let reviewInput: string;
              if (execution?.compileEffectivePrompt) {
                const compiled = await execution.compileEffectivePrompt({
                  blockPrompt: promptOverride(node) ?? "",
                  runtimeData: assembleReviewContext({
                    ...reviewContext,
                    prompt: "",
                  }),
                  sandboxId,
                });
                if (!compiled.ok) return compiled.result;
                reviewInput = compiled.prompt;
              } else {
                reviewInput = assembleReviewContext({
                  ...reviewContext,
                  prompt: promptOverride(node) ?? prompts.review,
                });
              }

              const reviewLaunch = await writeAndStartPhase(
                sandboxId, kind, reviewArtifactPhase,
                reviewPaths.input, reviewInput,
                reviewPaths.wrapper, reviewScript,
                runtime,
              );
              if (!reviewLaunch.ok) return agentProtocolBlockError(reviewLaunch.failure);
              const reviewCommandId = reviewLaunch.commandId;
              launchedPhases.add(reviewPhase);

              const reviewDone = await pollPhaseUntilDone(
                sandboxId,
                reviewPaths.sentinel,
                15,
                reviewCommandId,
                blockBudgetObserver(ctx, execution),
                execution?.cancellation,
              );
              if (!reviewDone) {
                await emitTimedOutAgentInvocationObservations({
                  observations: execution?.observations,
                  provider: kind,
                  model,
                  phase: reviewArtifactPhase,
                  collectArtifacts: () =>
                    collectPhaseReplayDiagnostics(
                      sandboxId,
                      reviewPaths,
                    ),
                });
                return executionError("Review phase timed out", {
                  category: "timeout",
                  phase: "review",
                });
              }

              const reviewArtifacts = await collectPhase(sandboxId, reviewPaths);
              const { result, usage: reviewUsage } = await parseReviewStep(
                kind,
                reviewArtifacts,
                reviewArtifactPhase,
                runtime,
              );
              await emitAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: reviewArtifactPhase,
                artifacts: reviewArtifacts,
                usage: reviewUsage,
                result,
              });
              recordBlockPhaseUsage(
                ctx,
                reviewLabel,
                reviewUsage,
                model,
                execution,
              );
              if (!result.ok) return agentProtocolBlockError(result);
              const reviewOutput: ReviewOutput = result.value;

              const verified = await verifyDisposableReviewWorkspaceStep(
                sandboxId,
                ctx.workspaceManifest,
                provisioned.repositories,
              );
              if (!verified.ok) {
                return executionError(verified.error, {
                  category: "sandbox",
                  phase: "review",
                  message: "The disposable review workspace failed its integrity check.",
                });
              }

              if (reviewOutput.result === "failed") {
                const reason = reviewOutput.error ?? "unknown";
                return executionError(reason, {
                  category: "provider",
                  phase: "review",
                });
              }

              return {
                kind: "next",
                output: buildReviewAgentSuccessOutput(reviewOutput),
              };
            } finally {
              await teardownSandboxes([sandboxId]);
            }
          }

          case "run_pre_pr_checks": {
            if (!ctx.sandboxId) return noWorkspace(node.type);
            const maxFixCycles =
              typeof node.params.maxFixCycles === "number" ? node.params.maxFixCycles : undefined;
            const repairRuntime =
              state.implementationRuntime ??
              (ctx.schemaVersion === 2
                ? ctx.definitionNodes
                    .filter(
                      (candidate) =>
                        candidate.type === "implementation_agent" ||
                        candidate.type === "fix_agent" ||
                        (candidate.type === "generic_agent" &&
                          candidate.params.workspaceMode !== "none"),
                    )
                    .map((candidate) => ctx.harnessRuntimes[candidate.id])
                    .find(
                      (
                        candidate,
                      ): candidate is ResolvedHarnessRuntime =>
                        candidate !== undefined,
                    )
                : undefined);
            if (
              ctx.schemaVersion === 2 &&
              (maxFixCycles ?? 3) > 0 &&
              !repairRuntime
            ) {
              return executionError(
                "Pre-PR repair cycles require a pinned write-capable Harness Profile.",
                {
                  category: "schema",
                  phase: "pre-pr-checks",
                },
              );
            }
            const repairKind =
              repairRuntime?.manifest.harness.provider ??
              state.implementationKind ??
              runDefaultKind;
            const repairModel =
              repairRuntime?.manifest.model.id ??
              state.implementationModel;
            const budget = await ctx.observeBudget();
            if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
            let prePrChecks: Awaited<ReturnType<typeof runPrePrChecksStep>>;
            try {
              prePrChecks = await runPrePrChecksStep(
                ctx.sandboxId,
                repairKind,
                repairModel,
                maxFixCycles,
                Math.max(1, Math.floor(budget.remainingDurationMs)),
                {
                  state: budgetState,
                  limits: budgetLimits,
                  price: priceLookup?.(repairModel) ?? null,
                },
                repairRuntime,
                ctx.arthur.taskId,
              );
            } catch (err) {
              if (isRunControlError(err)) throw err;
              const after = await ctx.observeBudget();
              if (after.check.status !== "ok") throw new RunBudgetError(after.check);
              if (isDurationAbortError(err)) {
                throw new RunBudgetError(durationBudgetFailure(after, "Pre-PR checks"));
              }
              throw err;
            }
            recordPrePrFixCycleUsages(
              ctx,
              prePrChecks.fixCycleUsages,
              repairModel,
              prePrChecks.budgetFailure,
              invocationAttempt,
              ctx.schemaVersion === 2 ? node.id : undefined,
            );
            if (prePrChecks.agentFailure) {
              return agentProtocolBlockError(prePrChecks.agentFailure);
            }
            if (!prePrChecks.passed) {
              return {
                kind: "next",
                output: {
                  status: "ok",
                  ok: false,
                  outcome: prePrChecks.outcome,
                  fixCycles: prePrChecks.fixCycles,
                  summary: prePrChecks.summary,
                },
              };
            }
            if (
              prePrChecks.configurationVersion !== null &&
              ctx.workspaceManifest
            ) {
              ctx.prePrGate = await recordSuccessfulWorkspaceGate({
                sandboxId: ctx.sandboxId,
                workspaceManifest: ctx.workspaceManifest,
                configurationVersion: prePrChecks.configurationVersion,
              });
            }
            return {
              kind: "next",
              output: {
                status: "ok",
                ok: true,
                outcome: prePrChecks.outcome,
                fixCycles: prePrChecks.fixCycles,
                summary: prePrChecks.summary,
              },
            };
          }

          case "open_pr": {
            const repositories = resolvedInputs.repositories;
            if (!Array.isArray(repositories)) {
              return executionError(
                "Open PR/MR requires successful Finalize repository metadata",
                { category: "binding", phase: "open-pr" },
              );
            }
            // node.params.title/body are already {{var}}-substituted (executeBlock).
            // ticket.title is the last-resort title if a template resolves empty.
            const prVars = buildPromptVariables(ctx);
            const prTitle =
              resolveOpenPrTitle(node.params, resolvedInputs, prVars) || ticket.title;
            const prBody = resolveOpenPrBody(node.params, resolvedInputs, prVars);
            const publication = await openPullRequestsForPublication({
              repositories: repositories as import("./workspace-publication.js").FinalizedBranch[],
              runId: ctx.runId,
              subjectKey: transitionOwner.subjectKey,
              ownerToken: transitionOwner.ownerToken,
              ticketKey: ticket.identifier,
              title: prTitle,
              body: prBody,
              sourcePullRequest:
                ctx.entry.kind === "pr_trigger"
                  ? {
                      provider: ctx.entry.pr.provider,
                      repoPath: ctx.entry.pr.repoPath,
                      prId: ctx.entry.pr.prNumber,
                      headSha: ctx.entry.pr.headSha,
                      baseRef: ctx.entry.pr.baseRef,
                    }
                  : undefined,
            });
            ctx.publication = publication;

            if (publication.status === "failed") {
              if (publication.prs.length > 0) {
                await postPrLinksComment(
                  ticket.identifier,
                  publication.prs,
                  transitionOwner,
                  "Pull requests created before publication failed:",
                );
              }
              return executionError(publication.reason, {
                category: "provider",
                phase: "open-pr",
              });
            }

            if (publication.status !== "published") {
              return executionError(
                `Open PR/MR received unexpected publication status: ${publication.status}`,
                { category: "engine", phase: "open-pr" },
              );
            }

            if (publication.prs.some((pr) => pr.isNew)) {
              await postPrLinksComment(ticket.identifier, publication.prs, transitionOwner);
            }

            const primaryPr = publication.prs[0]!;
            prForTelemetry = { url: primaryPr.url, number: primaryPr.id };
            return { kind: "next", output: buildOpenPrSuccessOutput(publication.prs) };
          }

          case "send_slack_message": {
            // node.params.message is already {{variable}}-substituted (executeBlock).
            const message = resolveSlackMessageInput(node.params, resolvedInputs);
            const sendOn = node.params.sendOn === "always" ? "always" : "pr_ready";

            if (sendOn === "always") {
              // Standalone message: post it as a thread note whenever this block
              // runs, independent of any PR. Empty message is a no-op.
              if (!message) return { kind: "next", output: { status: "skipped" } };
              await notifyTicket(ticket.identifier, { kind: "note", text: message }, transitionOwner);
              return { kind: "next", output: { status: "ok" } };
            }

            // Default "pr_ready": ride along with the PR-ready card, only once a PR
            // has been published.
            const publication = ctx.publication;
            if (publication?.status === "published") {
              const primaryPr = publication.prs[0]!;
              const usageReport = formatUsageReport(phaseUsages, priceLookup, activeModel, phaseModels);
              await notifyTicket(ticket.identifier, {
                kind: "pr_ready",
                pr: { url: primaryPr.url, number: primaryPr.id },
                usageReport,
                ...(message ? { extraText: message } : {}),
              }, transitionOwner);
              return { kind: "next", output: { status: "ok" } };
            }
            return { kind: "next", output: { status: "skipped" } };
          }

          case "update_ticket_status": {
            const targetName = resolveTicketStatusInput(node.params, resolvedInputs);
            const target = resolveTicketMoveTarget(targetName, {
              backlog: backlogMoveTarget(),
              aiReview: aiReviewMoveTarget(),
            });
            if (!entry.ticketKey) {
              throw new Error("Update Ticket Status requires a correlated ticket.");
            }
            // The "ai_review" move is the run's own successful completion.
            // Commit the run's "success" status BEFORE that move fires the
            // self-triggered "ticket left the AI column" webhook (same race as
            // failureExit): when the webhook's actor lookup transiently fails
            // it fails safe as a human move and would cancel this
            // still-finalizing run, recording a real success as "blocked".
            // Only the symbolic success target gets this; backlog or arbitrary
            // status moves are generic ticket moves, not a completion.
            if (targetName === "ai_review") {
              await markRunSucceededOnSelfMoveStep(workflowRunId);
            }
            await moveTicketStep(entry.ticketKey, target, transitionOwner);
            return { kind: "next", output: { status: "ok", target: targetName } };
          }

          default:
            // Exhaustiveness guard: every action block must be dispatched by
            // BLOCK_EXECUTORS or a case above. Reaching here means a
            // WorkflowBlockType was added without wiring an executor; fail the run
            // loudly instead of silently succeeding as a no-op.
            throw new Error(
              `workflow block type "${node.type}" has no executor registered`,
            );
        }
      };

      const hooks: ExecuteGraphHooks = {
        onExecutionError: (event) =>
          logWorkflowExecutionErrorStep(
            safeWorkflowExecutionLogEvent(event),
          ),
        async onBlockStart(nodeId, attempt) {
          await enforceBudgetAtBoundary(true);
          currentBlockId = nodeId;
          activeBlockIds.add(nodeId);
          state.attempt = attempt;
          blockStatuses[nodeId] = { status: "running", attempt };
          await writeBlockStatuses();
        },
        async onBlockFinish(nodeId, state) {
          // V1 is serial, so every launched phase belongs to the block that
          // just finished. V2 may have active siblings; reconciling the global
          // set here would permanently mark their still-running usage unknown.
          if (shouldReconcilePhaseUsageOnBlockFinish(plan.schemaVersion)) {
            reconcileMissingPhaseUsages();
          }
          blockStatuses[nodeId] = blockRunStateSummary(state);
          await writeBlockStatuses();
          activeBlockIds.delete(nodeId);
          currentBlockId = [...activeBlockIds].at(-1) ?? null;
          await enforceBudgetAtBoundary(false);
        },
        clarificationExit,
        failureExit,
        terminate,
      };

      const runValues = {
        id: workflowRunId,
        branchName,
        defaultAgent: { provider: runDefaultKind, model: defaultModel },
      };
      const v2AgentArtifactKeys =
        plan.schemaVersion === 2
          ? buildV2AgentArtifactKeys(
              (plan.definition as WorkflowDefinitionV2).nodes,
            )
          : new Map<string, string>();
      const executeV2Block: V2BlockExecutor = async (
        node,
        steps,
        resolvedInputs,
        invocation,
      ) => {
        invocation.cancellation.throwIfCancelled();
        state.attempt = invocation.attempt;
        const harnessRuntime = ctx.harnessRuntimes[node.id];
        const invocationBudget = harnessRuntime
          ? await createHarnessInvocationBudget({
              workflowLimits: budgetLimits,
              runtime: harnessRuntime,
              observeWorkflowBudget: observeBudgetAtBoundary,
              readClock: readRunBudgetClockStep,
              priceLookup,
            })
          : undefined;
        const bindingContext: V2BindingResolutionContext = {
          entryOutput: triggerOutput,
          runValues,
          getStepOutput: (nodeId) => steps[nodeId]?.output,
        };
        const configuration = resolveV2PromptDataConfiguration(
          node,
          bindingContext,
          { preserveAgentPromptSource: true },
        );
        const placeholderIssue = v2NonAgentPromptPlaceholderIssue(
          node.type,
          configuration,
        );
        if (placeholderIssue) {
          return executionError(placeholderIssue, {
            category: "binding",
            phase: node.type,
            message:
              "The block has an unresolved prompt placeholder. Update and redeploy the workflow.",
          });
        }
        const compileInvocationPrompt: NonNullable<
          BlockExecutionContext["compileEffectivePrompt"]
        > = async ({ blockPrompt, runtimeData, sandboxId }) => {
          const runtime = harnessRuntime;
          if (!runtime) {
            return {
              ok: false,
              result: executionError(
                "The pinned Harness Profile could not be resolved.",
                {
                  category: "schema",
                  phase: node.type,
                  message:
                    "The agent's Harness Profile is unavailable. Select a published profile version and deploy again.",
                },
              ),
            };
          }
          const profileSource = effectivePromptProfileSource(runtime);
          let repositorySources: Awaited<
            ReturnType<typeof loadInvocationRepositoryInstructionSources>
          > = [];
          if (
            runtime.manifest.context.includeRepositoryInstructions &&
            ctx.workspaceManifest
          ) {
            try {
              repositorySources =
                await loadInvocationRepositoryInstructionSources({
                  nodeType: node.type,
                  executionSandboxId: sandboxId,
                  sharedCodeSandboxId: ctx.sandboxId,
                  manifest: ctx.workspaceManifest,
                });
            } catch (error) {
              if (isRunControlError(error)) throw error;
              return {
                ok: false,
                result: executionError(
                  `Repository instructions could not be loaded: ${errorMessage(error)}`,
                  {
                    category: "sandbox",
                    phase: node.type,
                    message:
                      "Repository instructions could not be loaded safely.",
                  },
                ),
              };
            }
          }
          const compilation = await compileEffectivePrompt({
            nodeId: node.id,
            blockPrompt:
              blockPrompt.trim().length > 0
                ? blockPrompt
                : compatibilityPromptSourceForV2Node(node) ?? blockPrompt,
            runtimeData: runtime.manifest.context.includeWorkflowData
              ? runtimeData
              : "",
            slots: resolvedPrompts.slotsByNode[node.id] ?? [],
            slotBindings: node.configuration.promptSlotBindings,
            promptManifest:
              resolvedPrompts.manifestByNode[node.id] ?? [],
            profileSource,
            repositorySources,
            bindingContext,
          });
          if (compilation.issues.length > 0) {
            return {
              ok: false,
              result: executionError(
                compilation.issues
                  .map((issue) => issue.message)
                  .join("; "),
                {
                  category: "binding",
                  phase: node.type,
                  message:
                    "The effective prompt is incomplete or has invalid values.",
                },
              ),
            };
          }
          return { ok: true, prompt: compilation.prompt };
        };
        if (node.type === "transform") {
          if (!Object.values(resolvedInputs).every(isJsonValue)) {
            return executionError("Transform received a non-JSON input.", {
              category: "binding",
              phase: "transform",
            });
          }
          try {
            return {
              kind: "next",
              output: {
                status: "ok",
                output: executeTransform(
                  configuration as unknown as TransformConfiguration,
                  resolvedInputs as Record<string, JsonValue>,
                ),
              },
            };
          } catch (error) {
            return executionError(errorMessage(error), {
              category: "binding",
              phase: "transform",
            });
          }
        }
        if (node.type === "terminate") {
          const terminalStatus = configuration.terminalStatus;
          if (
            terminalStatus !== "waiting_for_human" &&
            terminalStatus !== "failed" &&
            terminalStatus !== "skipped" &&
            terminalStatus !== "done"
          ) {
            return executionError("Terminate has an invalid terminal status.", {
              category: "engine",
              phase: "terminate",
            });
          }
          const postComment =
            typeof configuration.postComment === "string"
              ? configuration.postComment
              : undefined;
          const result = v2TerminalBlockResult({
            terminalStatus,
            ...(postComment === undefined ? {} : { postComment }),
            ...(invocation.clarificationAnswer === undefined
              ? {}
              : { clarificationAnswer: invocation.clarificationAnswer }),
          });
          if (
            result.kind === "next" &&
            terminalStatus !== "waiting_for_human" &&
            postComment &&
            entry.ticketKey
          ) {
            await postTicketComment(
              ticket.identifier,
              postComment,
              transitionOwner,
            );
          }
          return result;
        }
        if (node.type === "open_pr") {
          const provenanceIssue =
            v2OpenPrRepositoriesProvenanceIssue({
              node,
              definition: plan.definition as WorkflowDefinitionV2,
              steps,
              resolvedInputs,
              publication: ctx.publication,
            });
          if (provenanceIssue) {
            return executionError(provenanceIssue, {
              category: "binding",
              phase: "open-pr",
            });
          }
        }
        const legacyNode: WorkflowDefinitionNode = {
          id: node.id,
          type: node.type,
          ...(node.name ? { name: node.name } : {}),
          x: node.x,
          y: node.y,
          params: structuredClone(configuration) as unknown as Record<
            string,
            WorkflowParamValue
          >,
          inputs: {},
        };
        const result = await executeBlock(
          legacyNode,
          structuredClone(steps) as StepsRecord,
          structuredClone(resolvedInputs),
          {
            attempt: invocation.attempt,
            agentArtifactKey: v2AgentArtifactKeys.get(node.id)!,
            cancellation: invocation.cancellation,
            observations: invocation.observations,
            compileEffectivePrompt: compileInvocationPrompt,
            ...(invocationBudget
              ? {
                  observeBudget: invocationBudget.observeBudget,
                  recordBudgetUsage: invocationBudget.recordUsage,
                }
              : {}),
            ...(invocation.clarificationAnswer === undefined
              ? {}
              : { clarificationAnswer: invocation.clarificationAnswer }),
          },
        );
        if (invocationBudget) {
          const after = await invocationBudget.observeBudget(false);
          if (after.check.status !== "ok") {
            throw new RunBudgetError(after.check);
          }
        }
        invocation.cancellation.throwIfCancelled();
        return result;
      };

      const v2Hooks: V2SchedulerHooks = {
        onTriggerActivated(event) {
          void v2RunObservation?.onTriggerActivated?.(event);
        },
        async onNodeStart(event) {
          await hooks.onBlockStart(event.nodeId, event.attempt);
          void v2RunObservation?.onNodeStart?.(event);
        },
        onNodeWaiting(event) {
          void v2RunObservation?.onNodeWaiting?.(event);
        },
        async onNodeFinish(event) {
          void v2RunObservation?.onNodeFinish?.(event);
          await hooks.onBlockFinish(event.nodeId, event.state);
        },
        async onNodeSkipped(event) {
          void v2RunObservation?.onNodeSkipped?.(event);
          blockStatuses[event.nodeId] = {
            status: "ok",
            attempt: event.attempt,
          };
          await writeBlockStatuses();
        },
        async onExecutionError({ state: errorState, error, activationScopeId }) {
          if (error.diagnostic) {
            const observation =
              v2RunObservation?.observationHooksFor?.({
                nodeId: errorState.nodeId,
                attempt: errorState.attempt,
                activationScopeId,
              });
            const { stdoutTail, stderrTail } = error.diagnostic;
            void observation?.emit({
              kind: "metadata",
              value: {
                agentProtocol: safeReplayAgentProtocolMetadata(error.diagnostic),
              },
            });
            if (stdoutTail) {
              void observation?.emit({
                kind: "log",
                value: { stream: "stdout", tail: stdoutTail },
              });
            }
            if (stderrTail) {
              void observation?.emit({
                kind: "log",
                value: { stream: "stderr", tail: stderrTail },
              });
            }
          }
          await logWorkflowExecutionErrorStep(
            safeWorkflowExecutionLogEvent({
              diagnosticId: errorState.diagnosticId,
              nodeId: errorState.nodeId,
              attempt: errorState.attempt,
              category: errorState.category,
              ...(errorState.phase ? { phase: errorState.phase } : {}),
              ...(error.diagnostic
                ? { agentProtocol: error.diagnostic }
                : {}),
            }),
          );
        },
        observationHooksFor: (identity) =>
          v2RunObservation?.observationHooksFor?.(identity) ?? {
            emit() {},
          },
      };

      let walk:
        | Awaited<ReturnType<typeof executeGraph>>
        | Awaited<ReturnType<typeof executeV2Graph>>;
      if (plan.schemaVersion === 1) {
        walk = await executeGraph({
          runId: workflowRunId,
          graph,
          entryTriggerId: entryTrigger.id,
          triggerOutput,
          runValues,
          executeBlock,
          hooks,
          shouldRethrowExecutionError: isRunControlError,
          maxTotalExecutions: 200,
        });
      } else {
        const definition = plan.definition as WorkflowDefinitionV2;
        let resume:
          | {
              checkpoint: V2SchedulerCheckpoint;
              clarificationAnswer: string;
            }
          | undefined;
        while (true) {
          const v2Walk = await executeV2Graph({
            runId: workflowRunId,
            definition,
            entryTriggerId: entryTrigger.id,
            triggerOutput,
            runValues,
            executeBlock: executeV2Block,
            hooks: v2Hooks,
            maxConcurrency: 4,
            maxTotalExecutions: 200,
            shouldRethrowExecutionError: isRunControlError,
            ...(resume ? { resume } : {}),
          });
          if (v2Walk.outcome !== "paused") {
            walk = v2Walk;
            break;
          }
          const clarification = v2Walk.clarification;
          if (!clarification) {
            throw new Error("v2 scheduler paused without clarification state");
          }
          const sourceSandboxId = ctx.sandboxId;
          const answer = await awaitClarification(
            clarification.questions,
            clarification.nodeId,
            clarification.suggestedAnswers,
            v2Walk.steps,
          );
          let checkpoint = v2Walk.state;
          if (
            sourceSandboxId &&
            ctx.sandboxId &&
            sourceSandboxId !== ctx.sandboxId
          ) {
            const { restoreCheckpointValueSandboxReferences } = await import(
              "../clarifications/checkpoint.js"
            );
            checkpoint = restoreCheckpointValueSandboxReferences(
              checkpoint,
              sourceSandboxId,
              ctx.sandboxId,
            );
          }
          resume = { checkpoint, clarificationAnswer: answer };
        }
      }
      terminalExecutionError = walk.executionError ?? null;
      if (terminalExecutionError && plan.schemaVersion === 2) {
        await failureExit(
          terminalExecutionError.phase ?? "workflow",
          formatExecutionErrorForUser(terminalExecutionError),
        );
      }
      // "ended" is a clean awaiting stop (e.g. send_plan_approval parked the
      // run for human approval and already moved the ticket): a success, not a
      // failure. No ticket move here; the block owns that.
      // Constraint: never promote a clarification park to success here. The
      // terminate/clarification paths set runOutcome = "awaiting" and own it
      // (the answer endpoint flips it later), so a completed/ended walk that
      // left "awaiting" set must keep it. The `as string` read is needed
      // because TS can't see the hook closures writing runOutcome and narrows
      // it to its "failed" initializer.
      if (
        !terminalExecutionError &&
        (walk.outcome === "completed" || walk.outcome === "ended") &&
        (runOutcome as string) !== "awaiting"
      ) {
        currentBlockId = null;
        runOutcome = "success";
      }
    } finally {
      // Tear down EVERY sandbox the run created, not just the latest
      // ctx.sandboxId: a prepare_workspace inside a loop provisions a fresh
      // sandbox each iteration, and all but the last would otherwise leak.
      await teardownSandboxes(ctx.sandboxIds);
    }
  } catch (caught) {
    reconcileMissingPhaseUsages();
    let err = caught;
    if (!isRunControlError(err)) {
      const observation = await observeBudgetAtBoundary(false);
      if (observation.check.status !== "ok") err = new RunBudgetError(observation.check);
    }
    terminalBudgetFailure = runBudgetFailureFromError(err);
    const controlError = isRunControlError(err);
    if (!controlError) {
      const nodeId = currentBlockId ?? "engine";
      const attempt = blockStatuses[nodeId]?.attempt ?? 1;
      const blockError = executionError(errorMessage(err), {
        category: currentBlockId ? "unknown" : "engine",
        phase: currentBlockId ? undefined : "engine",
      }).error;
      const diagnostic = createWorkflowExecutionErrorState(
        workflowRunId,
        nodeId,
        attempt,
        blockError,
      );
      terminalExecutionError ??= diagnostic;
      console.error(
        `[${diagnostic.diagnosticId}] unhandled workflow execution error`,
      );
      err = new WorkflowExecutionError(terminalExecutionError);
    }
    const { handleUnhandledWorkflowError } = await import("./workflow-failure-exit.js");
    await handleUnhandledWorkflowError(err, {
      recordBlockFailure: async (error) => {
        if (!currentBlockId) return;
        blockStatuses[currentBlockId] = {
          status: "fail",
          error: terminalExecutionError?.message ?? truncateError(errorMessage(error)),
          ...(terminalExecutionError
            ? { diagnosticId: terminalExecutionError.diagnosticId }
            : {}),
        };
        await writeBlockStatuses();
      },
      applyDefaultFailure: async (error) => {
        console.error(
          `[${terminalExecutionError?.diagnosticId ?? "workflow-failed"}] Workflow failed for ${ticket.identifier}`,
        );
        if (!entry.ticketKey) return;

        // Persist "failed" before this backlog move fires the self-triggered
        // "ticket left the AI column" webhook (same race as failureExit).
        await markRunFailedOnSelfMoveStep(workflowRunId);
        let moved = false;
        try {
          await moveTicketStep(
            ticketId,
            backlogMoveTarget(),
            transitionOwner,
          );
          moved = true;
        } catch (moveError) {
          if (isRunControlError(moveError)) throw moveError;
        }

        try {
          await notifyTicket(ticket.identifier, {
            kind: "failed",
            reason: errorMessage(error),
            usageReport: usageReportOrUndefined(),
          }, transitionOwner);
        } catch (notifyError) {
          if (isRunControlError(notifyError)) throw notifyError;
        }

        if (!moved) {
          await markTicketFailed(
            ticket.identifier,
            workflowRunId,
            `Failed to move ticket to backlog: ${errorMessage(error)}`,
            transitionOwner,
          ).catch(() => {});
        }
      },
    });
    if (controlError) throw err;
  } finally {
    await v2RunObservation?.finalize("workflow_finished");
    // A launched phase with no parsed usage (timed out / errored before
    // collect) records as unknown, so computeUsageTotals reports
    // costKnown=false instead of a misleading costUsd=0 / costKnown=true.
    reconcileMissingPhaseUsages();
    // Durable cost/usage telemetry, recorded on every exit path (success,
    // clarification, or failure). Best-effort: the step never retries and we
    // swallow errors so telemetry can't break or delay the run — but we LOG
    // the failure so a silent break (e.g. a schema drift like a missing column
    // on the run's Neon branch) surfaces immediately instead of dropping run
    // history for days unnoticed.
    await recordRunTelemetryStep({
      runId: workflowRunId,
      subjectKey: entry.subjectKey,
      status: runOutcome,
      ticketKey: entry.ticketKey ?? null,
      ticketTitle: ticket.title,
      ticketUrl: entry.ticketKey
        ? `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`
        : entry.kind === "pr_trigger"
          ? entry.pr.prUrl
          : null,
      model: activeModel ?? null,
      totals: computeUsageTotals(
        runPhaseUsages,
        priceLookup,
        activeModel,
        runPhaseModels,
      ),
      budgetFailure: terminalBudgetFailure,
      pr: prForTelemetry,
      executionError: terminalExecutionError
        ? {
            message: formatExecutionErrorForUser(terminalExecutionError),
            code: terminalExecutionError.diagnosticId,
          }
        : null,
      harnessManifests,
    }).catch(() => {
      console.error(
        `Run telemetry failed to persist for ${ticket.identifier} (run ${workflowRunId})`,
      );
    });
  }
  return terminalExecutionError
    ? { kind: "execution_error", error: terminalExecutionError }
    : runOutcome;
}
