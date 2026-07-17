import { z } from "zod";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { PreSandboxPromptAdditionsByTarget } from "../../pre-sandbox/types.js";
import type { WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import { blockFetchPrContextsStep, blockPrTriggerRepositoriesStep } from "./fetch-pr-context.js";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";
import type { BlockExecutionContext } from "../../workflow-definition/interpreter.js";

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
  requiredKinds: AgentKind[],
): Promise<{ sandboxId: string }> {
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

  for (const kind of requiredKinds) {
    if (kind === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
      throw new Error(
        "a workflow block requires agent codex, which needs CODEX_API_KEY or CODEX_CHATGPT_OAUTH_TOKEN in the deployed environment",
      );
    }
    if (kind === "claude" && !env.ANTHROPIC_API_KEY) {
      throw new Error(
        "a workflow block requires agent claude, which needs ANTHROPIC_API_KEY in the deployed environment",
      );
    }
  }

  const configureOptsFor = (kind: AgentKind) => ({
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    codexApiKey: env.CODEX_API_KEY,
    codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
    model: kind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL,
    arthur,
  });

  const [primaryKind, ...restKinds] = requiredKinds;
  const additionalAgents = restKinds.map((kind) => ({
    agent: createAgentAdapter(kind),
    configureOpts: configureOptsFor(kind),
  }));

  const manager = new SandboxManager({
    providers: await buildSandboxProviderConfigs(
      selectedRepositories.map((repo) => repo.provider),
    ),
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
  });

  const sandbox = await manager.provisionMultiRepo(
    { branchName, repositories: selectedRepositories },
    createAgentAdapter(primaryKind),
    configureOptsFor(primaryKind),
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
  );

  return { sandboxId: sandbox.sandboxId };
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

function requiredKindsForDefinition(
  nodes: WorkflowDefinitionNode[],
  defaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): AgentKind[] {
  const kinds: AgentKind[] = [defaultKind];
  for (const node of nodes) {
    if (!CODE_WORKSPACE_AGENT_BLOCK_TYPES.has(node.type)) continue;
    if (node.type === "generic_agent" && node.params.workspaceMode === "none") continue;
    const resolved = resolveBlockAgent(node.params, defaultKind, defaults);
    if (!kinds.includes(resolved.kind)) kinds.push(resolved.kind);
  }
  return kinds;
}

/**
 * prepare_workspace: select repositories (pre-sandbox phase for ticket entries,
 * the PR's repository for pr_trigger entries), prepare workflow-owned branches,
 * fetch PR contexts, ensure the run's Arthur task, provision one sandbox with
 * every agent CLI the definition can need, and register it for cleanup.
 * Mutates ctx.sandboxId, ctx.selectedRepositories, ctx.repositoryContexts,
 * ctx.preSandboxAdditions, and ctx.arthur.taskId (see the EngineCtx mutation
 * contract).
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
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  try {
    let selected: SelectedRepository[];
    if (ctx.entry.kind === "pr_trigger") {
      selected = await blockPrTriggerRepositoriesStep(ctx.ticket.identifier, ctx.entry.pr);
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
        return {
          kind: "failed",
          output: { status: "failed" },
          reason: `pre-sandbox: ${preSandbox.message}`,
        };
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

    const { prepareSelectedRepositoryBranches } = await import("../repository-prs.js");
    await prepareSelectedRepositoryBranches(ctx.ticket.identifier, ctx.branchName, selected);

    const repositoryContexts = await blockFetchPrContextsStep(selected);
    const workspaceRepositories: WorkspaceRepositoryInput[] = repositoryContexts.map(
      (context) => ({
        ...context.repository,
        ...(context.hasConflicts ? { mergeBase: context.repository.defaultBranch } : {}),
      }),
    );

    const arthurTaskId = await ensureArthurTask(ctx);

    const requiredKinds = requiredKindsForDefinition(
      ctx.definitionNodes,
      ctx.runDefaultKind,
      ctx.defaults,
    );
    const { sandboxId } = await blockPrepareWorkspaceProvisionStep(
      ctx.entry.subjectKey,
      ctx.entry.ownerToken,
      ctx.branchName,
      workspaceRepositories,
      arthurTaskId,
      requiredKinds,
    );
    // The manager registered this sandbox immediately after external creation,
    // before clone/install/configure. Keep the in-workflow set for normal
    // teardown; the durable child row covers crash/cancel cleanup.
    ctx.sandboxId = sandboxId;
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
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Explicit Prepare is the author-controlled spelling of the same idempotent
 * operation specialized code agents invoke implicitly. */
export const execute: BlockExecuteFn = async (_block, _steps, ctx, _inputs, execution) =>
  ensureWorkspace(ctx, execution);
