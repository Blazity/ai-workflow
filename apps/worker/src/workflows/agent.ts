import { createHook, getWorkflowMetadata } from "workflow";
import { branchForTicket } from "../lib/workflow-naming.js";
import { ticketRunUrl, ticketPageUrl, hasDashboardLinkComment } from "../lib/dashboard-links.js";
import {
  computeUsageTotals,
  type PriceLookup,
  type TokenPrice,
  type UsageTotals,
} from "../sandbox/usage.js";
import type {
  AgentOutput, AgentProtocolResult, CollectedPhaseArtifacts, PhaseUsage, PhaseKind,
  PhaseArtifactPaths, ResearchRepository, ResearchResult, ReviewOutput,
} from "../sandbox/agents/types.js";
import type { AgentKind } from "../sandbox/agents/index.js";
import { isAgentRuntimeError } from "../sandbox/agents/runtime-error.js";
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
  V2_PRODUCTION_SCHEDULER_BOUNDS,
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
  emitRepositoryWorkflowObservation,
  emitTimedOutAgentInvocationObservations,
} from "../run-observability/agent-observations.js";
import { persistWorkspaceMemoryStep } from "./memory-steps.js";
import {
  distillRepoMemoryStep,
  loadRepoMemorySourcesStep,
} from "./repo-memory-steps.js";
import { resolveAgentInput } from "./resolve-agent-input.js";
import {
  assembleReviewChangeSetAddition,
  pullRequestChangeSetTarget,
} from "./review-change-set.js";
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
  ExecutionErrorCategory,
} from "../workflow-definition/interpreter.js";
import { resolveBlockAgent, resolveRunDefaultKind } from "../workflow-definition/resolve-agent.js";
import { resolveTicketMoveTarget } from "./ticket-move-target.js";
import {
  runKindForAgentWorkflowInput,
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
import {
  workspaceRepositoryAccess,
  type WorkspaceManifest,
  type WorkspaceRepositoryInput,
} from "../sandbox/repo-workspace.js";
import type { RepositoryExpansionDecision } from "../repository-discovery/runner.js";
import {
  ensureWorkspace,
  maybePromoteGenericAgentWorkspace,
  maybePromoteTicketWorkspaceWrites,
  promoteWorkspaceWrites,
  requiredAgentsForDefinition,
  researchDeclaredNoWritesGuard,
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
import { execute as executeCreatePrCheck } from "./blocks/create-pr-check.js";
import { execute as executeCompletePrCheck } from "./blocks/complete-pr-check.js";
import { execute as executePostPrReview } from "./blocks/post-pr-review.js";
import { execute as executeHumanQuestion } from "./blocks/human-question.js";
import { execute as executeArthurInjectionCheck } from "./blocks/arthur-injection-check.js";
import { execute as executeLeakReview } from "./blocks/leak-review.js";
import { execute as executeSendPlanApproval } from "./blocks/send-plan-approval.js";
import {
  BLOCK_TYPE_SPECS,
  DEFAULT_OPEN_PR_BODY,
  DEFAULT_OPEN_PR_TITLE,
  isTriggerBlockType,
  isV2OnlyBlockType,
} from "@shared/contracts";
import type {
  BlockOutput,
  BlockRunState,
  JsonValue,
  ReplayAttemptOutcome,
  ReplayObservationKind,
  ReplaySanitizedEnvelope,
  ResolvedPromptReference,
  RunPullRequest,
  TransformConfiguration,
  VcsProviderKind,
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
  WorkflowRepositoryScope,
} from "@shared/contracts";
import { combineHarnessRuntimeLimits } from "../sandbox/harness-runtime-limits.js";
import type { ResolvedHarnessRuntime } from "../sandbox/harness-runtime.js";

/**
 * Model the repository-memory distill pins on the codex path. The distill is a
 * structured extraction, not agent work: resolveCallLlmTarget already pins the
 * cheap claude-haiku default on the claude path, but its codex branch returns
 * CODEX_MODEL, the full agent model, at roughly ten times the cost for the same
 * job. Not invented here: it is the cheapest codex id the deployment already
 * offers, FALLBACK_MODELS.codex in workflow-definition/models.ts. Only the
 * distill reads this; every other resolveCallLlmTarget consumer is unchanged.
 * Exported so a test can assert it against the deployment's own catalog: a
 * wrong id fails every distill on the codex path and the failure is only
 * logged, so nothing else would notice.
 */
export const REPO_MEMORY_DISTILL_CODEX_MODEL = "gpt-5-mini";

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
  finalize_workspace: executeFinalizeWorkspace,
  fix_agent: executeFixAgent,
  generic_agent: executeGenericAgent,
  call_llm: executeCallLlm,
  fetch_pr_context: executeFetchPrContext,
  run_checks: executeRunChecks,
  post_ticket_comment: executePostTicketComment,
  post_pr_comment: executePostPrComment,
  create_pr_check: executeCreatePrCheck,
  complete_pr_check: executeCompletePrCheck,
  post_pr_review: executePostPrReview,
  human_question: executeHumanQuestion,
  arthur_injection_check: executeArthurInjectionCheck,
  leak_review: executeLeakReview,
  send_plan_approval: executeSendPlanApproval,
};

// Action blocks executed by the inline switch inside executeBlock (they need
// run-scoped closure state, so they can't live in the registry above). Kept in
// sync with the switch cases; blockTypesMissingExecutor() (asserted in tests)
// turns any drift into a loud failure instead of a silent no-op.
const INLINE_EXECUTED_BLOCK_TYPES: readonly WorkflowBlockType[] = [
  "prepare_workspace",
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
    .filter(
      (type): type is WorkflowBlockTypeV1 =>
        !isV2OnlyBlockType(type),
    )
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
  // Strict-mode providers must emit every key, so a missing line arrives as
  // null. The Review Result contract accepts positive integers only, so those
  // nulls are dropped here instead of failing validation downstream.
  const line = (value: number | null | undefined): number | undefined =>
    typeof value === "number" && value >= 1 ? value : undefined;
  return {
    status: "reviewed",
    findings: review.issues.map((finding) => {
      const startLine = line(finding.startLine);
      // The Review Result normalizer rejects an endLine without a startLine and
      // an endLine below its startLine, so neither shape may reach the output.
      const candidateEnd = line(finding.endLine);
      const endLine =
        startLine !== undefined &&
        candidateEnd !== undefined &&
        candidateEnd >= startLine
          ? candidateEnd
          : undefined;
      return {
        file: finding.file,
        description: finding.description,
        severity: finding.severity,
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
      };
    }),
    decision: review.issues.some(
      (finding) => finding.severity === "Blocker" || finding.severity === "High",
    )
      ? "request_changes"
      : "approve",
    ...(feedback ? { feedback } : {}),
  };
}

export function reviewAgentExecutionResult(
  schemaVersion: 1 | 2,
  review: ReviewOutput,
): BlockExecutionResult {
  if (schemaVersion === 1 && review.result === "failed") {
    return executionError(review.error ?? "unknown", {
      category: "unknown",
      phase: "review",
    });
  }
  return {
    kind: "next",
    output: buildReviewAgentSuccessOutput(review),
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

/**
 * Provider and model the repository-memory distill calls with. Shared by the
 * price prefetch and the distill call site so the two cannot drift: a phase
 * whose model is missing from the price map reports an unknown cost, and one
 * unknown phase marks the WHOLE run's cost unknown.
 */
export function repoMemoryDistillTarget(
  runDefaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): { provider: "claude" | "codex" | undefined; model: string } {
  return resolveCallLlmTarget(
    runDefaultKind === "codex"
      ? { provider: "codex", model: REPO_MEMORY_DISTILL_CODEX_MODEL }
      : {},
    runDefaultKind,
    defaults,
  );
}

/**
 * Models worth pricing whose price must never fail a run. The distill is
 * observed and never enforced (an exhausted budget skips it), so feeding its
 * model to missingRequiredPriceFailure would let a missing LiteLLM entry fail a
 * run with maxCostUsd set over a call the run does not depend on. Both providers
 * are covered: the claude default reaches the price map today only when the
 * definition happens to contain a call_llm block, and the codex one not at all.
 */
export function optionalPricedModelsForRun(input: {
  enableRepoMemory: boolean;
  runDefaultKind: AgentKind;
  defaults: { claude: string; codex: string };
}): Set<string> {
  if (!input.enableRepoMemory) return new Set();
  return new Set([
    repoMemoryDistillTarget(input.runDefaultKind, input.defaults).model,
  ]);
}

/**
 * Fetch every model price the run can need, then build the lookup the telemetry
 * and budget paths read. Prices are fetched for the required and the optional
 * models alike; only a missing REQUIRED price fails the run, which is what keeps
 * an optional model from turning a missing LiteLLM entry into a budget failure.
 * Returns undefined when there is nothing to price, leaving the caller's lookup
 * unset exactly as before.
 */
export async function resolveRunPriceLookup(input: {
  requiredModels: ReadonlySet<string>;
  optionalModels: ReadonlySet<string>;
  maxCostUsd: number | undefined;
  fetchPrice: (model: string) => Promise<TokenPrice | null>;
}): Promise<PriceLookup | undefined> {
  // fetchPrice is a workflow step. Invoking it as a property of `input` captures
  // `input` as the call receiver, and the Workflow SDK then tries to serialize
  // that receiver. Destructure first so every call is a free-function call with
  // serializable arguments only (same reason as createHarnessInvocationBudget).
  const { fetchPrice } = input;
  // Insertion order, so the sequence of price steps stays deterministic across
  // a replay.
  const toFetch = [...new Set([...input.requiredModels, ...input.optionalModels])];
  if (toFetch.length === 0) return undefined;

  const priceMap = new Map<string, TokenPrice>();
  for (const model of toFetch) {
    const price = await fetchPrice(model);
    if (price) priceMap.set(model, price);
  }
  const missingPriceFailure = missingRequiredPriceFailure(
    input.maxCostUsd,
    input.requiredModels,
    priceMap,
  );
  if (missingPriceFailure) throw new RunBudgetError(missingPriceFailure);
  return (model) => priceMap.get(model) ?? null;
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

/** Whether the planning run promotes the research write set right after research
 *  completes. Two cases skip it, in both of which promoting here would be wrong:
 *  - Approval-gated graphs (a send_plan_approval node). Promoting before approval
 *    creates a remote branch plus a workflow-owned-branches ledger row that a
 *    rejected plan would never clean up, force-pinning the repo into every future
 *    selection. The approved implementation run re-creates the scope and promotes
 *    from the approved plan instead, so the branch is created only on approval.
 *  - An empty write set (a research-only ticket: investigation, question, or "no
 *    changes needed"). There is nothing to promote; recording the empty set is
 *    enough, and a downstream code-writing block fails loud via the requireWrite
 *    guard rather than dying at publication.
 *  ctx.researchWriteRepositories is recorded regardless so send_plan_approval can
 *  persist the correct write scope for the approved run. */
export function shouldPromoteResearchWriteScope(input: {
  definitionNodes: WorkflowDefinitionNode[];
  writeRepositories: ResearchRepository[];
  manifestVersion: 1 | 2 | undefined;
}): boolean {
  if (input.manifestVersion !== 2) return false;
  if (input.writeRepositories.length === 0) return false;
  if (input.definitionNodes.some((node) => node.type === "send_plan_approval")) {
    return false;
  }
  return true;
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

/** Every PR/MR the publication opened, for the run's durable PR list. Kept
 * alongside publicationPrForTelemetry rather than replacing it: the single
 * prUrl/prNumber columns are still written (gate runs share them) and stay the
 * first entry, while this preserves the repositories the first entry drops. */
function publicationPrsForTelemetry(
  publication: WorkspacePublicationResult | null | undefined,
): RunPullRequest[] | null {
  if (publication?.status !== "published" || publication.prs.length === 0) return null;
  return publication.prs.map((pr) => ({
    provider: pr.provider,
    repoPath: pr.repoPath,
    id: pr.id,
    url: pr.url,
  }));
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

/**
 * AIW-147 IM-11: when a human answered the expansion-limit clarification, attach
 * the repositories they named beyond the model round limit and let research
 * continue. Detection keys on the LATEST clarification round matching the
 * expansion-limit prompt; validation and attachment run through injected steps
 * so the whole path stays WDK-replay-safe and every ctx mutation derives from a
 * step output. It never counts a model expansion round (human authority sits
 * above the model round limit). Returns "noop" when there is nothing to do (no
 * such answer, workspace not yet trusted, or every named repository is already
 * attached) so the caller falls through to running research.
 */
export async function applyHumanRepositoryExpansion(
  ctx: Pick<
    EngineCtx,
    | "clarifications"
    | "sandboxId"
    | "workspaceManifest"
    | "selectedRepositories"
    | "repositoryContexts"
  >,
  deps: {
    resolve: (
      answer: string,
      attached: Array<{ provider: "github" | "gitlab"; repoPath: string }>,
    ) => Promise<RepositoryExpansionDecision>;
    attach: (repositories: SelectedRepository[]) => Promise<{
      manifest: Extract<WorkspaceManifest, { version: 2 }>;
      cloneDurationMs: number;
    }>;
    fetchContexts: (
      repositories: WorkspaceRepositoryInput[],
    ) => Promise<EngineCtx["repositoryContexts"]>;
  },
): Promise<
  | { kind: "noop" }
  | {
      kind: "attached";
      repositories: SelectedRepository[];
      cloneDurationMs: number;
    }
  | { kind: "clarification"; questions: string[] }
> {
  const rounds = ctx.clarifications ?? [];
  const latest = rounds[rounds.length - 1];
  if (!latest || ctx.workspaceManifest?.version !== 2 || !ctx.sandboxId) {
    return { kind: "noop" };
  }
  const { isExpansionLimitClarification } = await import(
    "../repository-discovery/runner.js"
  );
  if (!isExpansionLimitClarification(latest.questions)) {
    return { kind: "noop" };
  }
  const decision = await deps.resolve(
    latest.answer,
    ctx.selectedRepositories.map((repository) => ({
      provider: repository.provider,
      repoPath: repository.repoPath,
    })),
  );
  if (decision.kind === "clarification_needed") {
    return { kind: "clarification", questions: decision.questions };
  }
  if (decision.repositories.length === 0) {
    // Every named repository is already attached: nothing new to clone, so let
    // the caller run research instead of re-raising the clarification.
    return { kind: "noop" };
  }
  const attached = await deps.attach(decision.repositories);
  const repositories = [...ctx.selectedRepositories, ...decision.repositories];
  ctx.workspaceManifest = attached.manifest;
  ctx.selectedRepositories = repositories;
  ctx.repositoryContexts = await deps.fetchContexts(repositories);
  return {
    kind: "attached",
    repositories: decision.repositories,
    cloneDurationMs: attached.cloneDurationMs,
  };
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

export function triggerTypeFor(entry: AgentWorkflowInput): WorkflowBlockType {
  if (entry.kind === "pr_trigger") return entry.triggerType;
  if (entry.kind === "webhook_trigger") return "trigger_webhook";
  if (entry.kind === "plan_approved") return "trigger_plan_approved";
  return "trigger_ticket_ai";
}

export function triggerOutputFor(entry: AgentWorkflowInput): BlockOutput {
  return triggerOutputWithTicketContext(entry);
}

/**
 * Pick the node the run enters through. A definition may carry several
 * trigger_webhook nodes and each endpoint owns exactly one of them, so a
 * webhook delivery selects by its own node id: matching on type alone would
 * silently start another endpoint's graph. Every other kind has at most one
 * trigger of its type, so type matching stays correct for them.
 */
export function selectEntryTriggerNode(
  nodes: readonly WorkflowDefinitionNode[],
  entryTriggerType: WorkflowBlockType,
  entry: AgentWorkflowInput,
): WorkflowDefinitionNode | undefined {
  if (entry.kind === "webhook_trigger") {
    return nodes.find(
      (node) => node.id === entry.nodeId && node.type === entryTriggerType,
    );
  }
  return nodes.find((node) => node.type === entryTriggerType);
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
  if (entry.kind === "webhook_trigger") {
    // Explicit branch: the ticket fallback below publishes a ticketKey a
    // webhook run never has, and the endpoint's mapped fields are the contract.
    return {
      status: "fired",
      subject: entry.entry.subject,
      description: entry.entry.description,
      requester: entry.entry.requester,
      priority: entry.entry.priority,
      payload: entry.entry.payload,
    };
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
  const { createAdapters } = await import("../lib/adapters.js");
  const { fetchAttachmentsWithRetry } = await import("../sandbox/attachments.js");
  const { issueTracker } = createAdapters();

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
    ...(runtime
      ? {
          runtime: runtime.paths,
          ...(runtime.modelSettings
            ? { modelSettings: runtime.modelSettings }
            : {}),
        }
      : {}),
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

async function parseRepositoryDiscoveryStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: PhaseKind,
  schema: string,
): Promise<{ result: AgentProtocolResult<unknown>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind);
  return {
    result: adapter.parseStructuredObjectProtocol(
      artifacts,
      phase,
      "repository-discovery",
      schema,
    ),
    usage: adapter.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

/**
 * Fresh server-owned catalog for model expansion, filtered through the run's
 * immutable composed repository policy before any model can request an attach.
 */
async function listFreshRepositoryCatalogStep(
  repositoryScope?: WorkflowRepositoryScope,
) {
  "use step";
  const { getConfiguredVcsProviders } = await import("../../env.js");
  const { createRepositoryDirectoryForProviders } = await import(
    "../adapters/vcs/repository-directory.js"
  );
  const { buildRepositoryCatalog } = await import(
    "../repository-discovery/catalog.js"
  );
  const { filterRepositoriesForScope } = await import(
    "../lib/repo-allowlist.js"
  );
  return buildRepositoryCatalog(
    filterRepositoriesForScope(
      await createRepositoryDirectoryForProviders(
        pinnedProviderConfigs(
          getConfiguredVcsProviders(),
          repositoryScope?.providers,
        ),
      ).listRepositories(),
      repositoryScope,
    ),
  );
}
listFreshRepositoryCatalogStep.maxRetries = 0;

/** Provider-config intersection used by both expansion catalogs. Empty or absent
 *  pinned providers leave the configured set untouched. */
function pinnedProviderConfigs<T extends { kind: VcsProviderKind }>(
  configured: T[],
  pinnedProviders: VcsProviderKind[] | undefined,
): T[] {
  if (!pinnedProviders || pinnedProviders.length === 0) return configured;
  return configured.filter((provider) => pinnedProviders.includes(provider.kind));
}

async function attachResearchRepositoriesStep(
  sandboxId: string,
  manifest: Extract<WorkspaceManifest, { version: 2 }>,
  repositories: SelectedRepository[],
  owner: { subjectKey: string; ownerToken: string; runId: string },
  repositoryScope?: WorkflowRepositoryScope,
): Promise<{
  manifest: Extract<WorkspaceManifest, { version: 2 }>;
  cloneDurationMs: number;
}> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { env } = await import("../../env.js");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { buildSandboxProviderConfigs } = await import("../lib/vcs-runtime.js");
  const {
    attachResearchRepositories,
    materializeResearchRepositories,
  } = await import(
    "../sandbox/research-workspace.js"
  );
  // AIW-147 minor: re-check the allowlist at the single materialization choke
  // point every attach path shares, so an allowlist tightened mid-run cuts off
  // new read attaches before any clone happens (the earlier catalog check may be
  // stale by the time this step runs).
  const { isRepoAllowedForScope } = await import("../lib/repo-allowlist.js");
  for (const repository of repositories) {
    if (!isRepoAllowedForScope(repository, repositoryScope)) {
      throw new Error(
        `Repository ${repository.provider}:${repository.repoPath} is not on the allowlist and cannot be attached`,
      );
    }
  }
  const target = await Sandbox.get({
    sandboxId,
    ...getSandboxCredentials(),
  });
  const startedAt = Date.now();
  const materializer = await Sandbox.create({
    ...getSandboxCredentials(),
    runtime: "node24",
    timeout: env.JOB_TIMEOUT_MS,
  });
  const { createAdapters } = await import("../lib/adapters.js");
  const { stopSandboxAndConfirm } = await import(
    "../sandbox/stop-ticket-sandboxes.js"
  );
  try {
    await createAdapters().runRegistry.registerSandbox(
      owner.subjectKey,
      owner.ownerToken,
      materializer.sandboxId,
      owner.runId,
    );
    const artifacts = await materializeResearchRepositories({
      sandbox: materializer,
      repositories,
      providers: await buildSandboxProviderConfigs(
        repositories.map((repository) => repository.provider),
      ),
    });
    const attached = await attachResearchRepositories({
      sandbox: target,
      manifest,
      artifacts,
    });
    return {
      manifest: attached,
      cloneDurationMs: Math.max(0, Date.now() - startedAt),
    };
  } finally {
    await stopSandboxAndConfirm(materializer);
  }
}
attachResearchRepositoriesStep.maxRetries = 0;

// AIW-147 IM-11: validate a human clarification answer against a FRESH
// server-owned catalog and the allowlist, inside a step so the Node-only
// directory/env/allowlist imports stay out of the workflow bundle and the
// decision is journaled for replay. The parsing/validation itself is pure and
// lives in repository-discovery/runner.ts.
async function resolveHumanRepositoryExpansionStep(
  answer: string,
  attached: Array<{ provider: "github" | "gitlab"; repoPath: string }>,
  repositoryScope?: WorkflowRepositoryScope,
): Promise<RepositoryExpansionDecision> {
  "use step";
  const { getConfiguredVcsProviders } = await import("../../env.js");
  const { createRepositoryDirectoryForProviders } = await import(
    "../adapters/vcs/repository-directory.js"
  );
  const { buildRepositoryCatalog } = await import(
    "../repository-discovery/catalog.js"
  );
  const { filterRepositoriesForScope } = await import(
    "../lib/repo-allowlist.js"
  );
  const { validateHumanRepositoryExpansion } = await import(
    "../repository-discovery/runner.js"
  );
  const catalog = buildRepositoryCatalog(
    filterRepositoriesForScope(
      await createRepositoryDirectoryForProviders(
        pinnedProviderConfigs(
          getConfiguredVcsProviders(),
          repositoryScope?.providers,
        ),
      ).listRepositories(),
      repositoryScope,
    ),
  );
  return validateHumanRepositoryExpansion({
    answer,
    catalog,
    attached,
  });
}
resolveHumanRepositoryExpansionStep.maxRetries = 0;

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
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker } = createAdapters();
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
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker } = createAdapters();
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
  const { createAdapters } = await import("../lib/adapters.js");
  const { messaging } = createAdapters();
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
 * Persist the concrete reason a run failed so the trace screen can state it.
 * Without this the only durable reason a failed run ever carried was written by
 * a later cancellation (the reconciler retiring the orphan after the failure
 * moved its ticket out of the AI column), which reads as bookkeeping and hides
 * the real cause. Best-effort: reporting must never change the failure outcome.
 */
async function recordRunFailureReasonStep(
  runId: string,
  reason: string,
): Promise<void> {
  "use step";
  const [{ getDb }, { recordRunStatusReason }, { logger }] = await Promise.all([
    import("../db/client.js"),
    import("../lib/telemetry/run-telemetry.js"),
    import("../lib/logger.js"),
  ]);
  try {
    await recordRunStatusReason(getDb(), runId, reason.slice(0, 2_000), {
      kind: "failure",
    });
  } catch (error) {
    logger.warn(
      { runId, err: error instanceof Error ? error.message : String(error) },
      "run_failure_reason_unconfirmed",
    );
  }
}
recordRunFailureReasonStep.maxRetries = 0;

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

/**
 * How a PR check still open when the run ends is settled. Reaching this point
 * means no verdict was ever produced: the sandbox died, an external service
 * failed, the clock ran out, or the graph simply never completed the check.
 * Settling it as "failure" would tell the developer their code was rejected by
 * a review that never ran, so both outcomes stay non-verdict. A real verdict
 * never arrives here, complete_pr_check has already closed that check.
 */
export function pendingPrCheckIntent(input: {
  category?: ExecutionErrorCategory;
  budgetMetric?: RunBudgetFailure["metric"];
}): "timed_out" | "cancelled" {
  return input.budgetMetric === "duration" || input.category === "timeout"
    ? "timed_out"
    : "cancelled";
}

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
  const { createAdapters } = await import("../lib/adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { updateTicketLabelsForRun } = await import(
    "../lib/ticket-label-mutation.js"
  );
  const db = getDb();
  const { issueTracker } = createAdapters();
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
  const { createAdapters } = await import("../lib/adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { updateTicketLabelsForRun } = await import(
    "../lib/ticket-label-mutation.js"
  );
  const { reconcileClarificationPickupState } = await import(
    "../clarifications/store.js"
  );
  const { issueTracker } = createAdapters();
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
  const { createAdapters } = await import("../lib/adapters.js");
  const { env } = await import("../../env.js");
  const { issueTracker } = createAdapters();
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
  const { createAdapters } = await import("../lib/adapters.js");
  const { env } = await import("../../env.js");
  const { formatClarificationQuestionsComment } = await import(
    "../clarifications/comment-format.js"
  );
  const { issueTracker } = createAdapters();
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
  const { createAdapters } = await import("../lib/adapters.js");
  const { runRegistry } = createAdapters();
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
  // readClock is a workflow step. Invoking it as a property of `input`
  // captures `input` as the call receiver, and the Workflow SDK then tries to
  // serialize that receiver, which carries the non-serializable budget
  // observer function. Destructure first so every call is a free-function
  // call with serializable arguments only.
  const { observeWorkflowBudget, readClock, priceLookup } = input;
  const limits = combineHarnessRuntimeLimits(
    input.workflowLimits,
    input.runtime,
  );
  let state = createRunBudgetState();
  let lastClockMs = await readClock();
  return {
    limits,
    async observeBudget(requireRemainingDuration = true) {
      const workflow = await observeWorkflowBudget(requireRemainingDuration);
      const now = await readClock();
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
      state = recordBudgetUsage(state, usage, priceLookup?.(model) ?? null);
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
  prs: RunPullRequest[] | null;
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
    // Durable "why" for a failed run: the user-facing execution error when one
    // was captured, else a short derivation from the structured budget stop.
    statusReason:
      payload.status === "failed"
        ? payload.executionError?.message ??
          (payload.budgetFailure
            ? `Run stopped on budget: ${payload.budgetFailure.reason}`
            : null)
        : null,
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
    prs: payload.prs,
    harnessManifests: payload.harnessManifests,
  });
}
recordRunTelemetryStep.maxRetries = 0;

async function closeTerminalPrChecksStep(payload: {
  runId: string;
  intent: "timed_out" | "cancelled";
  details: string;
}): Promise<{ closed: number; pending: number }> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { closeRunPrChecks } = await import("./pr-external-resources.js");
  return closeRunPrChecks({ db: getDb(), ...payload });
}
closeTerminalPrChecksStep.maxRetries = 0;

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
      acknowledgeManualDispatchStep,
      acknowledgePendingTriggerStep,
      acknowledgePrTriggerDispatchStep,
      acknowledgeWebhookDispatchStep,
      bindWorkflowCandidateStep,
    } = await import("./run-ownership-steps.js");
    const bound = await bindWorkflowCandidateStep(
      entry.subjectKey,
      entry.ownerToken,
      workflowRunId,
      entry.ticketKey ?? null,
      runKindForAgentWorkflowInput(entry),
    );
    if (!bound) return;
    await acknowledgeManualDispatchStep(entry, workflowRunId);
    await acknowledgeApprovalDispatchStep(entry, workflowRunId);
    if (!(await acknowledgePrTriggerDispatchStep(entry, workflowRunId))) return;
    if (!(await acknowledgeWebhookDispatchStep(entry, workflowRunId))) return;
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
  let prsForTelemetry: RunPullRequest[] | null = null;
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
    const entryTrigger = selectEntryTriggerNode(plan.nodes, entryTriggerType, entry);
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
    // The distill's model is priced but not required. Nothing above resolves it:
    // it is neither a definition node nor a harness runtime, so without this its
    // usage would land with an unknown cost and mark the whole run unknown.
    priceLookup = await resolveRunPriceLookup({
      requiredModels: pricedModels,
      optionalModels: optionalPricedModelsForRun({
        enableRepoMemory: env.ENABLE_REPO_MEMORY,
        runDefaultKind,
        defaults: modelDefaults,
      }),
      maxCostUsd: budgetLimits.maxCostUsd,
      fetchPrice: (model) => fetchModelPriceStep(model),
    });

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
      reviewSourceFingerprints: new Map<string, string>(),
      selectedRepositories: [],
      repositoryContexts: [],
      repositoryDiscovery: null,
      ...(plan.repositoryScope ? { repositoryScope: plan.repositoryScope } : {}),
      repositoryExpansion: { rounds: 0, priorRequests: [] },
      researchWriteRepositories: [],
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
      // The review agent works from a disposable checkout that carries only the
      // head commit, so it cannot derive the pull request diff itself. Hand the
      // change set over through the review prompt channel before any block runs.
      // The review channel has exactly one reader, so a definition without a
      // review block must not pay for the provider fetch or journal its result.
      const changeSetTarget = plan.nodes.some((node) => node.type === "review_agent")
        ? pullRequestChangeSetTarget(entry)
        : null;
      if (changeSetTarget) {
        ctx.preSandboxAdditions.review.push(
          await assembleReviewChangeSetAddition(changeSetTarget),
        );
      }

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
          markRunAwaitingStep,
          markRunResumedStep,
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
          // The body suspends on the hook below, so the run's own status writer
          // never runs while it is parked and the cron keeps snapshotting it as
          // "running". Record the park itself, before any of the ticket-side
          // notifications a human can act on. Best-effort like the other two
          // park writes: dashboard bookkeeping must never sink a real park (the
          // cron sweep settles a marker that never landed).
          await markRunAwaitingStep(workflowRunId).catch(() => undefined);
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
          // First thing after the park, ahead of the expiry branch: that branch
          // throws, and the failure path's markRunFailedOnSelfMove is a no-op on
          // an "awaiting" row, so the run must be back to "running" before any
          // later exit can record its real outcome. Best-effort: the answer is
          // already consumed at this point, so a status write must never be what
          // fails the resumed run.
          await markRunResumedStep(workflowRunId).catch(() => undefined);
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
            ctx.reviewSourceFingerprints?.clear();
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
              ctx.repositoryContexts = await blockFetchPrContextsStep(
                ctx.selectedRepositories,
                ctx.repositoryScope,
              );
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
          // A park that ends in a throw must not leave the row awaiting either.
          // Guarded on "awaiting", so this is a no-op for a failure raised
          // before the park and for a run a cancellation already flipped.
          await markRunResumedStep(workflowRunId).catch(() => undefined);
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
        // Record why before the backlog move: the move fires the webhook that
        // cancels this run, and that cancellation writes its own generic reason.
        await recordRunFailureReasonStep(workflowRunId, reason);
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
        await recordRunFailureReasonStep(
          workflowRunId,
          postComment ?? `Terminated by workflow: ${params.terminalStatus}`,
        );
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
        // The gate stays valid: this only writes an excluded, untracked file at
        // the agent's cwd, so neither HEAD nor the tracked tree the gate covers
        // can change.
        materializedClarificationSignatures.set(ctx.sandboxId, signature);
      };
      let repositorySelectionObserved = false;
      const discoverRepositories = async (
        discovery: NonNullable<EngineCtx["repositoryDiscovery"]>,
        execution?: BlockExecutionContext,
      ): Promise<
        | BlockExecutionResult
        | SelectedRepository[]
        | { repositories: SelectedRepository[]; sandboxId: string }
      > => {
        const phase = "repository-discovery";
        const label = "Repository discovery";
        const provisioned = await ensurePlanningAgentSandboxForBlock(
          ctx,
          ctx.runDefaultKind,
          defaultModel,
        );
        if (provisioned.kind === "execution_error") return provisioned;
        const sandboxId = provisioned.sandboxId;
        await writeAttachmentsOnce(sandboxId);
        const prepared = await prepareHarnessAgentInvocationStep(
          sandboxId,
          ctx.runDefaultKind,
          defaultModel,
          ctx.arthur.taskId,
        );
        if (!prepared.ok) return agentProtocolBlockError(prepared);
        const guard = await setCommitGuardStep(
          sandboxId,
          ctx.runDefaultKind,
          false,
        );
        if (!guard.ok) return agentProtocolBlockError(guard);

        const {
          REPOSITORY_DISCOVERY_SCHEMA,
          assembleRepositoryDiscoveryPrompt,
        } = await import("../repository-discovery/runner.js");
        const { paths, script } = await planPhaseStep(
          ctx.runDefaultKind,
          phase,
          defaultModel,
          REPOSITORY_DISCOVERY_SCHEMA,
        );
        const prompt = assembleRepositoryDiscoveryPrompt({
          ticket: ctx.ticket,
          discovery,
        });
        const launched = await writeAndStartPhase(
          sandboxId,
          ctx.runDefaultKind,
          phase,
          paths.input,
          prompt,
          paths.wrapper,
          script,
        );
        if (!launched.ok) return agentProtocolBlockError(launched.failure);
        ctx.markLaunched(label, execution?.attempt);
        const done = await pollPhaseUntilDone(
          sandboxId,
          paths.sentinel,
          5,
          launched.commandId,
          blockBudgetObserver(ctx, execution),
          execution?.cancellation,
        );
        if (!done) {
          return executionError("repository discovery timed out", {
            category: "timeout",
            phase,
          });
        }
        const artifacts = await collectPhase(sandboxId, paths);
        const parsed = await parseRepositoryDiscoveryStep(
          ctx.runDefaultKind,
          artifacts,
          phase,
          REPOSITORY_DISCOVERY_SCHEMA,
        );
        ctx.recordUsage(
          label,
          parsed.usage,
          defaultModel,
          execution?.attempt,
        );
        if (!parsed.result.ok) return agentProtocolBlockError(parsed.result);

        const { validateRepositoryDiscoveryResult } = await import(
          "../repository-discovery/protocol.js"
        );
        const decision = validateRepositoryDiscoveryResult(
          parsed.result.value,
          discovery.catalog,
          discovery.mandatoryRepositories,
        );
        if (decision.kind === "selected") {
          await emitRepositoryWorkflowObservation(execution?.observations, {
            event: "selection",
            source: "harness",
            catalogSize: discovery.catalog.length,
            selectedCount: decision.repositories.length,
            confidence: decision.confidence,
          });
          repositorySelectionObserved = true;
          return {
            repositories: decision.repositories,
            sandboxId,
          };
        }
        if (decision.kind === "clarification_needed") {
          return planningClarificationResult(decision.questions);
        }
        return executionError(decision.error, {
          category: "provider",
          phase,
        });
      };
      const expandResearchWorkspace = async (
        requests: NonNullable<ResearchResult["repositories"]>,
        execution?: BlockExecutionContext,
      ): Promise<BlockExecutionResult | null> => {
        // Defense-in-depth: a plan_approved run resumes a frozen approved scope,
        // so repository expansion must never widen it regardless of what the model
        // requests.
        if (ctx.entry.kind === "plan_approved") {
          return executionError(
            "repository expansion is not allowed: the repository scope is fixed by the approved plan",
            { category: "engine", phase: "research" },
          );
        }
        if (!ctx.sandboxId || ctx.workspaceManifest?.version !== 2) {
          return executionError(
            "repository expansion requires a trusted V2 research workspace",
            { category: "sandbox", phase: "research" },
          );
        }
        const { validateRepositoryExpansionRequests } = await import(
          "../repository-discovery/runner.js"
        );
        const decision = validateRepositoryExpansionRequests({
          requests,
          catalog: await listFreshRepositoryCatalogStep(ctx.repositoryScope),
          attached: ctx.selectedRepositories,
          completedRounds: ctx.repositoryExpansion.rounds,
        });
        if (decision.kind === "clarification_needed") {
          return planningClarificationResult(decision.questions);
        }
        const attached = await attachResearchRepositoriesStep(
          ctx.sandboxId,
          ctx.workspaceManifest,
          decision.repositories,
          {
            subjectKey: ctx.entry.subjectKey,
            ownerToken: ctx.entry.ownerToken,
            runId: workflowRunId,
          },
          ctx.repositoryScope,
        );
        const repositories = [
          ...ctx.selectedRepositories,
          ...decision.repositories,
        ];
        const { blockFetchPrContextsStep } = await import(
          "./blocks/fetch-pr-context.js"
        );
        ctx.workspaceManifest = attached.manifest;
        ctx.selectedRepositories = repositories;
        ctx.repositoryContexts = await blockFetchPrContextsStep(
          repositories,
          ctx.repositoryScope,
        );
        ctx.repositoryExpansion = {
          rounds: ctx.repositoryExpansion.rounds + 1,
          priorRequests: [
            ...ctx.repositoryExpansion.priorRequests,
            ...requests,
          ],
        };
        await emitRepositoryWorkflowObservation(execution?.observations, {
          event: "expansion",
          round: ctx.repositoryExpansion.rounds,
          attachedCount: decision.repositories.length,
          totalCount: repositories.length,
          cloneDurationMs: attached.cloneDurationMs,
        });
        return null;
      };
      const hydrateDiscoveredWorkspace = async (
        sandboxId: string,
        repositories: WorkspaceRepositoryInput[],
      ): Promise<Extract<WorkspaceManifest, { version: 2 }>> => {
        const attached = await attachResearchRepositoriesStep(
          sandboxId,
          { version: 2, repositories: [] },
          repositories,
          {
            subjectKey: ctx.entry.subjectKey,
            ownerToken: ctx.entry.ownerToken,
            runId: workflowRunId,
          },
          ctx.repositoryScope,
        );
        return attached.manifest;
      };
      const ensureCodeWorkspace = async (
        execution?: BlockExecutionContext,
        options: { requireWrite?: boolean } = {},
      ): Promise<
        | { kind: "ready"; sandboxId: string }
        | { kind: "exit"; result: BlockExecutionResult }
      > => {
        const result = await ensureWorkspace(ctx, execution, {
          discoverRepositories: (discovery) =>
            discoverRepositories(discovery, execution),
          hydrateDiscoveredWorkspace,
        });
        if (result.kind !== "next") {
          if (
            ctx.entry.kind === "plan_approved" &&
            result.kind === "execution_error"
          ) {
            await emitRepositoryWorkflowObservation(execution?.observations, {
              event: "approval_stale",
              reason: "scope_validation_failed",
            });
          }
          return { kind: "exit", result };
        }
        if (!ctx.sandboxId) return { kind: "exit", result: noWorkspace("prepare_workspace") };
        if (!repositorySelectionObserved) {
          const narrowing = ctx.repositoryScopeNarrowing;
          await emitRepositoryWorkflowObservation(execution?.observations, {
            event: "selection",
            source:
              ctx.entry.kind === "plan_approved"
                ? "approved"
                : ctx.entry.kind === "pr_trigger"
                  ? "pr_trigger"
                  : (ctx.repositoryScope?.repositories?.length ?? 0) > 0
                    ? "definition_pin"
                    : "metadata",
            catalogSize:
              narrowing?.catalogSize ??
              ctx.repositoryDiscovery?.catalog.length ??
              ctx.selectedRepositories.length,
            selectedCount: ctx.selectedRepositories.length,
            ...(narrowing ? { scopedCatalogSize: narrowing.scopedCatalogSize } : {}),
          });
          repositorySelectionObserved = true;
        }
        if (
          ctx.entry.kind === "plan_approved" &&
          ctx.workspaceManifest?.version === 2
        ) {
          const approvedManifest = ctx.workspaceManifest;
          const writeRepositories =
            ctx.entry.approvedPlan.repositoryScope?.repositories
              .filter((repository) => repository.access === "write")
              .map((repository) => ({
                provider: repository.provider,
                repoPath: repository.repoPath,
                rationale: repository.rationale,
              })) ??
            ctx.selectedRepositories.map((repository) => ({
              provider: repository.provider,
              repoPath: repository.repoPath,
              rationale: repository.selectedRationale,
            }));
          const alreadyPromoted = writeRepositories.every((requested) =>
            approvedManifest.repositories.some(
              (repository) =>
                repository.access === "write" &&
                repository.provider === requested.provider &&
                repository.repoPath.toLowerCase() === requested.repoPath.toLowerCase(),
            ),
          );
          if (!alreadyPromoted) {
            const promotion = await promoteWorkspaceWrites(
              ctx,
              writeRepositories,
              execution,
            );
            if (promotion) return { kind: "exit", result: promotion };
          }
          ctx.researchWriteRepositories = writeRepositories;
        }
        // A code-writing block (implementation_agent) on a ticket graph without a
        // planning node never reaches the post-research promotion above, so promote
        // its all-read workspace here. Read-only callers (planning_agent, review_agent)
        // pass no requireWrite flag and keep research untouched.
        if (options.requireWrite) {
          const promotion = await maybePromoteTicketWorkspaceWrites(ctx, execution);
          if (promotion) return { kind: "exit", result: promotion };
          // Planning graph whose research declared no write set: the workspace is
          // still all-read and there is nothing to implement. Fail loud and early
          // instead of committing on a read-only checkout and dying at publication.
          const noWritesGuard = researchDeclaredNoWritesGuard(ctx);
          if (noWritesGuard) return { kind: "exit", result: noWritesGuard };
        }
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
          ctx.reviewSourceFingerprints?.clear();
        }
        // A workspace-enabled generic_agent reuses whatever prepare_workspace
        // attached without routing through a write-ensuring path, so promote its
        // workspace here. The guard no-ops for every other block type, pr_trigger,
        // planning graphs, already-write manifests, and workspace-free generics.
        const genericPromotion = await maybePromoteGenericAgentWorkspace(
          ctx,
          node,
          execution,
        );
        if (genericPromotion) return genericPromotion;
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
          prsForTelemetry ??= publicationPrsForTelemetry(ctx.publication);
          return result;
        }

        switch (node.type) {
          case "prepare_workspace": {
            const result = await ensureWorkspace(ctx, execution, {
              discoverRepositories: (discovery) =>
                discoverRepositories(discovery, execution),
              hydrateDiscoveredWorkspace,
            });
            if (result.kind === "next" && ctx.sandboxId) {
              activeModel ??= defaultModel;
              await writeAttachmentsOnce(ctx.sandboxId);
              await materializeHumanDecisions();
            }
            return result;
          }

          case "planning_agent": {
            for (;;) {
            // AIW-147 IM-11: a human answer to the expansion-limit clarification
            // attaches the repositories it named beyond the model round limit
            // BEFORE research runs again, so the answer is actionable instead of
            // ping-ponging the same limit. Running before research also keeps the
            // research phase key fresh (this attach never counts a model round),
            // so the re-run reflects the newly attached repositories.
            const humanExpansion = await applyHumanRepositoryExpansion(ctx, {
              resolve: (answer, attached) =>
                resolveHumanRepositoryExpansionStep(
                  answer,
                  attached,
                  ctx.repositoryScope,
                ),
              attach: (repositories) => {
                if (!ctx.sandboxId || ctx.workspaceManifest?.version !== 2) {
                  throw new Error(
                    "human repository expansion requires a trusted V2 workspace",
                  );
                }
                return attachResearchRepositoriesStep(
                  ctx.sandboxId,
                  ctx.workspaceManifest,
                  repositories,
                  {
                    subjectKey: ctx.entry.subjectKey,
                    ownerToken: ctx.entry.ownerToken,
                    runId: workflowRunId,
                  },
                  ctx.repositoryScope,
                );
              },
              fetchContexts: async (repositories) => {
                const { blockFetchPrContextsStep } = await import(
                  "./blocks/fetch-pr-context.js"
                );
                return blockFetchPrContextsStep(repositories, ctx.repositoryScope);
              },
            });
            if (humanExpansion.kind === "clarification") {
              return planningClarificationResult(humanExpansion.questions);
            }
            if (humanExpansion.kind === "attached") {
              await emitRepositoryWorkflowObservation(execution?.observations, {
                event: "expansion",
                round: ctx.repositoryExpansion.rounds,
                attachedCount: humanExpansion.repositories.length,
                totalCount: ctx.selectedRepositories.length,
                cloneDurationMs: humanExpansion.cloneDurationMs,
              });
              continue;
            }
            const expansionRound = ctx.repositoryExpansion.rounds;
            const researchLabel =
              ctx.schemaVersion === 2
                ? `Research ${node.id}${expansionRound > 0 ? ` expansion ${expansionRound}` : ""}`
                : `Research${expansionRound > 0 ? ` expansion ${expansionRound}` : ""}`;
            const baseResearchArtifactPhase = agentArtifactPhase("research", execution);
            const researchArtifactPhase =
              expansionRound > 0
                ? `${baseResearchArtifactPhase}-expansion-${expansionRound}`
                : baseResearchArtifactPhase;
            const researchPhase = phaseKey(researchLabel, invocationAttempt);
            const { kind, model, runtime } = resolveAgentForNode(node);
            const workspace = await ensureCodeWorkspace(execution);
            if (workspace.kind === "exit") return workspace.result;
            const sandboxId = workspace.sandboxId;
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
                ctx.repositoryContexts = await blockFetchPrContextsStep(
                  ownedRepos,
                  ctx.repositoryScope,
                );
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
              preSandboxAdditions:
                ctx.repositoryExpansion.priorRequests.length > 0
                  ? [
                      ...ctx.preSandboxAdditions.research,
                      {
                        target: ["research" as const],
                        title: "Repository expansion history",
                        content: [
                          "The following repositories were requested and are now attached.",
                          "Continue the same research; do not restart from assumptions.",
                          JSON.stringify(ctx.repositoryExpansion.priorRequests),
                        ].join("\n"),
                      },
                    ]
                  : ctx.preSandboxAdditions.research,
              repositoryContexts: ctx.repositoryContexts,
              workspaceManifest: ctx.workspaceManifest ?? undefined,
            };
            const resolvedResearchInput = await resolveAgentInput({
              compileEffectivePrompt: execution?.compileEffectivePrompt,
              blockPrompt: promptOverride(node) ?? "",
              runtimeData: assembleResearchPlanContext({
                ...researchContext,
                prompt: "",
              }),
              sandboxId,
              fallbackInput: assembleResearchPlanContext({
                ...researchContext,
                prompt: promptOverride(node) ?? prompts.research,
              }),
            });
            if (!resolvedResearchInput.ok) return resolvedResearchInput.result;
            const researchInput = resolvedResearchInput.input;

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

            if (research.status === "repositories_needed") {
              const expansion = await expandResearchWorkspace(
                research.repositories ?? [],
                execution,
              );
              if (expansion) return expansion;
              continue;
            }

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
                category: "unknown",
                phase: "research",
              });
            }

            ctx.researchWriteRepositories = research.writeRepositories ?? [];
            if (
              shouldPromoteResearchWriteScope({
                definitionNodes: ctx.definitionNodes,
                writeRepositories: ctx.researchWriteRepositories,
                manifestVersion: ctx.workspaceManifest?.version,
              })
            ) {
              const promotion = await promoteWorkspaceWrites(
                ctx,
                ctx.researchWriteRepositories,
                execution,
              );
              if (promotion) return promotion;
            }
            ctx.researchPlanMarkdown = research.body;
            return { kind: "next", output: { status: "ready", plan: research.body } };
            }
          }

          case "implementation_agent": {
            const workspace = await ensureCodeWorkspace(execution, {
              requireWrite: true,
            });
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
              workspaceManifest: ctx.workspaceManifest ?? undefined,
            };
            const resolvedImplementationInput = await resolveAgentInput({
              compileEffectivePrompt: execution?.compileEffectivePrompt,
              blockPrompt: promptOverride(node) ?? "",
              runtimeData: assembleImplementationContext({
                ...implementationContext,
                prompt: "",
              }),
              sandboxId,
              fallbackInput: assembleImplementationContext({
                ...implementationContext,
                prompt: promptOverride(node) ?? prompts.implement,
              }),
            });
            if (!resolvedImplementationInput.ok) {
              return resolvedImplementationInput.result;
            }
            const implInput = resolvedImplementationInput.input;

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
                category: implDone ? "unknown" : "timeout",
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
              // The session memory document lives outside the repository now, so
              // the bundles this review workspace is built from cannot carry it.
              memoryTaskId: ctx.ticket.identifier,
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
              if (ctx.schemaVersion === 2) {
                const activationScopeId =
                  execution?.activationScopeId ?? "root";
                const reviewSourceFingerprints =
                  (ctx.reviewSourceFingerprints ??= new Map<string, string>());
                const expectedFingerprint =
                  reviewSourceFingerprints.get(activationScopeId);
                if (
                  expectedFingerprint !== undefined &&
                  expectedFingerprint !== provisioned.sourceFingerprint
                ) {
                  return executionError(
                    "parallel reviews did not receive the same workspace snapshot",
                    {
                      category: "sandbox",
                      phase: "review",
                      message:
                        "Parallel reviews could not use one identical workspace snapshot.",
                    },
                  );
                }
                reviewSourceFingerprints.set(
                  activationScopeId,
                  provisioned.sourceFingerprint,
                );
              }
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
                workspaceManifest: ctx.workspaceManifest ?? undefined,
              };
              const resolvedReviewInput = await resolveAgentInput({
                compileEffectivePrompt: execution?.compileEffectivePrompt,
                blockPrompt: promptOverride(node) ?? "",
                runtimeData: assembleReviewContext({
                  ...reviewContext,
                  prompt: "",
                }),
                sandboxId,
                fallbackInput: assembleReviewContext({
                  ...reviewContext,
                  prompt: promptOverride(node) ?? prompts.review,
                }),
              });
              if (!resolvedReviewInput.ok) return resolvedReviewInput.result;
              const reviewInput = resolvedReviewInput.input;

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

              return reviewAgentExecutionResult(ctx.schemaVersion, reviewOutput);
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
              repositoryScope: ctx.repositoryScope,
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
            await emitRepositoryWorkflowObservation(execution?.observations, {
              event: "publication",
              prCount: publication.prs.length,
            });

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
            prsForTelemetry = publicationPrsForTelemetry(publication);
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
            const publishedPrs = publicationPrsForTelemetry(publication);
            if (publication?.status === "published" && publishedPrs) {
              const usageReport = formatUsageReport(phaseUsages, priceLookup, activeModel, phaseModels);
              await notifyTicket(ticket.identifier, {
                kind: "pr_ready",
                prs: publishedPrs,
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
        trigger: {
          id: entryTrigger.id,
          type: entryTrigger.type,
        },
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
          // Every repository in the manifest, not only the write-scoped ones:
          // how to build and test a read-only dependency is worth knowing too.
          // Reads the database only, so planning_agent gets it without a
          // checkout. Gated here at the call site rather than inside the step:
          // a "use step" invocation writes a durable step record even when its
          // body returns immediately, and with the flag off the compiled prompt
          // must be identical to a build without the feature.
          let memorySources: Awaited<
            ReturnType<typeof loadRepoMemorySourcesStep>
          > = [];
          if (env.ENABLE_REPO_MEMORY && ctx.workspaceManifest) {
            try {
              memorySources = await loadRepoMemorySourcesStep({
                repositories: ctx.workspaceManifest.repositories.map(
                  (repository) => ({
                    provider: repository.provider,
                    repoPath: repository.repoPath,
                  }),
                ),
              });
            } catch (error) {
              if (isRunControlError(error)) throw error;
              // Unlike repository instructions, unreadable memory must not fail
              // the invocation: it is an optimization the prompt is correct
              // without.
              memorySources = [];
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
            memorySources,
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
          try {
            return {
              kind: "next",
              output: {
                status: "ok",
                output: await executeTransform(
                  configuration as unknown as TransformConfiguration,
                  bindingContext,
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
        const legacyNode = {
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
        } as unknown as WorkflowDefinitionNode;
        const result = await executeBlock(
          legacyNode,
          structuredClone(steps) as StepsRecord,
          structuredClone(resolvedInputs),
          {
            attempt: invocation.attempt,
            activationScopeId: invocation.activationScopeId,
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
              // V1 forwards this from the interpreter's recordExecutionError.
              // Without it here, a V2 failure logs correlation metadata only and
              // the cause exists nowhere but the capped customer-facing message.
              ...(error.detail ? { detail: error.detail } : {}),
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
            // The env value is an operational ceiling only, never a raise: see
            // V2_MAX_BLOCK_CONCURRENCY in env.ts for why production runs
            // serialized while AIW-233 is open.
            maxConcurrency: Math.min(
              env.V2_MAX_BLOCK_CONCURRENCY ??
                V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency,
              V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency,
            ),
            maxTotalExecutions:
              V2_PRODUCTION_SCHEDULER_BOUNDS.maxTotalExecutions,
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
      // "completed" is the only genuine success: the walk ran out of work.
      // "ended" is a clean park, not a finish: send_plan_approval (the only
      // block that returns it) stopped the run while a human decides on the
      // plan, and nothing downstream of the gate ran. That is the same state a
      // clarification park records, so it records the same status and the
      // approval decision endpoints flip it off "awaiting" later. Calling it a
      // success here made a parked run read as shipped in every run listing.
      // No ticket move on either branch; the block owns that.
      // Constraint: never promote a clarification park to success here. The
      // terminate/clarification paths set runOutcome = "awaiting" and own it
      // (the answer endpoint flips it later), so a completed walk that left
      // "awaiting" set must keep it. The `as string` read is needed because TS
      // can't see the hook closures writing runOutcome and narrows it to its
      // "failed" initializer.
      if (
        !terminalExecutionError &&
        (walk.outcome === "completed" || walk.outcome === "ended") &&
        (runOutcome as string) !== "awaiting"
      ) {
        currentBlockId = null;
        runOutcome = walk.outcome === "ended" ? "awaiting" : "success";
      }
    } finally {
      // Capture the memory document before the sandbox that holds it is gone.
      // Failed and canceled runs learn things too, so this is not gated on the
      // outcome; nothing here may prevent the teardown below. Only the latest
      // workspace is captured: a prepare_workspace loop discards the memory of
      // its earlier iterations, which is the same thing that happens today.
      try {
        if (ctx.sandboxId && ctx.workspaceManifest) {
          await persistWorkspaceMemoryStep({
            sandboxId: ctx.sandboxId,
            subjectKey: ctx.entry.subjectKey,
            ticketKey: ctx.entry.ticketKey ?? null,
            taskId: ctx.ticket.identifier,
            workspaceManifest: ctx.workspaceManifest,
            runId: ctx.runId,
          });
        }
      } catch {
        // Best effort: the step already logs, teardown must still run.
      }
      // Tear down EVERY sandbox the run created, not just the latest
      // ctx.sandboxId: a prepare_workspace inside a loop provisions a fresh
      // sandbox each iteration, and all but the last would otherwise leak.
      await teardownSandboxes(ctx.sandboxIds);
      // Distill durable per-repository knowledge out of a run that actually
      // shipped. After the teardown so a slow provider call cannot keep paid
      // sandboxes alive, and gated on publication because an unpublished run
      // proves nothing about how to work in the repository. Everything is
      // swallowed: the run has already succeeded.
      try {
        const manifest = ctx.workspaceManifest;
        // Gated here at the call site rather than inside the step: a "use step"
        // invocation writes a durable step record even when its body returns
        // immediately, and the budget read below is itself a step.
        if (
          env.ENABLE_REPO_MEMORY &&
          manifest &&
          runOutcome === "success" &&
          (ctx.publication?.status === "published" ||
            ctx.publication?.status === "finalized")
        ) {
          // Observed, never enforced: the run succeeded, so an exhausted budget
          // skips the distill instead of failing it.
          const budget = await ctx.observeBudget();
          if (budget.check.status === "ok") {
            const { provider, model } = repoMemoryDistillTarget(
              ctx.runDefaultKind,
              ctx.defaults,
            );
            const startedAt = Date.now();
            const distilled = await distillRepoMemoryStep({
              runId: ctx.runId,
              subjectKey: ctx.entry.subjectKey,
              taskId: ctx.ticket.identifier,
              repositories: manifest.repositories
                .filter(
                  (repo) => workspaceRepositoryAccess(manifest, repo) === "write",
                )
                .map((repo) => {
                  // Listed from the clone in prepare_workspace, before any agent
                  // block ran. The sandbox is already torn down above, and even
                  // if it were not, the workspace at this point is the branch
                  // this run pushed: the files it created exist there, so reading
                  // it would confirm exactly the entries the listing rejects.
                  const defaultBranchFiles =
                    ctx.defaultBranchFiles?.[`${repo.provider}:${repo.repoPath}`];
                  return {
                    provider: repo.provider,
                    repoPath: repo.repoPath,
                    // Omitted rather than sent empty: absent means the capture
                    // had no trusted listing, which leaves the filter off.
                    ...(defaultBranchFiles && defaultBranchFiles.length > 0
                      ? { defaultBranchFiles }
                      : {}),
                  };
                }),
              changeSummary: ctx.changeSummary,
              model,
              ...(provider !== undefined ? { provider } : {}),
              // An ok budget only proves some duration is left, not 90s of it,
              // and this call delays the run's terminal telemetry until it
              // returns.
              timeoutMs: Math.max(
                1,
                Math.min(90_000, Math.floor(budget.remainingDurationMs)),
              ),
            });
            // Only a step that reached the provider costs anything. The step
            // says so directly rather than having the skip reasons enumerated
            // here, where every reason added later would silently drop the cost;
            // recording null for a call that never happened would mark the whole
            // run's cost unknown.
            const billable = distilled.providerCalled;
            if (billable) {
              const durationMs = Date.now() - startedAt;
              recordBlockPhaseUsage(
                ctx,
                "Repo memory distill",
                distilled.usage
                  ? {
                      cost_usd: null,
                      tokens: {
                        input: distilled.usage.inputTokens,
                        cached_input: distilled.usage.cachedTokens,
                        output: distilled.usage.outputTokens,
                      },
                      duration_ms: durationMs,
                      duration_api_ms: durationMs,
                      num_turns: 1,
                    }
                  : null,
                model,
                // Pin the attempt so the label never inherits the last block's
                // retry count and reads "Repo memory distill #3".
                { attempt: 1 },
              );
            }
          }
        }
      } catch {
        // Best effort: the step already logs, and memory must never turn a
        // successful run into a failed one.
      }
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
    if (
      entry.kind === "pr_trigger" &&
      (runOutcome as string) !== "awaiting"
    ) {
      const successfulWithPendingCheck = runOutcome === "success";
      const details = successfulWithPendingCheck
        ? "Workflow finished without completing a pending PR check."
        : terminalExecutionError
          ? formatExecutionErrorForUser(terminalExecutionError)
          : "Workflow failed before the PR check was completed.";
      const cleanup = await closeTerminalPrChecksStep({
        runId: workflowRunId,
        intent: pendingPrCheckIntent({
          category: terminalExecutionError?.category,
          budgetMetric: terminalBudgetFailure?.metric,
        }),
        details,
      }).catch(() => ({ closed: 0, pending: 1 }));
      if (
        successfulWithPendingCheck &&
        (cleanup.closed > 0 || cleanup.pending > 0)
      ) {
        runOutcome = "failed";
        const error = executionError(details, {
          category: "engine",
          phase: "pr-check-cleanup",
        }).error;
        terminalExecutionError = createWorkflowExecutionErrorState(
          workflowRunId,
          "pr-check-cleanup",
          1,
          error,
        );
      }
    }
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
      prs: prsForTelemetry,
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
