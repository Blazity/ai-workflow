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
import type {
  ReviewLedgerState,
  ReviewThread,
  ReviewThreadDisposition,
  ReviewThreadFeed,
} from "../adapters/vcs/types.js";
import type { SelectedRepositoryPromptContext } from "../sandbox/context.js";
import {
  buildCorrectionNote,
  buildGateFailureReason,
  buildReviewLedgerDurableState,
  resolveReviewGate,
  selectWorkItems,
  verifyDispositions,
  type ReviewGate,
  type ReviewLedgerGuardWorkItem,
} from "./review-ledger.js";
import { settleReviewLedgerStep, type SettledThread } from "./review-ledger-settle.js";
import {
  buildRuntimeGraph,
  createWorkflowExecutionErrorState,
  executionError,
  executeGraph,
  formatExecutionErrorForUser,
  WorkflowExecutionError,
  WORKSPACE_GATE_NOT_RECORDED_PREFIX,
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
  type ClarificationDecisionObservation,
} from "../run-observability/agent-observations.js";
import type { ClarificationDecisionDigest } from "./clarification-decision-digest.js";
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
import { publicationPrsForTelemetry } from "./publication-prs-for-telemetry.js";
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
import {
  execute as executeFinalizeWorkspace,
  recoverScriptDriftFromSteps,
} from "./blocks/finalize-workspace.js";
import { execute as executeFixAgent } from "./blocks/fix-agent.js";
import { execute as executeGenericAgent } from "./blocks/generic-agent.js";
import {
  execute as executeCallLlm,
  resolveCallLlmTarget,
} from "./blocks/call-llm.js";
import { pollPhaseUntilDone } from "./blocks/poll-phase.js";
import {
  loadPrePrCheckConfigStep,
  recoverChecksCeilingFromSteps,
  runPrePrChecksWithFixes,
} from "./blocks/pre-pr-checks.js";
import {
  boundFailureOutput,
  FAILURE_OUTPUT_MAX_CHARS,
  type PrePrCheckFailure,
  type PrePrCheckRunResult,
} from "../pre-pr-checks/runner.js";
import {
  asRepositoryScriptsOutput,
  countUncoveredGroups,
  isRepositoryScriptsRefusal,
  repositoryScriptCoverageNotes,
  REPOSITORY_SCRIPTS_ABANDONED_CLASS,
  REPOSITORY_SCRIPTS_BUDGET_CLASS,
  REPOSITORY_SCRIPTS_FAILED_CLASS,
  REPOSITORY_SCRIPTS_NOT_STARTED_CLASS,
  REPOSITORY_SCRIPTS_NOTHING_RAN_CLASS,
  type RepositoryScriptGroupStatus,
  type RepositoryScriptsOutput,
} from "./blocks/repository-scripts-output.js";
import {
  RunBudgetError,
  addActiveElapsed,
  addElapsed,
  checksElapsedOf,
  createRunBudgetState,
  durationBudgetFailure,
  isDurationAbortError,
  missingRequiredPriceFailure,
  observeRunBudget,
  recordBudgetUsage,
  runBudgetFailureFromError,
  type RunBudgetAttribution,
  type RunBudgetLimits,
  type RunBudgetFailure,
  type RunBudgetObservation,
  type RunBudgetState,
} from "./run-budget.js";
import { redactDiagnosticText } from "../sandbox/agents/redact.js";
import { isRunControlError } from "./run-control-error.js";
import { execute as executeFetchPrContext } from "./blocks/fetch-pr-context.js";
import { execute as executeInvestigate } from "./blocks/investigate.js";
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

/**
 * run_scripts: run named repository script groups in the run workspace.
 *
 * The generic successor to the publication gate, and a thin adapter over the
 * same engine: it differs from run_pre_pr_checks in exactly two ways, and both
 * are deliberate. It names the groups it wants instead of taking the gate's
 * own selection, and it records no workspace gate. Its output carries no
 * `gate` key at all, which is what keeps it out of recoverPrePrGateFromSteps
 * (blocks/finalize-workspace.ts): that walk recognizes a gate by the
 * outcome+gate pair on any step output, and this block does carry an outcome.
 *
 * Recording no gate is not the same as being unable to affect publication. A
 * group with restoreTree false leaves tracked files modified on purpose, and
 * running one after the checks gate has passed drifts the fingerprint the
 * publication boundary re-verifies, so Finalize fails with workspace_changed.
 * Mutating groups belong before the gate.
 *
 * Scripts that ran and failed are an ordinary branchable outcome, never an
 * execution error. kind "execution_error" stays reserved for scripts that could
 * not run at all, which is a different thing an operator answers differently.
 */
/**
 * The checks ceiling to hand the engine, as an options fragment.
 *
 * Absent when prepare_workspace published none, and then the engine derives one
 * from the configuration. Spread rather than passed as null so the engine's
 * "did anyone tell me" test stays a presence test.
 */
function checksCeilingOption(steps: StepsRecord): { checksCeilingMs?: number } {
  const ceilingMs = recoverChecksCeilingFromSteps(steps);
  return ceilingMs === null ? {} : { checksCeilingMs: ceilingMs };
}

export const executeRunScripts: BlockExecuteFn = async (
  block,
  steps,
  ctx,
  _resolvedInputs,
  execution,
): Promise<BlockExecutionResult> => {
  if (!ctx.sandboxId) {
    return executionError(
      "no workspace: connect prepare_workspace before run_scripts",
      { category: "sandbox" },
    );
  }
  // No invalidateWorkspaceGate call here, deliberately. Nulling ctx.prePrGate
  // would not durably invalidate anything: finalize resolves
  // `ctx.prePrGate ?? recoverPrePrGateFromSteps(steps)`, so the checkpointed
  // gate is resurrected from the gate block's own step output on the very next
  // read. The call would only imply a protection that does not exist. What
  // actually happens when a restoreTree:false group runs after a passed gate is
  // that the publication boundary re-verifies the tracked-file fingerprint and
  // fails with workspace_changed, which is loud and correct.
  const groups = Array.isArray(block.params.groups)
    ? block.params.groups.filter((group): group is string => typeof group === "string")
    : [];
  const budget = await ctx.observeBudget();
  if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
  // Loading the configuration is a step; running the scripts is not. They are
  // launched detached and polled across ticks, because a client tenant's real
  // scripts outlive the 300s one function invocation gets. See
  // workflows/blocks/pre-pr-checks.ts.
  const current = await loadPrePrCheckConfigStep();
  let run: PrePrCheckRunResult;
  try {
    run = await runPrePrChecksWithFixes({
      sandboxId: ctx.sandboxId,
      config: current.config,
      // No agent is launched from this path. Both fields are deprecated engine
      // options kept until stage 3 drops them, so they carry the run's defaults
      // rather than a repair identity this block never has.
      agentKind: ctx.runDefaultKind,
      model: ctx.defaults[ctx.runDefaultKind],
      groupSelection: { kind: "named", groups },
      observeBudget: blockBudgetObserver(ctx, execution),
      observeChecksBudget: blockBudgetObserver(ctx, execution, {
        attribution: "checks",
      }),
      ...checksCeilingOption(steps),
      cancellation: execution?.cancellation,
      // So a batch that runs for forty minutes reports progress instead of
      // reading as a hung run. Best effort inside the emitter; nothing here
      // depends on it.
      ...(execution?.observations ? { observations: execution.observations } : {}),
    });
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const after = await ctx.observeBudget();
    if (after.check.status !== "ok") throw new RunBudgetError(after.check);
    if (isDurationAbortError(err)) {
      throw new RunBudgetError(durationBudgetFailure(after, "Repository scripts"));
    }
    throw new Error(await prePrChecksFailureMessage(err, current.version));
  }
  const output = repositoryScriptsOutput(run, groups);
  return {
    kind: "next",
    output: { status: repositoryScriptsStatus(output), ...output },
  };
};

const BLOCK_EXECUTORS: Partial<Record<WorkflowBlockType, BlockExecuteFn>> = {
  finalize_workspace: executeFinalizeWorkspace,
  fix_agent: executeFixAgent,
  generic_agent: executeGenericAgent,
  call_llm: executeCallLlm,
  fetch_pr_context: executeFetchPrContext,
  investigate: executeInvestigate,
  run_checks: executeRunChecks,
  run_scripts: executeRunScripts,
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
  workspaceManifest?: WorkspaceManifest,
): BlockOutput {
  const feedback = review.feedback.trim();
  const repositoryByLocalPath = new Map(
    workspaceManifest?.repositories.map((repository) => [
      repository.localPath,
      repository.repoPath,
    ]) ?? [],
  );
  // Strict-mode providers must emit every key, so a missing line arrives as
  // null. The Review Result contract accepts positive integers only, so those
  // nulls are dropped here instead of failing validation downstream.
  const line = (value: number | null | undefined): number | undefined =>
    typeof value === "number" && value >= 1 ? value : undefined;
  const findings = review.issues.map((finding) => {
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
      ...(typeof finding.repo === "string"
        ? {
            repo:
              repositoryByLocalPath.get(finding.repo) ?? finding.repo,
          }
        : {}),
    };
  });
  const writableRepositories =
    workspaceManifest?.version === 2
      ? new Set(
          workspaceManifest.repositories
            .filter((repository) => repository.access === "write")
            .map((repository) => repository.repoPath),
        )
      : undefined;
  const blocksPublication = findings.some(
    (finding) =>
      (finding.severity === "Blocker" || finding.severity === "High") &&
      (writableRepositories === undefined ||
        finding.repo === undefined ||
        writableRepositories.has(finding.repo)),
  );
  return {
    status: "reviewed",
    findings,
    decision: blocksPublication ? "request_changes" : "approve",
    ...(feedback ? { feedback } : {}),
  };
}

export function reviewAgentExecutionResult(
  schemaVersion: 1 | 2,
  review: ReviewOutput,
  workspaceManifest?: WorkspaceManifest,
): BlockExecutionResult {
  if (schemaVersion === 1 && review.result === "failed") {
    return executionError(review.error ?? "unknown", {
      category: "unknown",
      phase: "review",
    });
  }
  return {
    kind: "next",
    output: buildReviewAgentSuccessOutput(review, workspaceManifest),
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

/**
 * Who a run-level failure belongs to, given the blocks in flight.
 *
 * One block in flight means the failure is that block's. Several means there is
 * no honest answer, so return null and let the caller report the engine rather
 * than blaming a sibling. Reading the last entry of the set would do exactly
 * that: Set iteration is insertion order, so it attributes a shared failure to
 * whichever block happened to start last in wall-clock terms, which under
 * concurrency is an accident and lands a real failure on an innocent block.
 */
export function soleActiveBlockId(
  activeBlockIds: ReadonlySet<string>,
): string | null {
  if (activeBlockIds.size !== 1) return null;
  const [onlyActive] = activeBlockIds;
  return onlyActive ?? null;
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
  if (decision.kind !== "attach" || decision.repositories.length === 0) {
    // Every named repository is already attached: nothing new to clone, so let
    // the caller run research instead of re-raising the clarification. The human
    // validator reports this as an empty attach rather than already_attached, so
    // both no-op shapes land here (an unnamed_request would be the same no-op).
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
/** Entry kinds whose no_change terminal must replay the graph's configured
 *  ticket move. The terminal skips the downstream cone, so update_ticket_status
 *  never runs, and dispatch has no post-success dedup: a ticket left in the AI
 *  column would be picked up again. Only a run dispatched from that column can
 *  be re-picked, so every follow-up is excluded. A pr_trigger run answering
 *  review threads is the case that made this explicit: it would move a ticket
 *  that is usually long since done, and write to Jira on behalf of a reviewer
 *  who asked a question about a pull request. */
export function entryNeedsTicketStatusReplay(
  entry: AgentWorkflowInput | AgentWorkflowInput["kind"],
): boolean {
  return (typeof entry === "string" ? entry : entry.kind) === "ticket";
}

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

export const SCHEDULED_RUN_CANNOT_PARK_REASON =
  "This run was started by a schedule, which runs unattended, but a block asked a person for input. Nobody can answer a scheduled run: it has no ticket to comment on and no way to be resumed, so it stops here instead of holding the schedule. Give the workflow enough context to finish on its own, or move this work to a ticket trigger.";

/**
 * A scheduled run must fail rather than park.
 *
 * The deployment gate refuses the two blocks that exist to wait for a person, but
 * parking is a RUNTIME outcome, not a property of a block type: planning,
 * implementation, fix and generic agents can all decide they need input, repo
 * discovery can, terminate and loop can. A schedule graph made only of ordinary
 * blocks therefore still reaches this, and the consequence is silent and
 * expensive. The park notifications are all gated on entry.ticketKey, which a
 * scheduled run does not have, so nothing is posted anywhere; the subject stays
 * claimed for the clarification hook's whole lifetime, which freezes the schedule
 * under skip and queue; and the parked claim holds one of the three concurrency
 * slots for that entire period.
 *
 * Failing releases the subject through the ordinary failure path, so the next
 * occurrence runs. The reason is written for the operator reading a failed run.
 */
export function assertScheduledRunMayNotPark(entry: AgentWorkflowInput): void {
  if (entry.kind !== "schedule") return;
  throw new Error(SCHEDULED_RUN_CANNOT_PARK_REASON);
}

export function triggerTypeFor(entry: AgentWorkflowInput): WorkflowBlockType {
  if (entry.kind === "pr_trigger") return entry.triggerType;
  if (entry.kind === "webhook_trigger") return "trigger_webhook";
  if (entry.kind === "schedule") return "trigger_schedule";
  if (entry.kind === "plan_approved") return "trigger_plan_approved";
  return "trigger_ticket_ai";
}

export function triggerOutputFor(entry: AgentWorkflowInput): BlockOutput {
  return triggerOutputWithTicketContext(entry);
}

/**
 * Pick the node the run enters through. A definition may carry several
 * trigger_webhook or trigger_schedule nodes and each endpoint or schedule row
 * owns exactly one of them, so those select by their own node id: matching on
 * type alone would silently start another endpoint's or schedule's graph. Every
 * other kind has at most one trigger of its type, so type matching stays correct
 * for them.
 */
export function selectEntryTriggerNode(
  nodes: readonly WorkflowDefinitionNode[],
  entryTriggerType: WorkflowBlockType,
  entry: AgentWorkflowInput,
): WorkflowDefinitionNode | undefined {
  if (entry.kind === "webhook_trigger" || entry.kind === "schedule") {
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
      ...(entry.entry.supportCase === undefined
        ? {}
        : { supportCase: entry.entry.supportCase }),
    };
  }
  if (entry.kind === "schedule") {
    // Explicit branch for the same reason as the webhook one: the ticket fallback
    // below publishes a ticketKey, and a run started by a clock has no ticket.
    // The occurrence instants are what let the task be written relative to the
    // previous run, so they are part of the trigger's contract, not diagnostics.
    return {
      status: "fired",
      scheduledFor: entry.scheduledFor,
      ...(entry.previousScheduledFor === undefined
        ? {}
        : { previousScheduledFor: entry.previousScheduledFor }),
      taskTitle: entry.taskTitle,
      taskDescription: entry.taskDescription,
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

/** Posts the comment and hands back the tracker's deep link to it when the
 *  provider exposes one, so callers can point a notification at the comment.
 *  Callers that only need the comment posted may ignore the return value. */
export async function postTicketComment(
  ticketId: string,
  comment: string,
  owner: ActiveRunOwner,
): Promise<string | null> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker } = createAdapters();
  await assertActiveRunOwner(getDb(), owner);
  return issueTracker.postComment(ticketId, comment);
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

/**
 * State on the ticket why the run failed, in the same words every other surface
 * uses.
 *
 * Before AIW-254 a failed run moved its ticket back to the backlog and said
 * nothing, so the only reader who could see the reason was an operator with
 * dashboard access; the client whose ticket bounced had to ask. The `reason`
 * handed here is byte-for-byte the string `recordRunFailureReasonStep` persists
 * for the run header and the run list and the one the Slack notification carries.
 *
 * Deliberately NOT passed through `scrubForPublication`. That scrub is built for
 * agent-authored prose and its markers (an absolute sandbox path, "memory
 * document") match text a captured provider tail can legitimately contain, so it
 * would delete the reason from this surface only and make the four surfaces
 * disagree. The control that makes this text publishable is the sanitizer it was
 * already composed by: secrets redacted, stack frames stripped, bounded length.
 *
 * Best-effort in the strongest sense: a ticket comment must never change a run's
 * outcome.
 */
async function postFailureReasonCommentStep(
  ticketKey: string,
  reason: string,
  owner: ActiveRunOwner,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker } = createAdapters();
  try {
    await assertActiveRunOwner(getDb(), owner);
    await issueTracker.postComment(ticketKey, reason);
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { ticketKey, err: errorMessage(err) },
      "failure_reason_comment_failed",
    );
  }
}
postFailureReasonCommentStep.maxRetries = 0;

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

/**
 * The ticket-side account of a run that ends as a no-op: research found the
 * ticket already resolved, so this run wrote nothing. Pure so the copy stays
 * unit-testable. The evidence section is omitted when there is nothing to list;
 * the caller only builds this comment once it has concrete evidence.
 */
export function buildResolutionEvidenceComment(research: ResearchResult): string {
  const evidence = research.resolutionEvidence ?? [];
  const sections = [
    "This ticket appears to be already resolved, so no code changes were made by this run.",
    research.body,
  ];
  if (evidence.length > 0) {
    sections.push(
      ["Evidence:", ...evidence.map((item) => `- ${item}`)].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * Decide what to do with research's already-resolved declaration. A review
 * comment on the ticket's own PR means a person explicitly asked for changes,
 * so the no_change_needed exit must not be taken: the first declaration earns
 * one corrective research retry, a repeat fails the block. Uses the same
 * prComments condition as renderRepositoryContexts' remediation section, so
 * the prompt and the engine agree on what counts as pending feedback. Pure so
 * the decision table stays unit-testable.
 */
export function resolveNoChangeAction(
  research: ResearchResult,
  repositoryContexts: ReadonlyArray<
    Pick<SelectedRepositoryPromptContext, "prComments">
  >,
  retryUsed: boolean,
): "proceed" | "no_change" | "retry" | "fail" {
  const noChangeSignal =
    research.noChangeNeeded === true &&
    (research.resolutionEvidence ?? []).length > 0 &&
    (research.writeRepositories ?? []).length === 0;
  if (!noChangeSignal) return "proceed";
  const hasPrFeedback = repositoryContexts.some(
    (context) => context.prComments.length > 0,
  );
  if (!hasPrFeedback) return "no_change";
  return retryUsed ? "fail" : "retry";
}

/** Evidence quotes are short; a file this size is not a source file the model
 * legitimately quoted, and the whole content lands in the durable step output. */
const LEDGER_EVIDENCE_MAX_BYTES = 200_000;

/**
 * Read one repository file out of the workspace so a claimed already_addressed
 * quote can be checked against the branch. Working tree first (that is what the
 * agent looked at), `git show HEAD:` as the fallback for a path the tree does
 * not hold. Null for anything unreadable, which the verifier treats as evidence
 * that is not there.
 */
export async function readLedgerEvidenceFileStep(
  sandboxId: string,
  repoLocalPath: string,
  filePath: string,
): Promise<string | null> {
  "use step";
  // The path comes from the model, so it never escapes the repository it named.
  if (
    filePath.length === 0 ||
    filePath.startsWith("/") ||
    filePath.split("/").includes("..")
  ) {
    return null;
  }
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const worktree = await sandbox.runCommand("cat", [`${repoLocalPath}/${filePath}`]);
  if (worktree.exitCode === 0) {
    return (await worktree.stdout()).slice(0, LEDGER_EVIDENCE_MAX_BYTES);
  }
  const head = await sandbox.runCommand("git", [
    "-C",
    repoLocalPath,
    "show",
    `HEAD:${filePath}`,
  ]);
  if (head.exitCode !== 0) return null;
  return (await head.stdout()).slice(0, LEDGER_EVIDENCE_MAX_BYTES);
}

/**
 * Tell the reviewer on the PR that this run died before it could answer their
 * threads. Silence here is indistinguishable from the dead webhook Arthur lived
 * with for weeks, so the note is posted even though the run is already failing.
 */
export async function postReviewLedgerFailureNoteStep(payload: {
  pr: { provider: "github" | "gitlab"; repoPath: string; baseRef: string; prNumber: number };
  runId: string;
  reason: string;
  unsettledAliases: string[];
  /** "threads": the run knew what it owed the reviewer. "pre_feed": it had no
   * ledger, either because it died before reading the feed or because the review
   * opened no thread, so the note must not imply anything about threads. */
  variant: "threads" | "pre_feed";
  /** What this run pushed to the PR's own repository before it died, if
   * anything. A run that pushed a fix and then lost the checks block must not
   * leave a note the reviewer reads as "your branch was never touched". */
  pushedHead: string | null;
  /** Threads settlement already replied in. A run that answered everyone and
   * then died owes the reviewer that fact, not an apology for silence. */
  answeredCount: number;
  /** Where the unsettled aliases live, so the note names files a reviewer can
   * open instead of run-internal labels. Narrow on purpose: this whole payload
   * is a step input, so it is serialized into the durable event log. */
  workItems: ReviewLedgerGuardWorkItem[];
}): Promise<{ posted: boolean; error?: string }> {
  "use step";
  const { pr, runId, reason } = payload;
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const adapter = createRepositoryVCS({
    provider: pr.provider,
    repoPath: pr.repoPath,
    baseBranch: pr.baseRef,
  });
  if (payload.variant === "pre_feed") {
    // Deliberately silent about threads: this run either never read the feed or
    // read one with nothing in it, and it cannot tell the reviewer which.
    const body = [
      `AI Workflow run \`${runId}\` failed on this pull request: ${reason.slice(0, 300)}.`,
      payload.pushedHead ? `It pushed \`${payload.pushedHead}\` before failing.` : null,
    ]
      .filter((line): line is string => line !== null)
      .join(" ");
    try {
      await adapter.postRunFailureNote({ prId: pr.prNumber, runId, body });
      return { posted: true };
    } catch (err) {
      return { posted: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const { postRunFailureNoteForRun } = await import("./review-ledger-settle.js");
  return postRunFailureNoteForRun({
    adapter,
    prId: pr.prNumber,
    runId,
    reason,
    unsettledAliases: payload.unsettledAliases,
    workItems: payload.workItems,
    pushedHead: payload.pushedHead,
    answeredCount: payload.answeredCount,
  });
}

/**
 * The ticket-side account of a run that answered review threads and wrote no
 * code. Never says "already resolved": the threads, not the ticket, are what
 * this run was about, and a reviewer reading "ticket already resolved" after
 * asking a question would reasonably conclude the bot ignored them.
 */
export function buildLedgerNoChangeComment(ledger: ReviewLedgerState): string {
  const accepted = ledger.verification?.accepted ?? [];
  const counts = { already_addressed: 0, question: 0, out_of_scope: 0, actionable: 0 };
  for (const disposition of accepted) counts[disposition.disposition] += 1;
  const sections = [
    accepted.length === 0
      ? nothingToAnswerReason(ledger)
      : `I answered ${accepted.length} review thread${accepted.length === 1 ? "" : "s"} on the pull request and made no code changes in this run.`,
  ];
  const detail = [
    counts.already_addressed > 0
      ? `${counts.already_addressed} already addressed on the branch`
      : null,
    counts.question > 0 ? `${counts.question} answered as a question` : null,
    counts.out_of_scope > 0 ? `${counts.out_of_scope} declined as out of scope` : null,
  ].filter((entry): entry is string => entry !== null);
  if (detail.length > 0) sections.push(`Breakdown: ${detail.join(", ")}.`);
  if (ledger.feed.truncated > 0) {
    sections.push(
      `${ledger.feed.truncated} further threads did not fit into this run and are left for the next one.`,
    );
  }
  return sections.join("\n\n");
}

/**
 * Why a run that answered nothing still ended clean. The reason has to match the
 * feed: telling a reviewer their reply is awaited, when the only thread left
 * open belongs to a scanner bot, sends them looking for a question nobody asked.
 */
function nothingToAnswerReason(ledger: ReviewLedgerState): string {
  const parked = ledger.feed.threads.some((thread) => thread.awaitingHuman);
  const thirdParty = ledger.feed.threads.some(
    (thread) => !thread.awaitingHuman && thread.source === "third_party",
  );
  const reasons = [
    parked ? "already waiting on a human reply" : null,
    thirdParty ? "owned by another tool's bot" : null,
  ].filter((reason): reason is string => reason !== null);
  if (reasons.length === 0) {
    return "No open review thread on the pull request was left for this run to address, so it made no code changes.";
  }
  return `Every open review thread on the pull request is ${reasons.join(" or ")}, so this run had nothing to address and made no code changes.`;
}

/**
 * Aliases whose thread is still without a ledger reply. Read off the settle
 * results rather than off the verification, because finalize may already have
 * answered several threads before the run died further downstream, and naming
 * those in a failure note would contradict the reply sitting in the thread.
 */
export function unsettledWorkItemAliases(
  ledger: ReviewLedgerState,
  settled: ReadonlyArray<SettledThread>,
): string[] {
  const answered = new Set(settled.filter(settledWithReply).map((entry) => entry.threadId));
  return selectWorkItems(ledger.feed)
    .filter((thread) => !answered.has(thread.threadId))
    .map((thread) => thread.alias);
}

/** A settle entry that really put a reply in its thread. A skip and a provider
 *  error are not answers, and both are reported in the same result. */
function settledWithReply(entry: SettledThread): boolean {
  return Boolean(entry.action) && !entry.error;
}

/**
 * How many threads settlement actually replied in. The failure note needs it to
 * tell "died before answering anyone" apart from "answered everyone, then died",
 * which read the same to a reviewer and mean opposite things.
 */
export function settledAnswerCount(settled: ReadonlyArray<SettledThread>): number {
  return settled.filter(settledWithReply).length;
}

export interface ReviewLedgerMetrics {
  event: "review_ledger";
  workItems: number;
  truncated: number;
  rejected: number;
  gate: ReviewGate;
  dispositions: Record<string, number>;
  settled?: Record<string, number>;
}

/** Settle outcomes flattened into one counter map: an action, a skip reason, or
 * an error. Written defensively because the settler grows new outcomes. */
export function countSettleOutcomes(
  settled: ReadonlyArray<SettledThread>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of settled) {
    const skipped = (entry as { skipped?: string }).skipped;
    const key = entry.error ? "error" : skipped ? `skipped_${skipped}` : entry.action ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Where the reviewed repository is checked out, so evidence can be read from
 * the branch the decision is made on. Null when this run has no PR repository
 * in a trusted V2 workspace, which makes every quote unverifiable and every
 * already_addressed claim a rejection.
 */
export function reviewLedgerRepoLocalPath(ctx: EngineCtx): string | null {
  if (ctx.entry.kind !== "pr_trigger") return null;
  const manifest = ctx.workspaceManifest;
  if (manifest?.version !== 2) return null;
  const pr = ctx.entry.pr;
  return (
    manifest.repositories.find(
      (repo) => repo.provider === pr.provider && repo.repoPath === pr.repoPath,
    )?.localPath ?? null
  );
}

/**
 * The model answers with `reply: null` / `evidence: null` for the fields it does
 * not use, because the Codex strict schema demands every key. The ledger's own
 * contract uses absence instead, so the nulls are dropped here rather than
 * being carried into the verifier and the thread replies.
 */
export function toReviewThreadDispositions(
  entries: ReadonlyArray<{
    alias: string;
    disposition: ReviewThreadDisposition["disposition"];
    reply?: string | null;
    evidence?: { filePath: string; quote: string } | null;
  }> | null | undefined,
): ReviewThreadDisposition[] {
  return (entries ?? []).map((entry) => ({
    alias: entry.alias,
    disposition: entry.disposition,
    ...(entry.reply != null ? { reply: entry.reply } : {}),
    ...(entry.evidence != null ? { evidence: entry.evidence } : {}),
  }));
}

/**
 * Answer the threads on the no_change terminal, through the same step finalize
 * uses after a push. Only the durable projection crosses the boundary, so the
 * event log never sees twenty threads' worth of note bodies, and the provider
 * writes are checkpointed once instead of being replayed on every resume.
 */
export async function settleReviewLedgerThreads(
  ctx: EngineCtx,
  headSha: string | null,
): Promise<SettledThread[]> {
  if (ctx.entry.kind !== "pr_trigger" || !ctx.reviewLedger) return [];
  const pr = ctx.entry.pr;
  return settleReviewLedgerStep({
    ledger: buildReviewLedgerDurableState(ctx.reviewLedger),
    headSha,
    prId: pr.prNumber,
    provider: pr.provider,
    repoPath: pr.repoPath,
    baseBranch: pr.baseRef,
  });
}

/** The location half of a thread, without a word of its conversation: what a
 * step input may carry, and all the failure note needs to name a thread. */
function toLedgerGuardWorkItems(threads: ReviewThread[]): ReviewLedgerGuardWorkItem[] {
  return threads.map((thread) => ({
    alias: thread.alias,
    threadId: thread.threadId,
    ...(thread.filePath !== undefined ? { filePath: thread.filePath } : {}),
    ...(thread.line !== undefined ? { line: thread.line } : {}),
  }));
}

/**
 * Aliases the prompt shows but nobody has to answer: threads waiting on a human
 * and threads owned by a third party's bot. The complement of
 * {@link selectWorkItems} by construction, so the verifier's idea of "context"
 * cannot drift from the prompt's.
 */
function reviewLedgerContextAliases(feed: ReviewThreadFeed): string[] {
  const workItems = new Set(selectWorkItems(feed));
  return feed.threads
    .filter((thread) => !workItems.has(thread))
    .map((thread) => thread.alias);
}

/**
 * Second evidence pass, run on the tree about to be published. A quote verified
 * before the implementation can be gone after it (the same run rewrote the
 * file), and a thread reply quoting a line nobody can find reads as a lie. The
 * rules are not re-implemented here: the same verifier runs again, so the two
 * passes can never disagree about what counts as evidence.
 *
 * Records the thread ids whose quote survived. An absent list means the pass
 * never ran, which the settler reads as "trust every quote"; an empty list means
 * it ran and nothing survived.
 */
export async function runLedgerEvidenceSecondPass(
  ledger: ReviewLedgerState | undefined,
  readFile: (filePath: string) => Promise<string | null>,
): Promise<void> {
  if (!ledger) return;
  const claims = (ledger.verification?.accepted ?? []).filter(
    (disposition) => disposition.disposition === "already_addressed",
  );
  if (claims.length === 0) return;
  const workItems = selectWorkItems(ledger.feed).filter((thread) =>
    claims.some((claim) => claim.threadId === thread.threadId),
  );
  const recheck = await verifyDispositions({
    workItems,
    dispositions: claims,
    readFile,
  });
  // The recheck's own copies carry the verdict of this pass, including the
  // "nothing on this branch could be read" flag. Keeping the first pass's copies
  // instead would let the settler quote evidence this pass never confirmed, or
  // tell the reviewer the fragment moved when the truth is that the file was
  // unreadable. A claim the recheck rejected outright keeps its first-pass copy:
  // the thread still gets an answer, just not one that quotes anything.
  if (ledger.verification) {
    const rechecked = new Map(
      recheck.accepted
        .filter((disposition) => typeof disposition.threadId === "string")
        .map((disposition) => [disposition.threadId, disposition] as const),
    );
    ledger.verification = {
      ...ledger.verification,
      accepted: ledger.verification.accepted.map(
        (disposition) => rechecked.get(disposition.threadId) ?? disposition,
      ),
    };
  }
  ledger.evidencePresentThreadIds = recheck.accepted
    // Accepted without ever being compared to the branch, so it is not evidence.
    .filter((disposition) => !disposition.evidenceUnverified)
    .map((disposition) => disposition.threadId)
    .filter((threadId): threadId is string => typeof threadId === "string");
}

/**
 * The ledger projection an agent node carries in its durable output. A cold
 * resume rebuilds the workflow context from step outputs, so without this the
 * run would come back with no ledger at all and finalize would answer nothing.
 * Narrow on purpose: accepted dispositions and a note-free feed, never the full
 * state, which would put twenty comment bodies into the event log.
 */
export function reviewLedgerOutputFields(
  ctx: EngineCtx,
): { reviewLedger: JsonValue } | Record<string, never> {
  if (!ctx.reviewLedger) return {};
  return { reviewLedger: buildReviewLedgerDurableState(ctx.reviewLedger) };
}

export interface ReviewLedgerGateDeps {
  /** Read a repository file from the tree the decision is made on. */
  readFile: (filePath: string) => Promise<string | null>;
  /** Answer the threads. Only called on the no_change terminal. */
  settle: () => Promise<SettledThread[]>;
  log: (metrics: ReviewLedgerMetrics) => void;
}

export type ReviewLedgerGateOutcome =
  | { kind: "proceed" }
  | { kind: "retry"; correctionNote: string }
  | { kind: "fail"; reason: string }
  | { kind: "no_change"; comment: string; settled: SettledThread[] };

/**
 * The review ledger's replacement for {@link resolveNoChangeAction} on a run
 * that carries open review threads. Verifies what the agent claimed per thread,
 * stamps the result onto the ledger so the publish guard and the settler read
 * the same verdict, and turns the gate into the run's next move.
 *
 * Returns null when the feed has no work items, which hands the decision back to
 * the pre-ledger logic unchanged: a thread awaiting a human and a third party
 * scanner's thread are context, not work.
 */
export async function applyReviewLedgerGate(
  input: {
    ledger: ReviewLedgerState;
    dispositions: ReviewThreadDisposition[];
    declaresWrites: boolean;
    retryUsed: boolean;
    /** The run exists because somebody commented on the PR. */
    reviewDriven: boolean;
  },
  deps: ReviewLedgerGateDeps,
): Promise<ReviewLedgerGateOutcome | null> {
  // A feed with nothing in it is not a ledger decision at all: a review that
  // left only a summary opens no thread, and answering it with a clean no_change
  // would throw away the plan the reviewer asked for. fetch_pr_context already
  // refuses to build such a ledger; this keeps the property local to the gate.
  if (input.ledger.feed.threads.length === 0) return null;
  const workItems = selectWorkItems(input.ledger.feed);
  if (workItems.length === 0) {
    // A review re-trigger whose threads are all waiting on a human has nothing
    // to do, and it must say so instead of inventing work: the pre-ledger path
    // would read the same comments as "unresolved feedback" and drive the run
    // into a retry and a red failure. Any other trigger (failing checks) keeps
    // its own reason to run, so the decision goes back to the caller.
    if (!input.reviewDriven) return null;
    const settled = await deps.settle();
    deps.log({
      event: "review_ledger",
      workItems: 0,
      truncated: input.ledger.feed.truncated,
      rejected: 0,
      gate: "no_change",
      dispositions: {},
      settled: countSettleOutcomes(settled),
    });
    return {
      kind: "no_change",
      comment: buildLedgerNoChangeComment(input.ledger),
      settled,
    };
  }

  const verification = await verifyDispositions({
    workItems,
    dispositions: input.dispositions,
    readFile: deps.readFile,
    contextAliases: reviewLedgerContextAliases(input.ledger.feed),
  });
  input.ledger.dispositions = input.dispositions;
  input.ledger.verification = verification;
  input.ledger.researchDeclaresWrites = input.declaresWrites;

  const gate =
    resolveReviewGate({
      workItems,
      verification,
      researchDeclaresWrites: input.declaresWrites,
      retryUsed: input.retryUsed,
    }) ?? "proceed";

  const dispositionCounts: Record<string, number> = {};
  for (const disposition of verification.accepted) {
    dispositionCounts[disposition.disposition] =
      (dispositionCounts[disposition.disposition] ?? 0) + 1;
  }
  const metrics: ReviewLedgerMetrics = {
    event: "review_ledger",
    workItems: workItems.length,
    truncated: input.ledger.feed.truncated,
    rejected: verification.rejected.length,
    gate,
    dispositions: dispositionCounts,
  };

  if (gate === "retry") {
    deps.log(metrics);
    return { kind: "retry", correctionNote: buildCorrectionNote(verification.rejected) };
  }
  if (gate === "fail") {
    deps.log(metrics);
    return { kind: "fail", reason: buildGateFailureReason(verification.rejected) };
  }
  if (gate === "no_change") {
    // Nothing was pushed, so the settler answers with no sha and resolves
    // nothing; the threads stay open for the reviewer to close.
    const settled = await deps.settle();
    deps.log({ ...metrics, settled: countSettleOutcomes(settled) });
    return {
      kind: "no_change",
      comment: buildLedgerNoChangeComment(input.ledger),
      settled,
    };
  }
  deps.log(metrics);
  return { kind: "proceed" };
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
  providerOverride: AgentKind | null,
): Promise<Record<string, ResolvedHarnessRuntime>> {
  "use step";
  if (definition.schemaVersion === 1) {
    const { resolveHarnessRuntimesWithLoader } = await import(
      "../workflow-definition/harness-profile-runtime.js"
    );
    // V1 needs no redirect: `defaultProvider` already carries the ticket label,
    // and a v1 block reads its provider from `configuration.provider` with that
    // value as the fallback, which is also what `resolveBlockAgent` executes.
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
    providerOverride,
  });
}
resolveHarnessRuntimesStep.maxRetries = 0;

/** Longest failure cause carried into the Pre-PR checks failure message.
 *  Same bound the Pre-PR repair launch failure puts on its carried cause
 *  (#309): long enough for a sandbox, kill or stream verdict, short enough that
 *  the composed block failure stays a detail rather than a payload. */
export const PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH = 200;

/** Stack tail kept for the log record only, never for the operator message:
 *  frames leak internal paths and are what turns a detail into a firehose. */
export const PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH = 600;

/**
 * Errors the Pre-PR checks call site must rethrow untouched.
 *
 * Both predicates identify an error structurally, by `name`
 * (run-budget.ts:52, run-budget.ts:280) or by a sentinel in its message
 * (run-control-errors.ts:16), because Workflow serializes step errors across
 * VMs. Wrapping one in a new Error therefore destroys the identity the call
 * site depends on, and a budget stop would start reporting as a generic
 * failure.
 */
export function prePrChecksFailureMustPropagate(error: unknown): boolean {
  return isRunControlError(error) || isDurationAbortError(error);
}

/**
 * The parts of a thrown value the failure report needs, flattened where the
 * throw is caught.
 *
 * A separate shape because the report is now composed inside a step and the
 * catch is in workflow scope: Workflow serializes step arguments, and an Error
 * does not survive that. Its name, its `code` and its stack are all dropped,
 * which is every field the report is made of. Flattening here keeps the
 * `instanceof Error` question where the real value still exists.
 */
export interface PrePrChecksFailureInput {
  /** `error.name`, or the `typeof` of a non-Error throw. Log record only. */
  name: string;
  message: string;
  /**
   * What to prefix the cause with: the class name, or empty for a non-Error
   * throw, whose `typeof` would only add noise to its own text.
   *
   * The class name is all there is to prefix with. This catch sits in workflow
   * scope and every error it sees was thrown inside a step, and Workflow
   * reduces a thrown error to its name, message and stack at the VM boundary
   * and revives it as a plain Error on this side. A system error code
   * (`ECONNREFUSED`) would name the cause far better than `Error` does, but
   * `.code` is gone by the time anything here can read it. Recovering it would
   * mean parsing the message, the way isReplayedRunControlStepError parses for
   * run-control errors, and no incident has yet asked for it.
   */
  label: string;
  stack: string;
}

/**
 * Flatten a thrown value into the parts the failure report needs, redacted and
 * bounded before it can go anywhere.
 *
 * Redacted here rather than in the step: Workflow journals step arguments
 * durably, so whatever this returns is written into the run's event log
 * verbatim. An SDK error carrying a `Bearer`, an `sk-ant-` or a `glpat-` in a
 * clone URL would otherwise be persisted in full, with the redaction
 * protecting only the sentence an operator reads. Redaction runs before
 * truncation so a secret is blanked rather than cut in half.
 *
 * The redactor runs in workflow scope here and again inside the step, and the
 * two cannot disagree within an invocation: the workflow VM shims `process` as
 * a frozen spread of `process.env` taken when the context is built, so both
 * sides read the same snapshot. The narrow consequence is that a secret added
 * or rotated AFTER the context was built is absent from that snapshot, so its
 * literal value would cross the boundary into the journal unblanked while the
 * operator's sentence stays clean. The pattern rules below (`sk-ant-`, `gh?_`,
 * `glpat-`, `Bearer`) do not depend on the environment and still catch it.
 *
 * Bounded here for the same reason: the step keeps exactly these bytes anyway,
 * so anything beyond them would be journaled and then dropped.
 *
 * Flattened at all because an Error does not survive step argument
 * serialization: its name, its `code` and its stack, which is every field the
 * report is made of, are dropped in transit.
 */
export function prePrChecksFailureInput(error: unknown): PrePrChecksFailureInput {
  const isError = error instanceof Error;
  const name = isError ? error.name : typeof error;
  const stack = isError ? error.stack ?? "" : "";
  return {
    name,
    message: redactDiagnosticText(isError ? error.message : String(error)).slice(
      0,
      PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH,
    ),
    label: isError ? name : "",
    stack: stack
      ? redactDiagnosticText(stack).slice(-PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH)
      : "",
  };
}

/**
 * What a Pre-PR checks failure is allowed to say, composed in one pure place
 * so the bound and the wording can be pinned directly.
 *
 * `redact` is a parameter rather than an import so this stays a pure function
 * that can be pinned against a stub redactor. The real one is imported
 * directly at the top of this module: it lives alone in
 * `sandbox/agents/redact.js` precisely so workflow scope may import it.
 */
export function prePrChecksFailureReport(
  error: PrePrChecksFailureInput,
  redact: (value: string) => string,
): { name: string; cause: string; stackTail: string; message: string } {
  const cause = redact(
    error.label && error.label !== "Error"
      ? `${error.label}: ${error.message}`
      : error.message,
  ).slice(0, PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH);
  return {
    name: error.name,
    cause,
    stackTail: error.stack
      ? redact(error.stack).slice(-PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH)
      : "",
    message: `The repository scripts step failed: ${cause}`,
  };
}

/**
 * Redact, bound and log a Pre-PR checks failure, and return the one sentence
 * the operator is allowed to see.
 *
 * A step, because the logging needs the server: pino may only be used inside a
 * step, never in workflow scope, and the checks themselves are no longer a step
 * (they are launched detached and polled across ticks), so without this the
 * catch in workflow scope could not log at all. The redaction is not what
 * forces a step, it already ran in workflow scope before the boundary.
 */
export async function describePrePrChecksFailureStep(
  error: PrePrChecksFailureInput,
  configurationVersion: number | null,
): Promise<string> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  const { redactDiagnosticText: redact } = await import("../sandbox/agents/redact.js");
  // Redacted a second time, deliberately. The caller redacts before the step
  // boundary so the journal never holds a secret; this keeps the step correct
  // on its own terms for any input it is given, and redaction is idempotent.
  const report = prePrChecksFailureReport(error, redact);
  logger.error(
    {
      version: configurationVersion,
      name: report.name,
      cause: report.cause,
      stackTail: report.stackTail,
    },
    "pre_pr_checks_step_failed",
  );
  return report.message;
}
describePrePrChecksFailureStep.maxRetries = 0;

/**
 * The sentence to throw for a Pre-PR checks failure, whatever happens to the
 * reporting path itself.
 *
 * describePrePrChecksFailureStep is the only place the cause is logged and its
 * maxRetries is 0, so a failed dynamic import on a cold start, or an invocation
 * killed mid-step, would otherwise replace the real cause with the reporting
 * path's own error. Degrading loses the detail; substituting loses the
 * incident, which is the failure #316 exists to end.
 */
export async function prePrChecksFailureMessage(
  error: unknown,
  configurationVersion: number | null,
): Promise<string> {
  const input = prePrChecksFailureInput(error);
  try {
    return await describePrePrChecksFailureStep(input, configurationVersion);
  } catch (reportingError) {
    // A cancelled run surfaces at every step, this one included, and it is not
    // a reporting failure: swallowing it would turn a cancellation into a
    // Pre-PR checks failure and let the run carry on being cancelled anyway.
    // Same rethrow this file makes at every other step boundary, including the
    // catch that calls this one.
    if (isRunControlError(reportingError)) throw reportingError;
    return `The repository scripts step failed (${input.name.slice(0, 60)}), and the cause could not be recorded.`;
  }
}

export type {
  RepositoryScriptsOutput,
} from "./blocks/repository-scripts-output.js";

/** The command's own output, bounded, then the note on its own line. The note
 *  goes after the bound because a head-and-tail bound eats the middle, which is
 *  exactly where a note folded into the stream would land. */
function repositoryScriptFailureOutput(failure: PrePrCheckFailure): string {
  const output = boundFailureOutput(
    [failure.stderr, failure.stdout]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n"),
    FAILURE_OUTPUT_MAX_CHARS,
  );
  if (!failure.note) return output;
  return output ? `${output}\n${failure.note}` : failure.note;
}

/** One engine failure as the block output and the ticket comment carry it.
 *  Shared with the setup path, which fails in a different block entirely and
 *  has to reach the comment through the same renderer. */
export function repositoryScriptFailureEntry(
  failure: PrePrCheckFailure,
): RepositoryScriptsOutput["failures"][number] {
  return {
    repo: `${failure.provider}:${failure.repoPath}`,
    command: failure.command,
    exitCode: failure.exitCode,
    output: repositoryScriptFailureOutput(failure),
    phase: failure.phase ?? null,
  };
}

/**
 * Groups the run was asked for that no repository it reached declares.
 *
 * Only groups declared *nowhere* are synthesized. A group two of five
 * repositories define is the engine's normal case, deliberately not an error,
 * and reporting the other three as not_run would make every partial-workspace
 * selection unreportable. A name no repository has is the other thing: a typo,
 * or a group deleted from the configuration, and silently running nothing for
 * it is how a node reports a pass for work that never happened. It is attached
 * to every repository the run reached, because it is equally true of each and
 * there is no single repository it belongs to.
 */
function undeclaredGroupStatuses(
  reached: RepositoryScriptGroupStatus[],
  requestedGroups: readonly string[],
): RepositoryScriptGroupStatus[] {
  if (requestedGroups.length === 0 || reached.length === 0) return [];
  const declared = new Set(reached.map((entry) => entry.group));
  const repositories = [
    ...new Map(
      reached.map((entry) => [
        `${entry.provider}:${entry.repoPath}`,
        { provider: entry.provider, repoPath: entry.repoPath },
      ]),
    ).values(),
  ];
  const missing = [...new Set(requestedGroups)].filter(
    (group) => !declared.has(group),
  );
  return missing.flatMap((group) =>
    repositories.map((repo) => ({ ...repo, group, status: "not_run" as const })),
  );
}

/**
 * Shape one engine run into the fields the graph binds against.
 *
 * Three booleans rather than one, because they answer three different
 * questions and collapsing them is how "nothing ran" started reading as
 * "everything is fine":
 *
 *   ok         nothing failed. Still true for a run that matched nothing, which
 *              is the historical contract every deployed graph branches on.
 *   anyFailed  something was verified and did not hold, OR the run could not
 *              start at all. The second half matters: an unreadable
 *              configuration produces no group statuses whatsoever, so deriving
 *              this from groups alone let an anyFailed -> remediate wire take
 *              the happy path on the one failure nobody can see from inside.
 *   allPassed  the stricter reading a publication decision wants. Something was
 *              actually selected, it ran to completion, and it passed. A group
 *              left not_run (a stalled batch, a refused environment, a name no
 *              repository declares) denies it, because a partial run is never
 *              evidence of a pass. Read over the SELECTED groups only: a group
 *              nobody asked for reports not_run the moment one command it
 *              shares with a selected group runs, and that is not a fact about
 *              what this run verified.
 *
 * `skipped` groups are excluded from all of it: a group whose commands did not
 * all run and which nothing selected, and every group of a repository the
 * workspace never touched. Letting them weigh on allPassed would make naming
 * one group of five turn an entirely green run unreportable. A group reached
 * only through another group's `extends` is NOT one of them: its commands ran,
 * so it reports its own verdict and counts like any other.
 *
 * The summary is the engine's own. It words itself per selection (a gate says
 * "matched changed repositories", a named selection says "matched the selected
 * groups"), and overwriting it here pointed the operator of a named run at a
 * change filter that selection never applied.
 */
export function repositoryScriptsOutput(
  run: PrePrCheckRunResult,
  requestedGroups: readonly string[] = [],
): RepositoryScriptsOutput {
  const reached: RepositoryScriptGroupStatus[] = run.groupStatuses.map(
    (entry) => ({
      provider: entry.provider,
      repoPath: entry.repoPath,
      group: entry.group,
      status: entry.status,
    }),
  );
  const undeclared = undeclaredGroupStatuses(reached, requestedGroups);
  const groupStatuses = [...reached, ...undeclared];
  const groupCoverage = run.groupCoverage.map((entry) => ({
    group: entry.group,
    declaredIn: entry.declaredIn,
    missing: entry.missing,
    skipped: entry.skipped,
  }));
  // What a publication decision may weigh: the groups this run asked for, plus
  // the names it asked for that no repository declares. A group reached only
  // through another group's `extends` reports its own verdict, and a sibling
  // that shares one command with a selected group reports not_run as soon as
  // that command runs, because nothing may be claimed about the rest of it.
  // Weighing that would deny a run whose every selected group passed.
  const selected = new Set(run.selectedGroupKeys);
  const decisive = [
    ...reached.filter((entry) =>
      selected.has(`${entry.provider}:${entry.repoPath}:${entry.group}`),
    ),
    ...undeclared,
  ];
  const ranNothing =
    run.outcome === "passed" && run.results.length === 0 && run.failures.length === 0;
  const outcome = ranNothing ? "skipped" : run.outcome;
  const anyFailed =
    outcome === "failed" ||
    groupStatuses.some(
      (entry) => entry.status === "failed" || entry.status === "timed_out",
    );
  return {
    ok: run.passed,
    outcome,
    allPassed:
      !anyFailed &&
      !decisive.some((entry) => entry.status === "not_run") &&
      decisive.some((entry) => entry.status === "passed"),
    anyFailed,
    groupStatuses,
    // Straight through from the engine, which recorded it as the walk went.
    // Deliberately NOT derived from groupStatuses here: a repository the run
    // never started has no status entry at all, so the reconstruction would
    // have nothing to distinguish it from a covered one.
    groupCoverage,
    uncoveredGroupCount: countUncoveredGroups(groupCoverage),
    results: run.results.map((result) => ({
      repo: `${result.provider}:${result.repoPath}`,
      command: result.command,
      group: result.group,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    })),
    failures: run.failures.map(repositoryScriptFailureEntry),
    dirtied: run.dirtied.map((entry) => ({
      repo: `${entry.provider}:${entry.repoPath}`,
      files: entry.files,
      preExisting: entry.preExisting,
    })),
    setupFailed: run.setupFailed,
    summary: run.summary,
  };
}

/**
 * The status variant a shaped run reports.
 *
 * Deliberately never "failed". That word is reserved for execution errors, and
 * re-admitting it as an outcome word would make status ambiguous again: an
 * author reading `status: "failed"` could not tell a failing script from a
 * block that could not run. A failing run is an ordinary branchable outcome and
 * says so through ok, outcome and anyFailed, all three in the binding schema.
 */
export function repositoryScriptsStatus(
  output: Pick<RepositoryScriptsOutput, "ok" | "outcome">,
): "ok" | "skipped" {
  return output.outcome === "skipped" || output.outcome === "missing_configuration"
    ? "skipped"
    : "ok";
}

/**
 * What a failure comment reports about the repository scripts, recovered from
 * the walk's own durable step outputs.
 *
 * Recovered rather than carried. The engine's per-command summary is built
 * inside the block and published on its output, but the run fails at a LATER
 * node (finalize refusing an unmet checks input, or the block itself throwing),
 * and everything that crosses that boundary is one 600-character execution
 * error message. AIW-309 is exactly that boundary: the product knew which
 * command failed and could not say so.
 */
export interface RecoveredRepositoryScriptsFailure {
  outcome: RepositoryScriptsOutput["outcome"];
  summary: string;
  failures: RepositoryScriptsOutput["failures"];
  dirtied: RepositoryScriptsOutput["dirtied"];
  /** Optional, unlike the rest: the shared guard deliberately does not require
   *  it, so an output recorded by a deployment from before the field existed
   *  arrives without it. The comment defaults it to no coverage rather than
   *  losing the whole recovered failure over one absent key. */
  groupCoverage?: RepositoryScriptsOutput["groupCoverage"];
}

/**
 * The LATEST repository scripts output a run recorded, and only when that one
 * was not clean.
 *
 * Latest-recorded, deliberately, not latest-failing. A clean latest output is
 * positive evidence that the terminal failure was not produced by the scripts:
 * a definition that deliberately continues past a failing group (a wired
 * `failed` edge into a remediation branch) and then passes a later one has
 * already handled that failure, and attaching its output to whatever the run
 * died of afterwards would name a cause that was dealt with rounds ago. So a
 * clean latest run returns null and the failure keeps its own reason.
 *
 * The cost of that choice, stated rather than hidden: a genuinely relevant
 * earlier failure is not reported when a later scripts run passed. That is the
 * safe direction, because a missing appendix leaves the reason intact while a
 * wrong one actively misdirects.
 */
export function recoverLatestRepositoryScriptsFailureFromSteps(
  steps: StepsRecord,
): RecoveredRepositoryScriptsFailure | null {
  const outputs = Object.values(steps);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const scripts = asRepositoryScriptsOutput(
      outputs[index]?.output as Record<string, unknown> | undefined,
    );
    if (!scripts) continue;
    // A clean run is not evidence of anything a failure comment needs, and
    // appending it would attribute an unrelated failure to the scripts.
    if (scripts.outcome === "passed" && scripts.failures.length === 0) return null;
    return scripts;
  }
  return null;
}

/**
 * Failure phases whose comment is about the repository scripts.
 *
 * Deliberately a closed set. A run whose scripts failed can go on to fail
 * somewhere else entirely (a wired failure edge that then loses its sandbox),
 * and attaching the script report to that failure would name the wrong cause.
 * The members are the phases the two boundaries actually produce: the checks
 * CATEGORY, the publication gate's own phase, and the node types the v2
 * scheduler uses as the phase of a block that threw.
 *
 * "checks" is in here as a CATEGORY, not as a phase. finalize_workspace
 * refuses an unmet `checks.*` input with no phase at all, so both walk paths
 * have to fall back to the category before they key on this set, which is what
 * `failureExitPhase` exists to guarantee. The v2 path skipped that fallback and
 * reported "workflow", which silently disabled evidence recovery on the one
 * path production actually runs.
 */
const REPOSITORY_SCRIPTS_FAILURE_PHASES: ReadonlySet<string> = new Set([
  "checks",
  "pre-pr-checks",
  "run_scripts",
  "run_checks",
  "run_pre_pr_checks",
]);

export function isRepositoryScriptsFailurePhase(phase: string): boolean {
  return REPOSITORY_SCRIPTS_FAILURE_PHASES.has(phase);
}

/**
 * The phase a terminal execution error reports to the failure exit.
 *
 * The category is the fallback, exactly as the v1 interpreter's own finish()
 * does it. A block that composed its error without a phase is the normal case,
 * not an edge case: finalize's unmet-checks refusal is one, and reporting it as
 * a nameless "workflow" failure is what kept AIW-309's headline case posting a
 * bare comment on the v2 path.
 */
export function failureExitPhase(
  error: Pick<WorkflowExecutionErrorState, "phase" | "category">,
): string {
  return error.phase ?? error.category ?? "workflow";
}

/** Leads, one per class of script failure. They answer different questions, so
 *  a single sentence for all five is what made the report unreadable: a
 *  failing command, a broken toolchain, a selection that matched nothing, an
 *  exhausted budget and a batch stopped part way need five different actions. */
// Every one of them is the shared class stem ended with a full stop. The
// publication boundary refuses with the same words and runs.diagnose matches on
// them, so a copy here would rot the day one is reworded, and a class that
// existed only here would refuse with the wrong one: that is how a budget stop
// came to lead this comment with CHECKS BUDGET SPENT while the boundary called
// it a failing command.
const REPOSITORY_SCRIPTS_FAILED_LEAD = `${REPOSITORY_SCRIPTS_FAILED_CLASS}.`;
const REPOSITORY_SCRIPTS_NOT_STARTED_LEAD = `${REPOSITORY_SCRIPTS_NOT_STARTED_CLASS}.`;
const REPOSITORY_SCRIPTS_NOTHING_RAN_LEAD = `${REPOSITORY_SCRIPTS_NOTHING_RAN_CLASS}.`;
const REPOSITORY_SCRIPTS_BUDGET_LEAD = `${REPOSITORY_SCRIPTS_BUDGET_CLASS}.`;
const REPOSITORY_SCRIPTS_ABANDONED_LEAD = `${REPOSITORY_SCRIPTS_ABANDONED_CLASS}.`;

/** Appended when the definition still asks for repair cycles. The parameter is
 *  accepted and ignored by the engine, so without this the operator's only
 *  evidence is a repair that never happens. */
const REPAIR_CYCLES_REMOVED_NOTE =
  "This workflow definition still requests repair cycles (maxFixCycles), and the " +
  "repair loop was removed: nothing launches an agent to fix a failing script any more.";

/** Headings mirroring formatPrePrCheckFailures (pre-pr-checks/runner.ts), so
 *  the ticket comment and the block's own summary read the same way. */
const REPOSITORY_SCRIPT_PHASE_HEADINGS: Record<string, string> = {
  setup: "SETUP FAILED for",
  workspace: "WORKSPACE UNAVAILABLE for",
  batch: "CHECK BATCH ABANDONED for",
  omitted: "FAILURES OMITTED for",
  env: "ENVIRONMENT UNAVAILABLE for",
  budget: "CHECKS BUDGET SPENT before",
};

/**
 * Failures the comment renders in full before it starts counting.
 *
 * Each one already carries up to 2000 characters of bounded output, and this
 * text is a journaled step argument on its way to a ticket. Five failing
 * commands is more than enough to act on; a repository with fifty has one
 * cause, not fifty.
 */
const REPOSITORY_SCRIPT_FAILURES_SHOWN = 5;

/** Where the failures this comment did not render can still be read. A bare
 *  count told an operator something was missing and nothing about how to see
 *  it, which is the defect this whole stage exists to stop repeating. */
const REPOSITORY_SCRIPT_FAILURES_ELSEWHERE =
  "The full list is on the scripts block's `failures` output, in the run details view.";

/** Appended when no node of the definition could ever mint a publication gate,
 *  so Finalize was always going to refuse it. run_scripts deliberately records
 *  none, and a narrowed run_checks records none either; nothing else in the
 *  failure says so. */
const NO_GATE_BLOCK_NOTE =
  "This definition has no node that can record a publication gate before " +
  "Finalize Workspace: only run_pre_pr_checks, and a run_checks left on its " +
  "default configured selection, record the gate the publication boundary " +
  "requires. run_scripts never does, and a run_checks narrowed by groups or " +
  "explicit commands does not either.";

/**
 * Whether this node could mint a publication gate at all.
 *
 * CAPABILITY, not type. run_checks records a gate only on its default
 * configured path (blocks/run-checks.ts): a `groups` selection is refused
 * because a node that ran only `lint` never established what the gate claims,
 * and an explicit `commands` list produces no configuration version to record
 * against. A `skipReason` returns before any of it. Keying on the type alone
 * traded one falsehood ("no block can") for a narrower silence: the author of a
 * run_checks(groups: ["lint"]) graph would be told nothing at all.
 */
export function nodeCanRecordGate(node: {
  type: string;
  params: Record<string, unknown>;
}): boolean {
  if (node.type === "run_pre_pr_checks") return true;
  if (node.type !== "run_checks") return false;
  const narrowing = (value: unknown): boolean =>
    Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim());
  if (narrowing(node.params.groups) || narrowing(node.params.commands)) return false;
  return !(
    typeof node.params.skipReason === "string" && node.params.skipReason.trim()
  );
}

/**
 * Which class of failure the lead sentence announces.
 *
 * `outcome` decides "nothing ran", never the emptiness of `failures`. An
 * unreadable configuration reports outcome "failed" with no failure entries at
 * all (its summary names the broken field), and reading that as "nothing
 * matched" told an operator their selection was fine when the configuration
 * could not be parsed.
 */
function repositoryScriptFailureClass(
  scripts: RecoveredRepositoryScriptsFailure,
): string {
  const phases = scripts.failures.map((failure) => failure.phase);
  // An ordinary failing command leads, whatever else happened: it is the one
  // class an operator answers by reading the output below.
  if (phases.some((phase) => phase === null)) return REPOSITORY_SCRIPTS_FAILED_LEAD;
  if (phases.includes("budget")) return REPOSITORY_SCRIPTS_BUDGET_LEAD;
  // A stopped batch keeps whatever it managed to run, so "could not be
  // started" contradicts the commands rendered right under the sentence.
  if (phases.includes("batch")) return REPOSITORY_SCRIPTS_ABANDONED_LEAD;
  if (phases.length > 0) return REPOSITORY_SCRIPTS_NOT_STARTED_LEAD;
  return scripts.outcome === "skipped"
    ? REPOSITORY_SCRIPTS_NOTHING_RAN_LEAD
    : REPOSITORY_SCRIPTS_NOT_STARTED_LEAD;
}

function renderRepositoryScriptFailure(
  failure: RepositoryScriptsOutput["failures"][number],
): string {
  const heading = failure.phase
    ? REPOSITORY_SCRIPT_PHASE_HEADINGS[failure.phase]
    : undefined;
  const head = `${heading ? `${heading} ` : ""}${failure.repo}: ${failure.command} (exit ${failure.exitCode})`;
  return failure.output ? `${head}\n${failure.output}` : head;
}

/**
 * The failures to render, and how many ordinary ones were left out.
 *
 * Only ordinary command failures compete for the window. Everything with a
 * phase is a TERMINAL cause (the checks ceiling ran out, a toolchain never
 * installed, a batch lost its sandbox) and answers a different question from
 * the commands around it, so array order deciding whether an operator learns
 * that the budget was spent is not a bound, it is a coin toss: six failing
 * commands ahead of the budget entry hid the only line that named the real
 * reason nothing else ran.
 */
function selectRepositoryScriptFailures(
  failures: RepositoryScriptsOutput["failures"],
): { shown: RepositoryScriptsOutput["failures"]; omitted: number } {
  const ordinary = failures.filter((failure) => failure.phase === null);
  const kept = new Set(ordinary.slice(0, REPOSITORY_SCRIPT_FAILURES_SHOWN));
  return {
    shown: failures.filter((failure) => failure.phase !== null || kept.has(failure)),
    omitted: ordinary.length - kept.size,
  };
}

/**
 * What this run's scripts left in the trees, as one line per repository.
 *
 * Rendered here as well as in the gate's own message because that message is
 * an execution error detail, and every surface that carries one clamps it: the
 * ticket comment is the only place with room for the whole list. It is also the
 * only surface where the culprit and the agent's own uncommitted work can be
 * shown side by side without one of them being truncated away.
 */
function renderRepositoryScriptDrift(
  dirtied: RepositoryScriptsOutput["dirtied"],
): string[] {
  const lines = dirtied.flatMap((entry) => [
    ...(entry.files.length > 0
      ? [`Repository scripts modified in ${entry.repo}: ${entry.files.join(", ")}`]
      : []),
    ...(entry.preExisting.length > 0
      ? [`Already modified before the scripts ran in ${entry.repo}: ${entry.preExisting.join(", ")}`]
      : []),
  ]);
  return lines.length > 0 ? [lines.join("\n")] : [];
}

/**
 * The one ticket comment a failed run posts, with the script evidence attached.
 *
 * `reason` stays first and byte-for-byte: it is the string the run header, the
 * run list and the Slack notification all carry, and the four surfaces agreeing
 * on it is what AIW-254 bought. Everything below it is additional evidence this
 * one surface has room for, never a replacement, and never a second comment.
 */
export function repositoryScriptsFailureComment(
  reason: string,
  scripts: RecoveredRepositoryScriptsFailure | null,
  options: {
    repairCyclesRequested?: boolean;
    /** The run failed on a missing publication gate and the definition contains
     *  no block that could ever record one. */
    noGateBlock?: boolean;
    /** Drift recovered independently of a scripts FAILURE: a group with
     *  restoreTree false can leave files behind on a run whose scripts all
     *  passed, and that is exactly the run the publication boundary then
     *  refuses. */
    drift?: RepositoryScriptsOutput["dirtied"];
    /** Setup failures from the prepare phase. They fail the run before any
     *  scripts output exists, so nothing here can be recovered from the steps:
     *  without them the comment had only the bounded reason to show, and the
     *  elision that bounds it lands inside the command. */
    setupFailures?: RepositoryScriptsOutput["failures"];
  } = {},
): string {
  // The caller's drift wins when it has any: it is merged across every script
  // block the walk ran, while a recovered failure carries only the last one's.
  const drift = renderRepositoryScriptDrift(
    options.drift?.length ? options.drift : (scripts?.dirtied ?? []),
  );
  const notes = [
    ...(options.noGateBlock ? [NO_GATE_BLOCK_NOTE] : []),
    ...(options.repairCyclesRequested ? [REPAIR_CYCLES_REMOVED_NOTE] : []),
  ];
  const coverageNotes = repositoryScriptCoverageNotes(scripts?.groupCoverage ?? []);
  const coverage = coverageNotes.length > 0 ? [coverageNotes.join("\n")] : [];
  // Before the scripts, because setup runs before them: a repository whose
  // toolchain never installed ran no scripts at all.
  const setup = (options.setupFailures ?? []).map(renderRepositoryScriptFailure);
  if (!scripts) {
    return [reason, ...setup, ...drift, ...notes].join("\n\n");
  }
  const { shown, omitted } = selectRepositoryScriptFailures(scripts.failures);
  const sections = [
    reason,
    ...setup,
    [
      repositoryScriptFailureClass(scripts),
      // The engine's own sentence, but only when there is no failure entry to
      // render. It is the only thing that speaks for a run without one (an
      // unreadable configuration names the broken field here); next to the
      // rendered failures it is the same commands, exit codes and output tails
      // a second time, because that is what it was built from.
      ...(scripts.failures.length === 0 && scripts.summary ? [scripts.summary] : []),
      ...shown.map(renderRepositoryScriptFailure),
      ...(omitted > 0
        ? [
            `and ${omitted} more failing command${omitted === 1 ? "" : "s"} not shown. ` +
              REPOSITORY_SCRIPT_FAILURES_ELSEWHERE,
          ]
        : []),
    ].join("\n\n"),
    // After the failures, because they are two different facts about the same
    // run and an operator needs both: the command that failed where it ran, and
    // the repositories the selection never covered at all. The engine appends
    // the same sentences to a CLEAN run's summary, which is the run this
    // comment never posts for.
    ...coverage,
    ...drift,
    ...notes,
  ];
  return sections.join("\n\n");
}

/** True when any node of the executing definition still carries a positive
 *  maxFixCycles. Read from the definition rather than from the block output:
 *  the engine drops the parameter, so nothing downstream of it remembers that
 *  the author asked. */
export function definitionRequestsRepairCycles(
  nodes: ReadonlyArray<{ params: Record<string, unknown> }>,
): boolean {
  return nodes.some((node) => {
    const cycles = node.params.maxFixCycles;
    return typeof cycles === "number" && cycles > 0;
  });
}

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
    attribution?: RunBudgetAttribution,
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
    async observeBudget(
      requireRemainingDuration = true,
      attribution: RunBudgetAttribution = "duration",
    ) {
      const workflow = await observeWorkflowBudget(requireRemainingDuration, attribution);
      const now = await readClock();
      state = addElapsed(state, now - lastClockMs, attribution);
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

export function mergeBudgetObservations(
  workflow: RunBudgetObservation,
  profile: RunBudgetObservation,
): RunBudgetObservation {
  const remainingDurationMs = Math.min(
    workflow.remainingDurationMs,
    profile.remainingDurationMs,
  );
  // The larger of the two, not the tighter one. A profile context is created
  // when its block starts, so it has not seen the checks other blocks already
  // spent; taking its smaller total would hand every profile block a fresh
  // checks ceiling and let one run spend the ceiling several times over.
  const checksElapsedMs = Math.max(
    checksElapsedOf(workflow),
    checksElapsedOf(profile),
  );
  if (workflow.check.status !== "ok") {
    return { ...workflow, remainingDurationMs, checksElapsedMs };
  }
  if (profile.check.status !== "ok") {
    return { ...profile, remainingDurationMs, checksElapsedMs };
  }
  const tighter =
    profile.remainingDurationMs < workflow.remainingDurationMs
      ? profile
      : workflow;
  return {
    ...tighter,
    check: { status: "ok" },
    remainingDurationMs,
    checksElapsedMs,
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

async function digestClarificationDecisionInputsStep(payload: {
  ticketValue: unknown;
  contextValue: unknown;
}): Promise<ClarificationDecisionDigest> {
  "use step";
  const { digestClarificationDecisionInputs } = await import(
    "./clarification-decision-digest.js"
  );
  return digestClarificationDecisionInputs(payload.ticketValue, payload.contextValue);
}
digestClarificationDecisionInputsStep.maxRetries = 0;

/**
 * AIW-267: builds the decision-inputs observation for a research/impl phase
 * that reached a structured decision, so a future "why did it ask (or not)"
 * question is answerable from the run ID alone. Best-effort like the rest of
 * replay capture: a failed digest just means the observation is skipped, it
 * never fails the phase.
 */
async function resolveClarificationDecisionObservation(input: {
  status: string;
  questions?: string[] | null;
  suggestedAnswers?: string[] | null;
  ticketValue: unknown;
  contextValue: unknown;
  harnessProfileHash: string | null;
}): Promise<ClarificationDecisionObservation | undefined> {
  try {
    const digest = await digestClarificationDecisionInputsStep({
      ticketValue: input.ticketValue,
      contextValue: input.contextValue,
    });
    return {
      status: input.status,
      questions: input.questions ?? null,
      suggestedAnswers: input.suggestedAnswers ?? null,
      ...digest,
      harnessProfileHash: input.harnessProfileHash,
    };
  } catch {
    return undefined;
  }
}

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

/**
 * Append observations to a still-running attempt.
 *
 * The other two writers are state transitions and carry their observations as
 * cargo. A block that polls for the better part of an hour has no transition to
 * hang them on, and waiting for its finish is what made a long checks phase
 * indistinguishable from a hung run. This appends and changes no state.
 *
 * maxRetries 0 like every capture step: it is best effort, and a failure here
 * returns false so the caller can trip the capture breaker rather than the run.
 */
async function flushV2RunObservationsStep(payload: {
  runId: string;
  organizationId: string;
  attemptId: number;
  observations: SanitizedReplayObservation[];
}): Promise<boolean> {
  "use step";
  try {
    const { getDb } = await import("../db/client.js");
    const { recordWorkflowBlockAttemptObservation } = await import(
      "../run-observability/store.js"
    );
    const db = getDb();
    for (const observation of payload.observations) {
      const recorded = await replayCaptureWithinTimeout(
        recordWorkflowBlockAttemptObservation({
          db,
          runId: payload.runId,
          organizationId: payload.organizationId,
          attemptId: payload.attemptId,
          kind: observation.kind,
          envelope: observation.envelope,
        }),
      );
      if (!recorded) {
        throw new Error("Replay attempt is no longer available");
      }
    }
    return true;
  } catch {
    await markV2ReplayCaptureUnavailable(payload);
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { runId: payload.runId, attemptId: payload.attemptId },
      "run_replay_attempt_flush_failed",
    );
    return false;
  }
}
flushV2RunObservationsStep.maxRetries = 0;

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
      acknowledgeScheduleDispatchStep,
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
    if (!(await acknowledgeScheduleDispatchStep(entry, workflowRunId))) return;
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
    agentKindOverride,
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
    attribution: RunBudgetAttribution = "duration",
  ): Promise<RunBudgetObservation> => {
    const now = await readRunBudgetClockStep();
    // The clock is journaled, so a replay re-reads the same instants and lands
    // on the same split between the two totals. Attributing from Date.now()
    // here would give a resumed run a different checks bill than the one it
    // was already charged.
    budgetState = addElapsed(budgetState, now - lastBudgetClockMs, attribution);
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
  // Attribution for the terminal diagnostic on the catch path, which reads
  // currentBlockId for its nodeId, category and phase. See soleActiveBlockId.
  const syncCurrentBlockId = (): void => {
    currentBlockId = soleActiveBlockId(activeBlockIds);
  };
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
          async flush(attemptId) {
            const observations = takePendingObservations(attemptId, false);
            if (observations.length === 0) return;
            const captured = await flushV2RunObservationsStep({
              ...common,
              attemptId,
              observations,
            });
            if (!captured) {
              throw new Error("Replay observation flush failed");
            }
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
      checksCeilingMs: null,
      observeBudget: (requireRemainingDuration = true, attribution) =>
        observeBudgetAtBoundary(requireRemainingDuration, attribution),
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
        assertScheduledRunMayNotPark(entry);
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
            const { ensureArthurTask, ensureChecksCeiling, sandboxLifetimeMs } =
              await import("./blocks/prepare-workspace.js");
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
            // The checkpoint's own ceiling first: it is the number the sandbox
            // this one replaces was sized against, so a configuration edited
            // while the run was parked cannot change the bound mid-run. Seeded
            // back onto the context so every block after the resume agrees.
            const restoredCeilingMs =
              recoverChecksCeilingFromSteps(checkpointSteps) ??
              (await ensureChecksCeiling(ctx));
            ctx.checksCeilingMs ??= restoredCeilingMs;
            const restored = await restoreClarificationSandboxStep({
              snapshotId: snapshot.snapshotId,
              subjectKey: entry.subjectKey,
              ownerToken: entry.ownerToken,
              // Remaining run duration PLUS the checks ceiling, exactly like
              // every other sandbox that can host a batch (agent-sandbox.ts,
              // prepare-workspace.ts). The checks cap no longer consults the
              // run's duration, so sizing this from the duration alone would
              // kill a resumed run's sandbox under a batch that is well inside
              // its own bound, and report it as a lost workspace.
              timeoutMs: sandboxLifetimeMs(
                restoreBudget.remainingDurationMs,
                restoredCeilingMs,
              ),
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

      // The reviewer is waiting in a thread, and a failed run that says
      // nothing is indistinguishable from a webhook that never fired. Posted
      // before the ticket side effects and independent of them, because the
      // note belongs to the PR, not to the ticket.
      //
      // Only for runs a review comment started: a failed checks-fix run owes
      // the reviewer nothing, and a note about review threads on it would be
      // noise about work nobody asked for. A run that died before the feed
      // existed (clone, 401) still owes the reviewer the fact that it died,
      // so it gets a variant that claims to have seen no threads.
      const postReviewLedgerFailureNoteOnFailureExit = async (
        reason: string,
      ): Promise<void> => {
        if (
          ctx.entry.kind !== "pr_trigger" ||
          ctx.entry.triggerType !== "trigger_pr_review"
        ) {
          return;
        }
        // Flag off must reproduce byte-for-byte pre-ledger behavior, and the
        // pre-ledger run never posted a failure note on this path.
        const { env } = await import("../../env.js");
        if (!env.REVIEW_LEDGER_ENABLED) {
          return;
        }
        const ledger = ctx.reviewLedger;
        const workItems = ledger ? selectWorkItems(ledger.feed) : [];
        await postReviewLedgerFailureNoteStep({
          pr: {
            provider: ctx.entry.pr.provider,
            repoPath: ctx.entry.pr.repoPath,
            baseRef: ctx.entry.pr.baseRef,
            prNumber: ctx.entry.pr.prNumber,
          },
          runId: workflowRunId,
          reason,
          // Naming threads is only honest when the run had some to owe.
          unsettledAliases:
            ledger && workItems.length > 0
              ? unsettledWorkItemAliases(ledger, ctx.reviewLedgerSettled ?? [])
              : [],
          variant: ledger ? "threads" : "pre_feed",
          workItems: toLedgerGuardWorkItems(workItems),
          // Stamped by fix_agent after a successful push. A run that pushed
          // the fix and then lost the checks block owes the reviewer that
          // fact, or the note reads as "nothing happened".
          pushedHead: ctx.pushedHeadForPr ?? null,
          // Counted off what settlement actually wrote, so a run that answered
          // every thread before dying does not apologise for silence.
          answeredCount: settledAnswerCount(ctx.reviewLedgerSettled ?? []),
        }).catch(() => undefined);
      };

      const failureExit = async (
        phase: string,
        reason: string,
        _nodeId?: string,
        steps?: StepsRecord,
      ): Promise<void> => {
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
        await postReviewLedgerFailureNoteOnFailureExit(reason);
        // The ticket comment, and only the ticket comment, carries the script
        // evidence beside the reason. The run header, the run list and Slack
        // keep the reason alone: they read one bounded string each and AIW-254
        // pins them to the same one.
        const comment = repositoryScriptsFailureComment(
          reason,
          steps && isRepositoryScriptsFailurePhase(phase)
            ? recoverLatestRepositoryScriptsFailureFromSteps(steps)
            : null,
          {
            repairCyclesRequested: definitionRequestsRepairCycles(plan.nodes),
            // A gate the definition can never mint is a build error, not a run
            // error, and no other surface says so. run_scripts records no gate
            // on purpose, so a graph made only of it fails here every time.
            // Either refusal reaches here: the boundary names the missing
            // record when there is nothing else to say, and the scripts' own
            // verdict when there is. Both are the publication boundary refusing
            // a run with no gate, and a definition that can never mint one is
            // the same build error under either sentence.
            noGateBlock:
              (reason.includes(WORKSPACE_GATE_NOT_RECORDED_PREFIX) ||
                isRepositoryScriptsRefusal(reason)) &&
              !plan.nodes.some(nodeCanRecordGate),
            // Drift survives a run whose scripts all passed: a group with
            // restoreTree false leaves files behind and the boundary then
            // refuses to publish, with no failure entry anywhere to hang the
            // paths on.
            ...(steps ? { drift: recoverScriptDriftFromSteps(steps) } : {}),
            // From the context, not from the steps: the prepare block fails
            // before it can publish an output, so the failure it composed is
            // the only place these ever existed.
            ...(ctx.setupFailures?.length
              ? { setupFailures: ctx.setupFailures.map(repositoryScriptFailureEntry) }
              : {}),
          },
        );
        const { handleWorkflowFailureExit } = await import("./workflow-failure-exit.js");
        await handleWorkflowFailureExit(entry.ticketKey ?? undefined, {
          logFailure: () => logPhaseFailure(entry.subjectKey, phase, reason),
          commentFailure: () =>
            postFailureReasonCommentStep(ticket.identifier, comment, transitionOwner),
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
        if (
          decision.kind === "already_attached" ||
          decision.kind === "unnamed_request"
        ) {
          // Research either asked only for repositories the workspace already
          // holds, or asked for more context without naming a repository at
          // all: nothing to clone, and no question a human could usefully
          // answer, so continue with what is attached instead of parking the
          // run (AIW-284).
          // The round still counts and the requests are still recorded. That is
          // deliberate: it bounds a model that keeps re-requesting the same
          // repositories (the third round trips the expansion limit, which IS a
          // legitimate human question), and it puts the requests into the
          // "Repository expansion history" note the next research prompt carries,
          // which tells the model those repositories are attached and that it
          // should continue the same research.
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
            attachedCount: 0,
            totalCount: ctx.selectedRepositories.length,
            cloneDurationMs: 0,
          });
          return null;
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
            // One retry per run, shared by both gates: the ledger's correction
            // note and the pre-ledger "do not declare this resolved" note ride
            // the same flag, so a run can never spend two research passes on
            // the same refusal and the -no-change-retry phase suffix stays
            // unique.
            let noChangeRetryUsed = false;
            let ledgerCorrectionNote: string | null = null;
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
            // The retry re-runs the research phase, so both the label and the
            // artifact phase must stay distinct from the first pass (same
            // freshness trick as the -expansion-N suffix).
            const noChangeRetrySuffix = noChangeRetryUsed ? " no-change retry" : "";
            const researchLabel =
              ctx.schemaVersion === 2
                ? `Research ${node.id}${expansionRound > 0 ? ` expansion ${expansionRound}` : ""}${noChangeRetrySuffix}`
                : `Research${expansionRound > 0 ? ` expansion ${expansionRound}` : ""}${noChangeRetrySuffix}`;
            const baseResearchArtifactPhase = agentArtifactPhase("research", execution);
            const expandedResearchArtifactPhase =
              expansionRound > 0
                ? `${baseResearchArtifactPhase}-expansion-${expansionRound}`
                : baseResearchArtifactPhase;
            const researchArtifactPhase = noChangeRetryUsed
              ? `${expandedResearchArtifactPhase}-no-change-retry`
              : expandedResearchArtifactPhase;
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
            const researchAdditions = [...ctx.preSandboxAdditions.research];
            if (ctx.repositoryExpansion.priorRequests.length > 0) {
              researchAdditions.push({
                target: ["research" as const],
                title: "Repository expansion history",
                content: [
                  "The following repositories were requested and are now attached.",
                  "Continue the same research; do not restart from assumptions.",
                  JSON.stringify(ctx.repositoryExpansion.priorRequests),
                ].join("\n"),
              });
            }
            if (ledgerCorrectionNote) {
              // The ledger rejected specific aliases, so the generic "do not
              // declare this resolved" note would be misleading: the model is
              // told which claims failed and why instead.
              researchAdditions.push({
                target: ["research" as const],
                title: "Fix the rejected review thread dispositions",
                content: ledgerCorrectionNote,
              });
            } else if (noChangeRetryUsed) {
              researchAdditions.push({
                target: ["research" as const],
                title: "Do not declare this ticket already resolved",
                content: [
                  "A human requested changes in the PR review feedback above, and the previous research pass wrongly concluded no change was needed.",
                  "Treat addressing every point of that review feedback as the task: produce an implementation plan for it, declare the writeRepositories it touches, and do not set noChangeNeeded.",
                ].join("\n"),
              });
            }
            const researchContext = {
              ticket: resolveAgentTicketInput(resolvedInputs, ticketData, ctx.clarifications),
              branchName,
              attachments: downloadedAttachments,
              preSandboxAdditions: researchAdditions,
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
            const researchClarificationDecision = execution?.observations && researchResult.ok
              ? await resolveClarificationDecisionObservation({
                  status: researchResult.value.status,
                  questions: researchResult.value.questions,
                  suggestedAnswers: researchResult.value.suggestedAnswers,
                  ticketValue: researchContext.ticket,
                  contextValue: researchContext.repositoryContexts,
                  harnessProfileHash: runtime?.manifestHash ?? null,
                })
              : undefined;
            await emitAgentInvocationObservations({
              observations: execution?.observations,
              provider: kind,
              model,
              phase: researchArtifactPhase,
              artifacts: researchArtifacts,
              usage: researchUsage,
              result: researchResult,
              ...(researchClarificationDecision
                ? { clarificationDecision: researchClarificationDecision }
                : {}),
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

            // An already resolved ticket (fix landed in an earlier commit, PR,
            // or ticket comment) ends the run here as a successful no-op: there
            // is nothing for any downstream block to write. A half-filled
            // signal keeps the normal plan path and its
            // researchDeclaredNoWritesGuard verdict untouched. When the
            // ticket's own PR carries human review feedback, that request is
            // the task, so the exit is refused: one corrective research retry,
            // then a hard fail instead of a false success.
            // With open review threads the ledger decides instead: a run is a
            // no-op only when every thread was answered and none of the answers
            // asks for code. Absent ledger (flag off, no PR run, or a feed with
            // nothing to answer) leaves the pre-ledger decision untouched.
            const ledgerRepoPath = reviewLedgerRepoLocalPath(ctx);
            const ledgerGate = ctx.reviewLedger
              ? await applyReviewLedgerGate(
                  {
                    ledger: ctx.reviewLedger,
                    dispositions: toReviewThreadDispositions(research.reviewThreads),
                    declaresWrites: (research.writeRepositories ?? []).length > 0,
                    retryUsed: noChangeRetryUsed,
                    reviewDriven:
                      ctx.entry.kind === "pr_trigger" &&
                      ctx.entry.triggerType === "trigger_pr_review",
                  },
                  {
                    readFile: (filePath) =>
                      ledgerRepoPath
                        ? readLedgerEvidenceFileStep(sandboxId, ledgerRepoPath, filePath)
                        : Promise.resolve(null),
                    settle: () => settleReviewLedgerThreads(ctx, null),
                    log: (metrics) => console.log(JSON.stringify(metrics)),
                  },
                )
              : null;
            if (ledgerGate?.kind === "retry") {
              ledgerCorrectionNote = ledgerGate.correctionNote;
              noChangeRetryUsed = true;
              continue;
            }
            if (ledgerGate?.kind === "fail") {
              return executionError(ledgerGate.reason, {
                category: "engine",
                phase: "research",
              });
            }
            if (ledgerGate?.kind === "no_change") {
              ctx.reviewLedgerSettled = ledgerGate.settled;
            }
            const noChangeAction = ledgerGate
              ? ledgerGate.kind === "no_change"
                ? "no_change"
                : "proceed"
              : resolveNoChangeAction(
                  research,
                  // With a ledger in play it is the only definition of pending
                  // feedback. The flat comment list still holds every note on
                  // the PR, including ones already answered, so letting it vote
                  // here would refuse a legitimate no-op forever.
                  ctx.reviewLedger ? [] : ctx.repositoryContexts,
                  noChangeRetryUsed,
                );
            if (noChangeAction === "retry") {
              console.warn(
                "[agent] research declared no_change_needed despite pending PR review feedback; retrying research once with a corrective note",
              );
              noChangeRetryUsed = true;
              continue;
            }
            if (noChangeAction === "fail") {
              return executionError(
                "research declared no change needed but the ticket's PR has unresolved human review feedback; refusing the no_change_needed exit",
                { category: "engine", phase: "research" },
              );
            }
            if (noChangeAction === "no_change") {
              // Ticket-bound side effects only, exactly like the terminate
              // dispatch: an uncorrelated entry has no ticket to comment on,
              // move, or notify about.
              if (entry.ticketKey) {
                const evidenceCommentUrl = await postTicketComment(
                  ticket.identifier,
                  ledgerGate?.kind === "no_change"
                    ? ledgerGate.comment
                    : buildResolutionEvidenceComment(research),
                  transitionOwner,
                );
                // terminal_success skips the downstream cone, so the graph's own
                // update_ticket_status node never runs. Dispatch has no
                // post-success dedup: a ticket left in the AI column would be
                // redispatched, so replay that node's configured move here.
                // Graphs without such a node do not move on normal success
                // either, so they do not move here. Only for a run the column
                // dispatched: see entryNeedsTicketStatusReplay.
                const statusNode = entryNeedsTicketStatusReplay(entry)
                  ? ctx.definitionNodes.find(
                      (candidate) => candidate.type === "update_ticket_status",
                    )
                  : undefined;
                if (statusNode) {
                  const targetName = resolveTicketStatusInput(statusNode.params, {});
                  const target = resolveTicketMoveTarget(targetName, {
                    backlog: backlogMoveTarget(),
                    aiReview: aiReviewMoveTarget(),
                  });
                  // Same self-move race as the real block: commit the run's
                  // success before the move fires the "ticket left the AI
                  // column" webhook.
                  if (targetName === "ai_review") {
                    await markRunSucceededOnSelfMoveStep(workflowRunId);
                  }
                  await moveTicketStep(entry.ticketKey, target, transitionOwner);
                }
                const note =
                  ledgerGate?.kind === "no_change"
                    ? // "Answered" only when something really was answered: a
                      // run whose threads all wait on a human replied to none.
                      (ctx.reviewLedger?.verification?.accepted.length ?? 0) > 0
                      ? "Answered the open review threads, no code changes needed."
                      : "No open review thread needed an answer, no code changes made."
                    : "Ticket already resolved, no code changes needed.";
                await notifyTicket(
                  ticket.identifier,
                  {
                    kind: "note",
                    text: evidenceCommentUrl
                      ? `${note} Evidence: ${evidenceCommentUrl}`
                      : note,
                  },
                  transitionOwner,
                );
              }
              return {
                kind: "terminal_success",
                output: {
                  status: "no_change_needed",
                  plan: research.body,
                  evidence: research.resolutionEvidence ?? [],
                  ...(ledgerGate?.kind === "no_change"
                    ? { reviewLedgerSettled: ledgerGate.settled }
                    : {}),
                },
              };
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
            return {
              kind: "next",
              output: {
                status: "ready",
                plan: research.body,
                ...reviewLedgerOutputFields(ctx),
              },
            };
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
              const implClarificationDecision = execution?.observations && result.ok
                ? await resolveClarificationDecisionObservation({
                    status: result.value.result,
                    questions: result.value.questions,
                    suggestedAnswers: result.value.suggestedAnswers,
                    ticketValue: implementationContext.ticket,
                    contextValue: implementationContext.repositoryContexts,
                    harnessProfileHash: runtime?.manifestHash ?? null,
                  })
                : undefined;
              await emitAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: implementationArtifactPhase,
                artifacts: implArtifacts,
                usage: implUsage,
                result,
                ...(implClarificationDecision
                  ? { clarificationDecision: implClarificationDecision }
                  : {}),
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
              // Last point before finalize publishes: re-check the quotes the
              // planner promised against the tree this run actually produced.
              const ledgerRepoPath = reviewLedgerRepoLocalPath(ctx);
              await runLedgerEvidenceSecondPass(ctx.reviewLedger, (filePath) =>
                ledgerRepoPath
                  ? readLedgerEvidenceFileStep(sandboxId, ledgerRepoPath, filePath)
                  : Promise.resolve(null),
              );
              return {
                kind: "next",
                output: {
                  ...buildImplementationAgentSuccessOutput({
                    workspaceId: sandboxId,
                    workspaceManifest: ctx.workspaceManifest,
                    commits: workspaceState.commits,
                    summary: implOutput.summary,
                  }),
                  ...reviewLedgerOutputFields(ctx),
                },
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

              return reviewAgentExecutionResult(
                ctx.schemaVersion,
                reviewOutput,
                ctx.workspaceManifest,
              );
            } finally {
              await teardownSandboxes([sandboxId]);
            }
          }

          case "run_pre_pr_checks": {
            if (!ctx.sandboxId) return noWorkspace(node.type);
            // node.params.maxFixCycles is deliberately not read. The repair loop
            // it bounded is gone: it hid failing checks behind an agent's edits
            // and could not tell a broken environment from broken code. The
            // parameter stays accepted by the schema so every definition
            // deployed with it keeps validating, and is ignored here.
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
            const repairKind =
              repairRuntime?.manifest.harness.provider ??
              state.implementationKind ??
              runDefaultKind;
            const repairModel =
              repairRuntime?.manifest.model.id ??
              state.implementationModel;
            const budget = await ctx.observeBudget();
            if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
            // Loading the configuration is a step; running the checks is not.
            // They are launched detached and polled across ticks, because a
            // client tenant's real checks outlive the 300s one function
            // invocation gets and used to kill the run with no recoverable
            // cause. See workflows/blocks/pre-pr-checks.ts.
            const prePrConfig = await loadPrePrCheckConfigStep();
            let prePrChecks: PrePrCheckRunResult;
            try {
              prePrChecks = await runPrePrChecksWithFixes({
                sandboxId: ctx.sandboxId,
                config: prePrConfig.config,
                agentKind: repairKind,
                model: repairModel,
                observeBudget: blockBudgetObserver(ctx, execution),
                observeChecksBudget: blockBudgetObserver(ctx, execution, {
                  attribution: "checks",
                }),
                ...checksCeilingOption(steps),
                cancellation: execution?.cancellation,
                ...(execution?.observations
                  ? { observations: execution.observations }
                  : {}),
                budget: {
                  state: budgetState,
                  limits: budgetLimits,
                  price: priceLookup?.(repairModel) ?? null,
                },
                runtime: repairRuntime,
                arthurTaskId: ctx.arthur.taskId,
              });
            } catch (err) {
              if (isRunControlError(err)) throw err;
              const after = await ctx.observeBudget();
              if (after.check.status !== "ok") throw new RunBudgetError(after.check);
              if (isDurationAbortError(err)) {
                throw new RunBudgetError(durationBudgetFailure(after, "Pre-PR checks"));
              }
              // Everything prePrChecksFailureMustPropagate covers has already
              // left through the two branches above, so what remains cannot
              // have an identity that wrapping destroys. It must still be
              // wrapped: the checks are no longer a step, so an unbounded,
              // unredacted throw would travel from workflow scope straight to
              // the operator, and before #316 that arrived as Workflow's own
              // "exceeded max retries" with no name, no message and nothing in
              // the runtime logs.
              throw new Error(await prePrChecksFailureMessage(err, prePrConfig.version));
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
            const gateOutput = repositoryScriptsOutput(prePrChecks);
            if (!prePrChecks.passed) {
              return {
                kind: "next",
                output: {
                  status: repositoryScriptsStatus(gateOutput),
                  ...gateOutput,
                  // Always 0. Still emitted because definitions deployed against
                  // this contract bind steps.checks.output.fixCycles.
                  fixCycles: prePrChecks.fixCycles,
                },
              };
            }
            if (prePrConfig.version !== null && ctx.workspaceManifest) {
              ctx.prePrGate = await recordSuccessfulWorkspaceGate({
                sandboxId: ctx.sandboxId,
                workspaceManifest: ctx.workspaceManifest,
                configurationVersion: prePrConfig.version,
              });
            }
            return {
              kind: "next",
              output: {
                status: repositoryScriptsStatus(gateOutput),
                ...gateOutput,
                fixCycles: prePrChecks.fixCycles,
                // Durably checkpoint the gate alongside the pass so finalize can
                // recover it when the ephemeral ctx.prePrGate is lost on a cold
                // scheduler resume. Same value just recorded to ctx.prePrGate;
                // spread into a plain JSON object for the BlockOutput contract.
                // recoverPrePrGateFromSteps keys on this outcome+gate pair, so
                // neither key may move.
                gate: ctx.prePrGate
                  ? {
                      configurationVersion: ctx.prePrGate.configurationVersion,
                      fingerprint: ctx.prePrGate.fingerprint,
                    }
                  : null,
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
          activeBlockIds.add(nodeId);
          syncCurrentBlockId();
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
          syncCurrentBlockId();
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

      // Awaited, not detached. These hooks write durable steps, so letting them
      // land whenever the event loop allows put them at a different position on
      // replay than in the original run, which is a replay divergence and takes
      // the whole run down (AIW-251). The hooks swallow their own write
      // failures, so awaiting them costs ordering only, never the run.
      const v2Hooks: V2SchedulerHooks = {
        async onTriggerActivated(event) {
          await v2RunObservation?.onTriggerActivated?.(event);
        },
        async onNodeStart(event) {
          await hooks.onBlockStart(event.nodeId, event.attempt);
          await v2RunObservation?.onNodeStart?.(event);
        },
        async onNodeWaiting(event) {
          await v2RunObservation?.onNodeWaiting?.(event);
        },
        async onNodeFinish(event) {
          await v2RunObservation?.onNodeFinish?.(event);
          await hooks.onBlockFinish(event.nodeId, event.state);
        },
        async onNodeSkipped(event) {
          await v2RunObservation?.onNodeSkipped?.(event);
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
            // V2_MAX_BLOCK_CONCURRENCY in env.ts for what it is for and what
            // concurrent dispatch here depends on staying true.
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
          failureExitPhase(terminalExecutionError),
          formatExecutionErrorForUser(terminalExecutionError),
          terminalExecutionError.nodeId,
          // The v2 walk's own steps, so the failure comment can read the
          // repository scripts output back out of them exactly as the v1
          // interpreter path does.
          walk.steps,
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
