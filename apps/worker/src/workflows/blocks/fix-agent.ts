import { z } from "zod";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type {
  AgentOutput,
  AgentProtocolResult,
  CollectedPhaseArtifacts,
  PhaseArtifactPaths,
  PhaseUsage,
} from "../../sandbox/agents/types.js";
import type { CheckRunResult, PRComment } from "../../adapters/vcs/types.js";
import type { PrTriggerPayload } from "../agent-input.js";
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";
import { isRunControlError } from "../run-control-error.js";
import { pollPhaseUntilDone } from "./poll-phase.js";
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

async function publishPrFixStep(input: {
  ctx: Parameters<BlockExecuteFn>[2];
  sandboxId: string;
}): Promise<void> {
  "use step";
  if (input.ctx.workspaceManifest?.version !== 2 || input.ctx.entry.kind !== "pr_trigger") {
    return;
  }
  const { publishTrustedWorkspaceFromSandbox } = await import(
    "../../sandbox/trusted-workspace-publisher.js",
  );
  const result = await publishTrustedWorkspaceFromSandbox({
    sourceSandboxId: input.sandboxId,
    workspaceManifest: input.ctx.workspaceManifest,
    subjectKey: input.ctx.entry.subjectKey,
    ownerToken: input.ctx.entry.ownerToken,
    runId: input.ctx.runId,
    repositoryScope: input.ctx.repositoryScope,
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
      repository.provider !== input.ctx.entry.pr.provider ||
      repository.repoPath !== input.ctx.entry.pr.repoPath
    ) {
      continue;
    }
    if (!repository.pushed || !repository.pushedHead) continue;
    const owned = await findWorkflowOwnedPullRequestIdentity(getDb(), {
      provider: repository.provider,
      repoPath: repository.repoPath,
      prNumber: input.ctx.entry.pr.prNumber,
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
    const before = await inspectFixWorkspace(sandboxId);
    const fallbackInput = await buildFixInput(
      block,
      ctx,
      reviewFeedback.value,
      reviewResults.value,
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
    if (output.result === "implemented") {
      await publishPrFixStep({ ctx, sandboxId });
    }
    return {
      kind: "next",
      output: {
        status: "fixed",
        ...workspaceStateFields(sandboxId, before, after),
        summary: output.summary?.slice(0, 2000) ?? "",
      },
    };
  } catch (err) {
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
