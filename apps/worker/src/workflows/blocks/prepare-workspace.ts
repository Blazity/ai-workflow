import { z } from "zod";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type { AgentProtocolResult } from "../../sandbox/agents/types.js";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { PreSandboxPromptAdditionsByTarget } from "../../pre-sandbox/types.js";
import type {
  WorkspaceManifest,
  WorkspaceRepositoryInput,
} from "../../sandbox/repo-workspace.js";
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import { isRunControlError } from "../run-control-error.js";
import { blockFetchPrContextsStep, blockPrTriggerRepositoriesStep } from "./fetch-pr-context.js";
import {
  agentProtocolExecutionError,
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";
import type { BlockExecutionContext } from "../../workflow-definition/interpreter.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";

export const paramsSchema = z.object({}).strict();

interface PreSandboxTicketContext {
  ticket: {
    identifier: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    comments: Array<{ author: string; body: string; createdAt?: string }>;
    labels: string[];
  };
  run: { branchName: string };
}

interface WorkspaceAgentRuntime {
  kind: AgentKind;
  model: string;
  runtime?: ResolvedHarnessRuntime;
}

type PreSandboxOutcome =
  | {
      status: "continue";
      promptAdditions?: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      questions?: string[];
      promptAdditions?: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
    };

async function blockPrepareWorkspacePreSandboxStep(
  context: PreSandboxTicketContext,
): Promise<PreSandboxOutcome> {
  "use step";
  const { runPreSandboxPhase } = await import("../../pre-sandbox/runner.js");
  return runPreSandboxPhase(context);
}
blockPrepareWorkspacePreSandboxStep.maxRetries = 0;

async function blockPrepareWorkspaceEnsureArthurTaskStep(
  taskName: string,
): Promise<string | null> {
  "use step";
  const { env } = await import("../../../env.js");
  if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) return null;

  const { logger } = await import("../../lib/logger.js");
  const { ArthurClient } = await import("../../sandbox/arthur-client.js");
  const client = ArthurClient.fromTraceEndpoint(
    env.GENAI_ENGINE_TRACE_ENDPOINT,
    env.GENAI_ENGINE_API_KEY,
  );
  try {
    const task = await client.ensureTaskForTicket(taskName);
    logger.info({ taskId: task.id, taskName: task.name }, "arthur_task_created");
    return task.id;
  } catch (err) {
    if (isRunControlError(err)) throw err;
    logger.warn({ err: (err as Error).message, taskName }, "arthur_task_create_failed");
    return null;
  }
}
blockPrepareWorkspaceEnsureArthurTaskStep.maxRetries = 0;

/** Ensure all sandboxes created by the run share its Arthur task when tracing
 * is configured, including repository-free Planning/Generic sandboxes. */
export async function ensureArthurTask(
  ctx: Parameters<BlockExecuteFn>[2],
): Promise<string | null> {
  if (ctx.arthur.taskId) return ctx.arthur.taskId;
  const taskId = await blockPrepareWorkspaceEnsureArthurTaskStep(ctx.ticket.identifier);
  ctx.arthur.taskId = taskId;
  return taskId;
}

async function blockPrepareWorkspaceProvisionStep(
  subjectKey: string,
  ownerToken: string,
  branchName: string,
  selectedRepositories: WorkspaceRepositoryInput[],
  arthurTaskId: string | null,
  requiredAgents: WorkspaceAgentRuntime[],
): Promise<
  | { ok: true; sandboxId: string; workspaceManifest: WorkspaceManifest }
  | { ok: false; failure: Extract<AgentProtocolResult<unknown>, { ok: false }> }
> {
  "use step";
  const { env } = await import("../../../env.js");
  const { SandboxManager } = await import("../../sandbox/manager.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const { buildSandboxProviderConfigs } = await import("../../lib/vcs-runtime.js");

  const arthur =
    env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT && arthurTaskId
      ? {
          apiKey: env.GENAI_ENGINE_API_KEY,
          taskId: arthurTaskId,
          endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
        }
      : undefined;

  for (const { kind, runtime } of requiredAgents) {
    const spec = createAgentAdapter(kind, runtime?.cliSpec).cliSpec;
    if (kind === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
      const { runtimePreparationError } = await import(
        "../../sandbox/agents/protocol.js"
      );
      const error = runtimePreparationError(
        spec,
        "Codex authentication credentials are missing from the deployed environment.",
      );
      return {
        ok: false,
        failure: {
          ok: false,
          category: error.category,
          message: error.safeMessage,
          diagnostic: error.diagnostic,
        },
      };
    }
    if (kind === "claude" && !env.ANTHROPIC_API_KEY) {
      const { runtimePreparationError } = await import(
        "../../sandbox/agents/protocol.js"
      );
      const error = runtimePreparationError(
        spec,
        "Claude authentication credentials are missing from the deployed environment.",
      );
      return {
        ok: false,
        failure: {
          ok: false,
          category: error.category,
          message: error.safeMessage,
          diagnostic: error.diagnostic,
        },
      };
    }
  }

  const configureOptsFor = async ({
    kind,
    model,
    runtime,
  }: WorkspaceAgentRuntime) => {
    if (!runtime) {
      return {
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        codexApiKey: env.CODEX_API_KEY,
        codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
        model,
        arthur,
      };
    }
    return {
      model: runtime.manifest.model.id,
      runtime: runtime.paths,
      legacyDynamicSkills: false,
    };
  };

  const [primary, ...rest] = requiredAgents;
  const additionalAgents = await Promise.all(
    rest.map(async (entry) => ({
      agent: createAgentAdapter(entry.kind, entry.runtime?.cliSpec),
      configureOpts: await configureOptsFor(entry),
      ...(entry.runtime ? { runtime: entry.runtime } : {}),
    })),
  );

  const manager = new SandboxManager({
    providers: await buildSandboxProviderConfigs(
      selectedRepositories.map((repo) => repo.provider),
    ),
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
  });

  try {
    const { sandbox, workspaceManifest } = await manager.provisionMultiRepo(
      { branchName, repositories: selectedRepositories },
      primary
        ? createAgentAdapter(primary.kind, primary.runtime?.cliSpec)
        : null,
      primary ? await configureOptsFor(primary) : null,
      additionalAgents,
      {
        onCreated: async (sandboxId) => {
          const { createStepAdapters } = await import("../../lib/step-adapters.js");
          await createStepAdapters().runRegistry.registerSandbox(
            subjectKey,
            ownerToken,
            sandboxId,
          );
        },
      },
      primary?.runtime,
    );
    return { ok: true, sandboxId: sandbox.sandboxId, workspaceManifest };
  } catch (error) {
    const { isAgentRuntimeError } = await import("../../sandbox/agents/runtime-error.js");
    if (isAgentRuntimeError(error)) {
      return {
        ok: false,
        failure: {
          ok: false,
          category: error.category,
          message: error.safeMessage,
          diagnostic: error.diagnostic,
        },
      };
    }
    throw error;
  }
}
blockPrepareWorkspaceProvisionStep.maxRetries = 0;

async function blockPrepareWorkspaceRegisterSandboxStep(
  subjectKey: string,
  ownerToken: string,
  sandboxId: string,
): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  await runRegistry.registerSandbox(subjectKey, ownerToken, sandboxId);
}

const CODE_WORKSPACE_AGENT_BLOCK_TYPES = new Set<string>([
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
]);

export function requiredAgentsForDefinition(input: {
  schemaVersion: 1 | 2;
  nodes: WorkflowDefinitionNode[];
  defaultKind: AgentKind;
  defaults: { claude: string; codex: string };
  harnessRuntimes: Readonly<Record<string, ResolvedHarnessRuntime>>;
}): WorkspaceAgentRuntime[] {
  if (input.schemaVersion === 1) {
    const kinds: AgentKind[] = [input.defaultKind];
    for (const node of input.nodes) {
      if (!CODE_WORKSPACE_AGENT_BLOCK_TYPES.has(node.type)) continue;
      if (node.type === "generic_agent" && node.params.workspaceMode === "none") {
        continue;
      }
      const resolved = resolveBlockAgent(
        node.params,
        input.defaultKind,
        input.defaults,
      );
      if (!kinds.includes(resolved.kind)) kinds.push(resolved.kind);
    }
    return kinds.map((kind) => ({
      kind,
      model: input.defaults[kind],
    }));
  }

  const runtimes = new Map<string, ResolvedHarnessRuntime>();
  for (const node of input.nodes) {
    if (!CODE_WORKSPACE_AGENT_BLOCK_TYPES.has(node.type)) continue;
    if (node.type === "generic_agent" && node.params.workspaceMode === "none") {
      continue;
    }
    const runtime = input.harnessRuntimes[node.id];
    if (!runtime) {
      throw new Error(
        `Harness Profile runtime for block "${node.id}" is unavailable.`,
      );
    }
    runtimes.set(runtime.manifestHash, runtime);
  }
  return [...runtimes.values()].map((runtime) => ({
    kind: runtime.manifest.harness.provider,
    model: runtime.manifest.model.id,
    runtime,
  }));
}

/**
 * prepare_workspace: select repositories (pre-sandbox phase for ticket entries,
 * the PR's repository for pr_trigger entries), prepare workflow-owned branches,
 * fetch PR contexts, ensure the run's Arthur task, provision one sandbox with
 * every agent CLI the definition can need, and register it for cleanup.
 * Mutates ctx.sandboxId, ctx.workspaceManifest, ctx.selectedRepositories,
 * ctx.repositoryContexts, ctx.preSandboxAdditions, and ctx.arthur.taskId (see
 * the EngineCtx mutation contract).
 */
export async function ensureWorkspace(
  ctx: Parameters<BlockExecuteFn>[2],
  execution?: BlockExecutionContext,
): Promise<BlockExecutionResult> {
  if (ctx.sandboxId) {
    try {
      // Re-assert the durable child record when an existing code workspace is reused.
      await blockPrepareWorkspaceRegisterSandboxStep(
        ctx.entry.subjectKey,
        ctx.entry.ownerToken,
        ctx.sandboxId,
      );
      const repositories = ctx.selectedRepositories.map(
        (repo) => `${repo.provider}:${repo.repoPath}`,
      );
      return {
        kind: "next",
        output: {
          status: "ok",
          sandboxId: ctx.sandboxId,
          repositories,
          workspace: { id: ctx.sandboxId, repositories },
        },
      };
    } catch (err) {
      if (isRunControlError(err)) throw err;
      return executionError(err instanceof Error ? err.message : String(err), {
        category: "sandbox",
      });
    }
  }

  try {
    let selected: SelectedRepository[];
    if (ctx.entry.kind === "pr_trigger") {
      selected = await blockPrTriggerRepositoriesStep(
        ctx.entry.ticketKey ?? ctx.entry.subjectKey,
        ctx.entry.pr,
      );
    } else {
      const preSandbox = await blockPrepareWorkspacePreSandboxStep({
        ticket: {
          identifier: ctx.ticket.identifier,
          title: ctx.ticket.title,
          description: ctx.ticket.description,
          acceptanceCriteria: ctx.ticket.acceptanceCriteria,
          comments: execution?.clarificationAnswer
            ? [
                ...ctx.ticket.comments,
                { author: "Human clarification", body: execution.clarificationAnswer },
              ]
            : ctx.ticket.comments,
          labels: ctx.ticket.labels,
        },
        run: { branchName: ctx.branchName },
      });
      if (preSandbox.status === "halt") {
        if (preSandbox.outcome === "needs_clarification") {
          const parsed = (preSandbox.questions ?? []).filter((q) => q.trim().length > 0);
          const questions = parsed.length > 0 ? parsed : [preSandbox.message];
          return {
            kind: "needs_human_input",
            output: { status: "needs_human_input", questions },
            questions,
          };
        }
        return executionError(`pre-sandbox: ${preSandbox.message}`, {
          category: "sandbox",
        });
      }
      if (preSandbox.promptAdditions) {
        ctx.preSandboxAdditions = preSandbox.promptAdditions;
      }
      selected = preSandbox.selectedRepositories ?? [];
    }

    if (selected.length === 0) {
      const questions = ["Which repository should this ticket modify?"];
      return {
        kind: "needs_human_input",
        output: { status: "needs_human_input", questions },
        questions,
      };
    }

    if (ctx.entry.kind !== "pr_trigger" || ctx.entry.scope === "workflow_owned") {
      const { prepareSelectedRepositoryBranches } = await import("../repository-prs.js");
      await prepareSelectedRepositoryBranches(
        ctx.ticket.identifier,
        ctx.branchName,
        selected,
        {
          subjectKey: ctx.entry.subjectKey,
          ownerToken: ctx.entry.ownerToken,
          runId: ctx.runId,
        },
      );
    }

    const repositoryContexts = await blockFetchPrContextsStep(selected);
    const workspaceRepositories: WorkspaceRepositoryInput[] = repositoryContexts.map(
      (context) => ({
        ...context.repository,
        ...(context.hasConflicts ? { mergeBase: context.repository.defaultBranch } : {}),
      }),
    );

    const arthurTaskId = await ensureArthurTask(ctx);

    const requiredAgents = requiredAgentsForDefinition({
      schemaVersion: ctx.schemaVersion,
      nodes: ctx.definitionNodes,
      defaultKind: ctx.runDefaultKind,
      defaults: ctx.defaults,
      harnessRuntimes: ctx.harnessRuntimes,
    });
    const provisioned = await blockPrepareWorkspaceProvisionStep(
      ctx.entry.subjectKey,
      ctx.entry.ownerToken,
      ctx.branchName,
      workspaceRepositories,
      arthurTaskId,
      requiredAgents,
    );
    if (!provisioned.ok) return agentProtocolExecutionError(provisioned.failure);
    const { sandboxId, workspaceManifest } = provisioned;
    // The manager registered this sandbox immediately after external creation,
    // before clone/install/configure. Keep the in-workflow set for normal
    // teardown; the durable child row covers crash/cancel cleanup.
    ctx.sandboxId = sandboxId;
    ctx.workspaceManifest = workspaceManifest;
    // Track every provisioned sandbox so a prepare_workspace inside a loop does
    // not leak the sandboxes from earlier iterations: the engine tears down all
    // of ctx.sandboxIds on exit, not just the latest ctx.sandboxId.
    ctx.sandboxIds.add(sandboxId);

    ctx.selectedRepositories = workspaceRepositories;
    ctx.repositoryContexts = repositoryContexts;
    const repositories = workspaceRepositories.map(
      (repo) => `${repo.provider}:${repo.repoPath}`,
    );

    return {
      kind: "next",
      output: {
        status: "ok",
        sandboxId,
        repositories,
        workspace: { id: sandboxId, repositories },
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "sandbox",
    });
  }
}

/** Explicit Prepare is the author-controlled spelling of the same idempotent
 * operation specialized code agents invoke implicitly. */
export const execute: BlockExecuteFn = async (_block, _steps, ctx, _inputs, execution) =>
  ensureWorkspace(ctx, execution);
