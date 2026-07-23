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
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import { isRunControlError } from "../run-control-error.js";
import { pollPhaseUntilDone } from "./poll-phase.js";
import { ensureWorkspace } from "./prepare-workspace.js";
import {
  inspectFixWorkspace,
  resolvedFixConflicts,
  type FixWorkspaceState,
} from "./fix-workspace-state.js";
import {
  executionError,
  agentProtocolExecutionError,
  sanitizeBlockId,
  type BlockExecuteFn,
  type BlockExecutionResult,
  type EngineCtx,
} from "./types.js";

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

async function blockFixAgentCommitGuardStep(
  sandboxId: string,
  agentKind: AgentKind,
  enabled: boolean,
): Promise<AgentProtocolResult<void>> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const agent = createAgentAdapter(agentKind);
  try {
    await agent.setCommitGuard(sandbox, enabled);
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
): Promise<{ paths: PhaseArtifactPaths; script: string }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind);
  const paths = adapter.artifactPaths(phase);
  const script = adapter.buildPhaseScript({ phase, model, paths, jsonSchema });
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
): Promise<
  | { ok: true; commandId: string }
  | { ok: false; failure: Extract<AgentProtocolResult<unknown>, { ok: false }> }
> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const { commandProtocolFailure, protocolFailure } = await import(
    "../../sandbox/agents/protocol.js"
  );
  const spec = createAgentAdapter(agentKind).cliSpec;
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
): Promise<{ result: AgentProtocolResult<AgentOutput>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind);
  return {
    result: adapter.parseAgentOutputProtocol(artifacts, phase),
    usage: adapter.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

async function buildFixInput(block: WorkflowDefinitionNode, ctx: EngineCtx): Promise<string> {
  const { assembleFixContext } = await import("../../sandbox/context.js");

  const prComments: PRComment[] = ctx.repositoryContexts.flatMap(
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
    if (pr.review) {
      prComments.push({ author: pr.review.author, body: pr.review.body, liked: false });
    }
  }

  const instructions =
    typeof block.params.instructions === "string" && block.params.instructions.trim().length > 0
      ? block.params.instructions.trim()
      : undefined;

  return assembleFixContext({
    ticket: { ...ctx.ticket, ...(ctx.clarifications ? { clarifications: ctx.clarifications } : {}) },
    prComments,
    failedChecks,
    ...(conflictRepos.length > 0
      ? {
          conflictNotes: `These repositories have merge conflicts: ${conflictRepos.join(", ")}. Resolve the conflict markers, stage the files, and continue the merge in each repository.`,
        }
      : {}),
    ...(instructions ? { instructions } : {}),
    repositories: ctx.selectedRepositories,
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
  _resolvedInputs,
  execution,
): Promise<BlockExecutionResult> => {
  const workspace = await ensureWorkspace(ctx, execution);
  if (workspace.kind !== "next") return workspace;
  if (!ctx.sandboxId) {
    return executionError("workspace was not attached", { category: "sandbox" });
  }
  const sandboxId = ctx.sandboxId;
  const { kind, model } = resolveBlockAgent(block.params, ctx.runDefaultKind, ctx.defaults);
  const maxMinutes =
    typeof block.params.maxMinutes === "number" ? block.params.maxMinutes : DEFAULT_MAX_MINUTES;
  const phase = `fix-${sanitizeBlockId(block.id)}`;

  try {
    const before = await inspectFixWorkspace(sandboxId);
    const input = await buildFixInput(block, ctx);
    const { AGENT_SCHEMA } = await import("../../sandbox/agents/types.js");

    const guard = await blockFixAgentCommitGuardStep(sandboxId, kind, true);
    if (!guard.ok) return agentProtocolExecutionError(guard);
    const { paths, script } = await blockFixAgentPlanPhaseStep(kind, phase, model, AGENT_SCHEMA);
    const launch = await blockFixAgentStartPhaseStep(
      sandboxId,
      kind,
      phase,
      paths.input,
      input,
      paths.wrapper,
      script,
    );
    if (!launch.ok) return agentProtocolExecutionError(launch.failure);
    const commandId = launch.commandId;
    ctx.markLaunched(usageLabel(block.id));

    const done = await pollPhaseUntilDone(
      sandboxId,
      paths.sentinel,
      maxMinutes,
      commandId,
      ctx.observeBudget,
    );
    if (!done) {
      return executionError("fix phase timed out", { category: "timeout" });
    }

    const { collectPhase } = await import("../../sandbox/poll-agent.js");
    const artifacts = await collectPhase(sandboxId, paths);
    const { result, usage } = await blockFixAgentParseStep(kind, artifacts, phase);
    ctx.recordUsage(usageLabel(block.id), usage, model);
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
