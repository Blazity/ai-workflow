import { z } from "zod";
import type {
  JsonValue,
  WorkflowDefinitionNode,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type {
  AgentOutput,
  AgentProtocolResult,
  CollectedPhaseArtifacts,
  PhaseArtifactPaths,
  PhaseUsage,
} from "../../sandbox/agents/types.js";
import type { CheckRunResult, PRComment } from "../../adapters/vcs/types.js";
import type { WorkspaceManifestV2 } from "../../sandbox/repo-workspace.js";
import type { PrTriggerPayload } from "../agent-input.js";
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import {
  buildReviewLedgerDurableState,
  buildReviewLedgerGuardSummary,
  selectWorkItems,
  verifyDispositions,
  type ReviewLedgerGuardSummary,
} from "../review-ledger.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";
import { isRunControlError } from "../run-control-error.js";
import { pollPhaseUntilDone, stopPhaseCommand } from "./poll-phase.js";
import {
  emitAgentInvocationObservations,
  emitTimedOutAgentInvocationObservations,
} from "../../run-observability/agent-observations.js";
import { resolveAgentInput } from "../resolve-agent-input.js";
import { prepareHarnessAgentInvocationStep } from "./agent-sandbox.js";
import {
  ensureWorkspace,
  maybePromoteTicketWorkspaceWrites,
} from "./prepare-workspace.js";
import {
  inspectFixWorkspace,
  restoreReadOnlyFixRepositories,
  resolvedFixConflicts,
  type FixWorkspaceState,
} from "./fix-workspace-state.js";
import {
  agentArtifactPhase,
  blockBudgetObserver,
  executionError,
  agentProtocolExecutionError,
  markBlockPhaseLaunched,
  recordBlockPhaseUsage,
  sanitizeBlockId,
  type BlockExecuteFn,
  type BlockExecutionResult,
  type EngineCtx,
} from "./types.js";
import {
  appendReviewFeedbackComment,
  resolveReviewFeedbackInput,
  type ReviewFeedback,
} from "../review-feedback.js";
import {
  normalizeReviewResultsInput,
  type ReviewResultsResolution,
} from "../review-results.js";

export const paramsSchema = z
  .object({
    provider: z.enum(["claude", "codex"]).optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:\/-]+$/).optional(),
    instructions: z.string().trim().max(4000).optional(),
    maxMinutes: z.number().int().min(5).max(60).default(25),
  })
  .strict();

const DEFAULT_MAX_MINUTES = 25;
const usageLabel = (blockId: string) => `Fix ${blockId}`;

function actionableReviewResults(
  reviewResults: Extract<ReviewResultsResolution, { ok: true }>["value"],
  workspaceManifest: WorkspaceManifestV2 | null,
): Extract<ReviewResultsResolution, { ok: true }>["value"] {
  if (!reviewResults || !workspaceManifest) return reviewResults;
  const writableRepositories = new Set(
    workspaceManifest.repositories
      .filter((repository) => repository.access === "write")
      .map((repository) => repository.repoPath),
  );
  return reviewResults.map((result) => {
    const findings = result.findings.filter(
      (finding) =>
        finding.repo === undefined || writableRepositories.has(finding.repo),
    );
    const removedReadOnlyFindings = findings.length !== result.findings.length;
    const requestChanges = findings.some(
      (finding) => finding.severity === "Blocker" || finding.severity === "High",
    );
    return {
      decision: requestChanges ? "request_changes" : "approve",
      findings,
      ...(!removedReadOnlyFindings && result.feedback
        ? { feedback: result.feedback }
        : {}),
    };
  });
}

async function assertFixPrOwnershipStep(pr: PrTriggerPayload, runId: string): Promise<void> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { findRunPrSiblings } = await import("../../db/queries/run-pr-siblings.js");
  const lookup = await findRunPrSiblings({
    db: getDb(),
    provider: pr.provider,
    repoPath: pr.repoPath,
    prNumber: pr.prNumber,
  });
  if (lookup.status === "unknown") {
    throw new Error(
      `Refusing to push a fix for ${pr.provider}:${pr.repoPath}#${pr.prNumber}: workflow PR ownership is unknown (${lookup.reason}).`,
    );
  }
  if (
    lookup.current.provider !== pr.provider ||
    lookup.current.repoPath !== pr.repoPath ||
    lookup.current.id !== pr.prNumber
  ) {
    throw new Error(
      `Refusing to push a fix for ${pr.provider}:${pr.repoPath}#${pr.prNumber}: the PR is not present in a workflow publication.`,
    );
  }
  void runId;
}

type PrFixPublicationInput = {
  sandboxId: string;
  workspaceManifest: WorkspaceManifestV2;
  subjectKey: string;
  ownerToken: string;
  runId: string;
  repositoryScope?: WorkflowRepositoryScope;
  pr: PrTriggerPayload;
  /** Head this publication will create, registered before the push so the
   *  provider's own synchronize event is recognised as ours. */
  intendedHead?: string;
  /** Narrow ledger view that lets a run which answered every thread without
   *  writing code publish nothing and still succeed. */
  reviewLedger?: ReviewLedgerGuardSummary;
};

export function buildPrFixPublicationInput(
  ctx: Parameters<BlockExecuteFn>[2],
  sandboxId: string,
  workspace?: FixWorkspaceState,
): PrFixPublicationInput | null {
  if (ctx.workspaceManifest?.version !== 2 || ctx.entry.kind !== "pr_trigger") {
    return null;
  }
  const pr = ctx.entry.pr;
  // The last commit this workspace holds for the reviewed repository is the head
  // the push will create, so anti-recursion can be armed before pushing.
  const intendedHead = workspace?.commits
    .filter(
      (commit) => commit.provider === pr.provider && commit.repoPath === pr.repoPath,
    )
    .at(-1)?.sha;
  const reviewLedger = ctx.reviewLedger
    ? buildReviewLedgerGuardSummary(ctx.reviewLedger)
    : null;
  return {
    sandboxId,
    workspaceManifest: ctx.workspaceManifest,
    subjectKey: ctx.entry.subjectKey,
    ownerToken: ctx.entry.ownerToken,
    runId: ctx.runId,
    repositoryScope: ctx.repositoryScope,
    pr,
    ...(intendedHead ? { intendedHead } : {}),
    ...(reviewLedger ? { reviewLedger } : {}),
  };
}

async function publishPrFixStep(input: PrFixPublicationInput): Promise<void> {
  "use step";
  if (input.intendedHead) {
    const { getDb } = await import("../../db/client.js");
    const { recordWorkflowOwnedPullRequestPublishedHead } = await import(
      "../../db/queries/workflow-owned-branches.js"
    );
    await recordWorkflowOwnedPullRequestPublishedHead(getDb(), {
      provider: input.pr.provider,
      repoPath: input.pr.repoPath,
      prNumber: input.pr.prNumber,
      headSha: input.intendedHead,
    });
  }
  const { publishTrustedWorkspaceFromSandbox } = await import(
    "../../sandbox/trusted-workspace-publisher.js",
  );
  const result = await publishTrustedWorkspaceFromSandbox({
    sourceSandboxId: input.sandboxId,
    workspaceManifest: input.workspaceManifest,
    subjectKey: input.subjectKey,
    ownerToken: input.ownerToken,
    runId: input.runId,
    repositoryScope: input.repositoryScope,
    ...(input.reviewLedger ? { reviewLedger: input.reviewLedger } : {}),
  });
  if (result.error) throw new Error(`Fix push failed: ${result.error}`);
  const failedRepository = result.repositories.find(
    (repository) => repository.failureKind !== undefined,
  );
  if (failedRepository) {
    throw new Error(
      `Fix push failed for ${failedRepository.provider}:${failedRepository.repoPath}: ${failedRepository.error ?? failedRepository.failureKind}.`,
    );
  }

  const { getDb } = await import("../../db/client.js");
  const {
    findWorkflowOwnedPullRequestIdentity,
    upsertWorkflowOwnedBranch,
  } = await import("../../db/queries/workflow-owned-branches.js");
  for (const repository of result.repositories) {
    if (
      repository.provider !== input.pr.provider ||
      repository.repoPath !== input.pr.repoPath
    ) {
      continue;
    }
    if (!repository.pushed || !repository.pushedHead) continue;
    const owned = await findWorkflowOwnedPullRequestIdentity(getDb(), {
      provider: repository.provider,
      repoPath: repository.repoPath,
      prNumber: input.pr.prNumber,
    });
    if (!owned?.pr) continue;
    await upsertWorkflowOwnedBranch(getDb(), {
      ticketKey: owned.ticketKey,
      provider: repository.provider,
      repoPath: repository.repoPath,
      branchName: repository.branchName,
      publishedHeadSha: repository.pushedHead,
      targetBranch: repository.defaultBranch,
      pr: owned.pr,
    });
  }
}

async function blockFixAgentCommitGuardStep(
  sandboxId: string,
  agentKind: AgentKind,
  enabled: boolean,
  runtime?: ResolvedHarnessRuntime,
): Promise<AgentProtocolResult<void>> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const agent = createAgentAdapter(agentKind, runtime?.cliSpec);
  try {
    await agent.setCommitGuard(sandbox, enabled, runtime?.paths);
    return { ok: true, value: undefined };
  } catch (error) {
    const { isAgentRuntimeError } = await import("../../sandbox/agents/runtime-error.js");
    if (!isAgentRuntimeError(error)) throw error;
    return {
      ok: false,
      category: error.category,
      message: error.safeMessage,
      diagnostic: error.diagnostic,
    };
  }
}

async function blockFixAgentPlanPhaseStep(
  agentKind: AgentKind,
  phase: string,
  model: string,
  jsonSchema: string,
  runtime?: ResolvedHarnessRuntime,
): Promise<{ paths: PhaseArtifactPaths; script: string }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind, runtime?.cliSpec);
  const paths = adapter.artifactPaths(phase);
  const script = adapter.buildPhaseScript({
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

async function blockFixAgentStartPhaseStep(
  sandboxId: string,
  agentKind: AgentKind,
  phase: string,
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
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const { commandProtocolFailure, protocolFailure } = await import(
    "../../sandbox/agents/protocol.js"
  );
  const spec = createAgentAdapter(agentKind, runtime?.cliSpec).cliSpec;
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../../sandbox/credentials.js");

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
    const { isRunControlError } = await import("../run-control-error.js");
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
blockFixAgentStartPhaseStep.maxRetries = 0;

/** Same bound and reasoning as the planning path: an evidence quote is short,
 * and the whole content lands in a durable step output. */
const FIX_EVIDENCE_MAX_BYTES = 200_000;

/**
 * Read a repository file out of the fix workspace so an already_addressed claim
 * can be checked against the tree this block is about to publish. Working tree
 * first, then the committed HEAD.
 */
async function blockFixAgentReadEvidenceFileStep(
  sandboxId: string,
  repoLocalPath: string,
  filePath: string,
): Promise<string | null> {
  "use step";
  // The path comes from the model, so it never leaves the repository it named.
  if (
    filePath.length === 0 ||
    filePath.startsWith("/") ||
    filePath.split("/").includes("..")
  ) {
    return null;
  }
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const worktree = await sandbox.runCommand("cat", [`${repoLocalPath}/${filePath}`]);
  if (worktree.exitCode === 0) {
    return (await worktree.stdout()).slice(0, FIX_EVIDENCE_MAX_BYTES);
  }
  const head = await sandbox.runCommand("git", [
    "-C",
    repoLocalPath,
    "show",
    `HEAD:${filePath}`,
  ]);
  if (head.exitCode !== 0) return null;
  return (await head.stdout()).slice(0, FIX_EVIDENCE_MAX_BYTES);
}

/** Checkout path of the reviewed repository, or null when this run has no PR
 * repository in a trusted V2 workspace. */
function fixLedgerRepoLocalPath(ctx: EngineCtx): string | null {
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
 * Verify the fix agent's per-thread dispositions and stamp the verdict onto the
 * ledger, so the publish guard and the settler in finalize read the same thing.
 *
 * Unlike the planning path this is a single pass: the fix agent decides and
 * implements in one phase, so the tree it is verified against is already the
 * tree about to be published. That also makes the accepted already_addressed
 * quotes the second-pass answer, which is why they are recorded here.
 */
async function verifyFixReviewDispositions(
  ctx: EngineCtx,
  sandboxId: string,
  output: AgentOutput,
): Promise<string | null> {
  const ledger = ctx.reviewLedger;
  if (!ledger) return null;
  const workItems = selectWorkItems(ledger.feed);
  if (workItems.length === 0) return null;
  const repoLocalPath = fixLedgerRepoLocalPath(ctx);
  const dispositions = (output.reviewThreads ?? []).map((entry) => ({
    alias: entry.alias,
    disposition: entry.disposition,
    ...(entry.reply != null ? { reply: entry.reply } : {}),
    ...(entry.evidence != null ? { evidence: entry.evidence } : {}),
  }));
  const verification = await verifyDispositions({
    workItems,
    dispositions,
    readFile: (filePath) =>
      repoLocalPath
        ? blockFixAgentReadEvidenceFileStep(sandboxId, repoLocalPath, filePath)
        : Promise.resolve(null),
    // The prompt shows awaiting-human and third party threads as context, so an
    // answer to one is a confused model, not an invented thread. Rejecting it
    // would fail a run that answered everything it actually owed.
    contextAliases: ledger.feed.threads
      .filter((thread) => !workItems.includes(thread))
      .map((thread) => thread.alias),
  });
  ledger.dispositions = dispositions;
  ledger.verification = verification;
  // The fix loop has no separate research phase, so nothing declared writes:
  // the commits themselves are the declaration.
  ledger.researchDeclaresWrites = false;
  ledger.evidencePresentThreadIds = verification.accepted
    .filter(
      (disposition) =>
        disposition.disposition === "already_addressed" &&
        // Salvaged from an unreadable tree, so no quote was ever compared here.
        !disposition.evidenceUnverified,
    )
    .map((disposition) => disposition.threadId)
    .filter((threadId): threadId is string => typeof threadId === "string");
  console.log(
    JSON.stringify({
      event: "review_ledger",
      workItems: workItems.length,
      truncated: ledger.feed.truncated,
      rejected: verification.rejected.length,
      accepted: verification.accepted.length,
    }),
  );
  if (verification.accepted.length > 0) return null;
  // Threads were open and not one answer survived: the model either skipped the
  // field or invented every claim. Failing here, before the push, keeps the run
  // from ending green with the reviewer's requests silently dropped. The
  // threads stay open and the next run sees them again.
  // A thread the agent ignored entirely is rejected as "no disposition", so the
  // rejection list already distinguishes a missing answer from a false one.
  const detail = verification.rejected
    .map((entry) => `${entry.alias} (${entry.reason})`)
    .join(", ");
  const aliases = workItems.map((thread) => thread.alias).join(", ");
  return `review ledger: no disposition survived verification for ${aliases}${detail ? `; ${detail}` : ""}`;
}

async function blockFixAgentParseStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: string,
  runtime?: ResolvedHarnessRuntime,
): Promise<{ result: AgentProtocolResult<AgentOutput>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind, runtime?.cliSpec);
  return {
    result: adapter.parseAgentOutputProtocol(artifacts, phase),
    usage: adapter.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

async function buildFixInput(
  block: WorkflowDefinitionNode,
  ctx: EngineCtx,
  reviewFeedback: ReviewFeedback | undefined,
  reviewResults: Extract<ReviewResultsResolution, { ok: true }>["value"],
  includeInstructions = true,
): Promise<string> {
  const { assembleFixContext } = await import("../../sandbox/context.js");

  let prComments: PRComment[] = ctx.repositoryContexts.flatMap(
    (context) => context.prComments,
  );
  const failedChecks: CheckRunResult[] = ctx.repositoryContexts.flatMap(
    (context) => context.checkResults,
  );
  const conflictRepos = ctx.repositoryContexts
    .filter((context) => context.hasConflicts)
    .map((context) => `${context.repository.provider}:${context.repository.repoPath}`);

  if (ctx.entry.kind === "pr_trigger") {
    const pr = ctx.entry.pr;
    for (const check of pr.failedChecks ?? []) {
      failedChecks.push({
        name: check.name,
        status: "completed",
        conclusion: check.conclusion,
        ...(check.detailsUrl ? { logs: `Details: ${check.detailsUrl}` } : {}),
      });
    }
  }
  prComments = appendReviewFeedbackComment(prComments, reviewFeedback);

  const instructions =
    includeInstructions &&
    typeof block.params.instructions === "string" &&
    block.params.instructions.trim().length > 0
      ? block.params.instructions.trim()
      : undefined;

  return assembleFixContext({
    ticket: { ...ctx.ticket, ...(ctx.clarifications ? { clarifications: ctx.clarifications } : {}) },
    prComments,
    failedChecks,
    ...(reviewResults ? { reviewResults } : {}),
    ...(conflictRepos.length > 0
      ? {
          conflictNotes: `These repositories have merge conflicts: ${conflictRepos.join(", ")}. Resolve the conflict markers, stage the files, and continue the merge in each repository.`,
        }
      : {}),
    ...(instructions ? { instructions } : {}),
    repositories: ctx.selectedRepositories,
    ...(ctx.workspaceManifest ? { workspaceManifest: ctx.workspaceManifest } : {}),
    // With the ledger on, the aliased thread feed replaces the flat comment
    // list, so the agent answers identified threads instead of a transcript.
    ...(ctx.reviewLedger ? { reviewThreads: ctx.reviewLedger.feed } : {}),
  });
}

/**
 * fix_agent: run one agent phase that addresses PR review feedback, failing
 * checks, and merge conflicts on the existing workspace. Context comes from
 * ctx.repositoryContexts (kept fresh by prepare_workspace / fetch_pr_context)
 * plus the pr_trigger entry payload. The phase label embeds the sanitized block
 * id so artifact paths stay unique per block.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
  execution,
): Promise<BlockExecutionResult> => {
  if (ctx.schemaVersion === 2 && ctx.entry.kind === "pr_trigger") {
    try {
      await assertFixPrOwnershipStep(ctx.entry.pr, ctx.runId);
    } catch (error) {
      if (isRunControlError(error)) throw error;
      return executionError(error instanceof Error ? error.message : String(error), {
        category: "provider",
        phase: "fix-pr-ownership",
      });
    }
  }
  const workspace = await ensureWorkspace(ctx, execution);
  if (workspace.kind !== "next") return workspace;
  // A fix block on a ticket graph without a planning node runs on an all-read
  // workspace; promote it so the committed fix can publish. No-op for pr_trigger
  // (Part 1 provisioned the owned branch write) and for planning graphs.
  const promotion = await maybePromoteTicketWorkspaceWrites(ctx, execution);
  if (promotion) return promotion;
  if (!ctx.sandboxId) {
    return executionError("workspace was not attached", { category: "sandbox" });
  }
  const sandboxId = ctx.sandboxId;
  const runtime =
    ctx.schemaVersion === 2 ? ctx.harnessRuntimes[block.id] : undefined;
  if (ctx.schemaVersion === 2 && !runtime) {
    return executionError("The pinned Harness Profile could not be resolved.", {
      category: "schema",
    });
  }
  const { kind, model } = runtime
    ? {
        kind: runtime.manifest.harness.provider,
        model: runtime.manifest.model.id,
      }
    : resolveBlockAgent(block.params, ctx.runDefaultKind, ctx.defaults);
  const maxMinutes =
    typeof block.params.maxMinutes === "number" ? block.params.maxMinutes : DEFAULT_MAX_MINUTES;
  const phase = agentArtifactPhase(`fix-${sanitizeBlockId(block.id)}`, execution);
  let launchedCommandId: string | null = null;
  let cleanupAttempted = false;
  const cleanupLaunchedPhase = async (): Promise<void> => {
    if (cleanupAttempted || launchedCommandId === null) return;
    cleanupAttempted = true;
    await stopPhaseCommand(sandboxId, launchedCommandId);
    if (ctx.workspaceManifest?.version === 2) {
      await restoreReadOnlyFixRepositories(sandboxId, ctx.workspaceManifest);
    }
  };

  try {
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
    const reviewResults = normalizeReviewResultsInput(
      resolvedInputs.reviewResults,
      ctx.schemaVersion === 2
        ? {
            knownRepositories: ctx.selectedRepositories.map(
              (repository) => repository.repoPath,
            ),
          }
        : {},
    );
    if (!reviewResults.ok) {
      return executionError("invalid reviewResults binding", {
        category: "binding",
        message: reviewResults.message,
      });
    }
    const fixReviewResults = actionableReviewResults(
      reviewResults.value,
      ctx.workspaceManifest?.version === 2 ? ctx.workspaceManifest : null,
    );
    const before = await inspectFixWorkspace(sandboxId);
    const fallbackInput = await buildFixInput(
      block,
      ctx,
      reviewFeedback.value,
      fixReviewResults,
      execution?.compileEffectivePrompt === undefined,
    );
    const resolvedInput = await resolveAgentInput({
      compileEffectivePrompt: execution?.compileEffectivePrompt,
      blockPrompt:
        typeof block.params.instructions === "string"
          ? block.params.instructions
          : "",
      runtimeData: fallbackInput,
      fallbackInput,
      sandboxId,
    });
    if (!resolvedInput.ok) return resolvedInput.result;
    const input = resolvedInput.input;
    const { AGENT_SCHEMA } = await import("../../sandbox/agents/types.js");

    const preparedRuntime = await prepareHarnessAgentInvocationStep(
      sandboxId,
      kind,
      model,
      ctx.arthur.taskId,
      runtime,
    );
    if (!preparedRuntime.ok) {
      return agentProtocolExecutionError(preparedRuntime);
    }
    const guard = await blockFixAgentCommitGuardStep(
      sandboxId,
      kind,
      true,
      runtime,
    );
    if (!guard.ok) return agentProtocolExecutionError(guard);
    const { paths, script } = await blockFixAgentPlanPhaseStep(
      kind,
      phase,
      model,
      AGENT_SCHEMA,
      runtime,
    );
    const launch = await blockFixAgentStartPhaseStep(
      sandboxId,
      kind,
      phase,
      paths.input,
      input,
      paths.wrapper,
      script,
      runtime,
    );
    if (!launch.ok) return agentProtocolExecutionError(launch.failure);
    const commandId = launch.commandId;
    launchedCommandId = commandId;
    markBlockPhaseLaunched(ctx, usageLabel(block.id), execution);

    const done = await pollPhaseUntilDone(
      sandboxId,
      paths.sentinel,
      maxMinutes,
      commandId,
      blockBudgetObserver(ctx, execution),
      execution?.cancellation,
    );
    if (!done) {
      const { collectPhaseReplayDiagnostics } = await import(
        "../../sandbox/poll-agent.js"
      );
      await emitTimedOutAgentInvocationObservations({
        observations: execution?.observations,
        provider: kind,
        model,
        phase,
        collectArtifacts: () =>
          collectPhaseReplayDiagnostics(sandboxId, paths),
      });
      await cleanupLaunchedPhase();
      return executionError("fix phase timed out", { category: "timeout" });
    }

    const { collectPhase } = await import("../../sandbox/poll-agent.js");
    const artifacts = await collectPhase(sandboxId, paths);
    const { result, usage } = await blockFixAgentParseStep(
      kind,
      artifacts,
      phase,
      runtime,
    );
    await emitAgentInvocationObservations({
      observations: execution?.observations,
      provider: kind,
      model,
      phase,
      artifacts,
      usage,
      result,
    });
    recordBlockPhaseUsage(
      ctx,
      usageLabel(block.id),
      usage,
      model,
      execution,
    );
    await cleanupLaunchedPhase();
    if (!result.ok) return agentProtocolExecutionError(result);
    const output = result.value;
    const after = await inspectFixWorkspace(sandboxId);

    if (output.result === "clarification_needed") {
      const suppliedQuestions = (output.questions ?? []).filter((q) => q.trim().length > 0);
      const questions =
        suppliedQuestions.length > 0
          ? suppliedQuestions
          : ["The Fix Agent needs more information. What should it use to continue?"];
      const suggestedAnswers = (output.suggestedAnswers ?? []).filter(
        (s) => s.trim().length > 0,
      );
      return {
        kind: "needs_human_input",
        output: {
          status: "needs_human_input",
          ...workspaceStateFields(sandboxId, before, after),
          questions,
          ...(suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
        },
        questions,
        ...(suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
      };
    }
    if (output.result === "failed") {
      return executionError(output.error ?? "unknown", { category: "provider" });
    }
    if (after.unresolvedConflicts.length > 0) {
      const questions = [formatUnresolvedConflictQuestion(after)];
      return {
        kind: "needs_human_input",
        output: {
          status: "needs_human_input",
          ...workspaceStateFields(sandboxId, before, after),
          questions,
        },
        questions,
      };
    }
    // Before the push, so the publish guard sees a verified ledger and the
    // settler in finalize answers only claims that survived verification.
    const ledgerFailure = await verifyFixReviewDispositions(ctx, sandboxId, output);
    if (ledgerFailure) {
      return executionError(ledgerFailure, {
        category: "engine",
        phase: "review-ledger",
      });
    }
    if (output.result === "implemented") {
      const publicationInput = buildPrFixPublicationInput(ctx, sandboxId, after);
      if (publicationInput) await publishPrFixStep(publicationInput);
    }
    const durableLedger = ctx.reviewLedger
      ? buildReviewLedgerDurableState(ctx.reviewLedger)
      : null;
    return {
      kind: "next",
      output: {
        status: "fixed",
        ...workspaceStateFields(sandboxId, before, after),
        summary: output.summary?.slice(0, 2000) ?? "",
        // A cold resume rebuilds the context from step outputs, so without this
        // finalize would come back with no ledger and answer nothing.
        ...(durableLedger ? { reviewLedger: durableLedger } : {}),
      },
    };
  } catch (err) {
    try {
      await cleanupLaunchedPhase();
    } catch (cleanupError) {
      if (isRunControlError(err)) throw err;
      return executionError(
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        { category: "provider" },
      );
    }
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
    });
  }
};

function workspaceStateFields(
  sandboxId: string,
  before: FixWorkspaceState,
  after: FixWorkspaceState,
) {
  return {
    workspaceId: sandboxId,
    // Cumulative workspace commits since each repository's preAgentSha, not
    // merely commits created by this one Fix invocation. Downstream Finalize
    // therefore receives the complete unpublished publication set.
    commits: after.commits,
    resolvedConflicts: resolvedFixConflicts(before, after),
    unresolvedConflicts: after.unresolvedConflicts,
  };
}

function formatUnresolvedConflictQuestion(state: FixWorkspaceState): string {
  const details = state.unresolvedConflicts
    .map((repo) => `${repo.provider}:${repo.repoPath} (${repo.files.join(", ")})`)
    .join("; ");
  return `Merge conflicts remain in ${details}. How should they be resolved before publication?`;
}
