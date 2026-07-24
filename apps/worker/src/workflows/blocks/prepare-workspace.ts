import { z } from "zod";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type {
  AgentProtocolResult,
  ResearchRepository,
} from "../../sandbox/agents/types.js";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { PreSandboxPromptAdditionsByTarget } from "../../pre-sandbox/types.js";
import type {
  WorkspaceManifest,
  WorkspaceRepositoryInput,
} from "../../sandbox/repo-workspace.js";
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import { isRunControlError } from "../run-control-error.js";
import { invalidateWorkspaceGate } from "../workspace-gate.js";
import { emitRepositoryWorkflowObservation } from "../../run-observability/agent-observations.js";
import { blockFetchPrContextsStep, blockPrTriggerRepositoriesStep } from "./fetch-pr-context.js";
import {
  agentProtocolExecutionError,
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";
import type { BlockExecutionContext } from "../../workflow-definition/interpreter.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";
import type { PreSandboxRepositoryDiscovery } from "../../pre-sandbox/types.js";
import type { ApprovedRepositoryScope } from "@shared/contracts";

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
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      questions?: string[];
      promptAdditions?: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
    };

async function blockPrepareWorkspacePreSandboxStep(
  context: PreSandboxTicketContext,
): Promise<PreSandboxOutcome> {
  "use step";
  const { runPreSandboxPhase } = await import("../../pre-sandbox/runner.js");
  return runPreSandboxPhase(context);
}
blockPrepareWorkspacePreSandboxStep.maxRetries = 0;

async function blockApprovedRepositoryScopeStep(
  ticketKey: string,
  scope: ApprovedRepositoryScope,
): Promise<SelectedRepository[]> {
  "use step";
  if (scope.repositories.length === 0 || scope.repositories.length > 8) {
    throw new Error("Approved repository scope is empty or exceeds 8 repositories; replan required");
  }
  const { getConfiguredVcsProviders } = await import("../../../env.js");
  const { createRepositoryDirectoryForProviders } = await import(
    "../../adapters/vcs/repository-directory.js"
  );
  const { createRepositoryVCS } = await import("../../lib/vcs-runtime.js");
  const { getDb } = await import("../../db/client.js");
  const { listWorkflowOwnedBranchesForTicket } = await import(
    "../../db/queries/workflow-owned-branches.js"
  );
  const available = await createRepositoryDirectoryForProviders(
    getConfiguredVcsProviders(),
  ).listRepositories();
  const byKey = new Map(
    available.map((repository) => [
      `${repository.provider}:${repository.repoPath.toLowerCase()}`,
      repository,
    ]),
  );
  const owned = await listWorkflowOwnedBranchesForTicket(getDb(), ticketKey);
  const seen = new Set<string>();
  const selected: SelectedRepository[] = [];
  for (const approved of scope.repositories) {
    const key = `${approved.provider}:${approved.repoPath.toLowerCase()}`;
    if (seen.has(key)) {
      throw new Error(`Approved repository scope duplicates ${key}; replan required`);
    }
    seen.add(key);
    const current = byKey.get(key);
    if (!current) {
      throw new Error(`Approved repository ${key} is unavailable or no longer allowed; replan required`);
    }
    if (current.defaultBranch !== approved.defaultBranch) {
      throw new Error(`Approved repository ${key} changed its default branch; replan required`);
    }
    let currentSha: string;
    try {
      currentSha = await createRepositoryVCS({
        provider: current.provider,
        repoPath: current.repoPath,
        baseBranch: current.defaultBranch,
      }).getBranchSha(approved.researchBranch);
    } catch {
      throw new Error(
        `Approved repository ${key} research branch is unavailable; replan required`,
      );
    }
    if (currentSha !== approved.researchBaseSha) {
      throw new Error(`Approved repository ${key} moved after research; replan required`);
    }
    const ownership = owned.find(
      (record) =>
        record.provider === current.provider &&
        record.repoPath.toLowerCase() === current.repoPath.toLowerCase(),
    );
    selected.push({
      provider: current.provider,
      repoPath: current.repoPath,
      defaultBranch: current.defaultBranch,
      selectedRationale: approved.rationale,
      ...(ownership
        ? {
            workflowOwnedBranch: {
              branchName: ownership.branchName,
              ...(ownership.pr ? { pr: ownership.pr } : {}),
            },
          }
        : {}),
    });
  }
  return selected;
}
blockApprovedRepositoryScopeStep.maxRetries = 0;

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
  access: "read" | "write",
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
      { branchName, repositories: selectedRepositories, access },
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
  "planning_agent",
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
 * the PR's repository for pr_trigger entries), provision read-only checkouts,
 * fetch PR contexts, ensure the run's Arthur task, provision one sandbox with
 * every agent CLI the definition can need, and register it for cleanup.
 * Mutates ctx.sandboxId, ctx.workspaceManifest, ctx.selectedRepositories,
 * ctx.repositoryContexts, ctx.preSandboxAdditions, and ctx.arthur.taskId (see
 * the EngineCtx mutation contract).
 */
export async function ensureWorkspace(
  ctx: Parameters<BlockExecuteFn>[2],
  execution?: BlockExecutionContext,
  options: {
    discoverRepositories?: (
      discovery: PreSandboxRepositoryDiscovery,
    ) => Promise<
      | BlockExecutionResult
      | SelectedRepository[]
      | { repositories: SelectedRepository[]; sandboxId: string }
    >;
    hydrateDiscoveredWorkspace?: (
      sandboxId: string,
      repositories: WorkspaceRepositoryInput[],
    ) => Promise<Extract<WorkspaceManifest, { version: 2 }>>;
  } = {},
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
    let discoverySandboxId: string | null = null;
    // The approved-scope path carries each repository's trusted research baseline
    // into provisioning so the manager rejects a branch that moved between approval
    // and clone. Other entry kinds leave this null and thread no baseline.
    let approvedBaselineByKey: Map<string, string> | null = null;
    if (
      ctx.entry.kind === "plan_approved" &&
      ctx.entry.approvedPlan.repositoryScope
    ) {
      const scope = ctx.entry.approvedPlan.repositoryScope;
      approvedBaselineByKey = new Map(
        scope.repositories.map((repository) => [
          `${repository.provider}:${repository.repoPath.toLowerCase()}`,
          repository.researchBaseSha,
        ]),
      );
      selected = await blockApprovedRepositoryScopeStep(
        ctx.ticket.identifier,
        scope,
      );
    } else if (ctx.entry.kind === "pr_trigger") {
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
      ctx.repositoryDiscovery = preSandbox.repositoryDiscovery ?? null;
      selected = preSandbox.selectedRepositories ?? [];
      if (selected.length === 0 && preSandbox.repositoryDiscovery) {
        if (!options.discoverRepositories) {
          const questions = [
            "Which repository or repositories should this ticket inspect or modify? Reply with full repository paths.",
          ];
          return {
            kind: "needs_human_input",
            output: { status: "needs_human_input", questions },
            questions,
          };
        }
        const discovered = await options.discoverRepositories(
          preSandbox.repositoryDiscovery,
        );
        if (
          !Array.isArray(discovered) &&
          "kind" in discovered
        ) return discovered;
        if (Array.isArray(discovered)) {
          selected = discovered;
        } else {
          selected = discovered.repositories;
          discoverySandboxId = discovered.sandboxId;
        }
      }
    }

    if (selected.length === 0) {
      const questions = ["Which repository should this ticket modify?"];
      return {
        kind: "needs_human_input",
        output: { status: "needs_human_input", questions },
        questions,
      };
    }
    if (selected.length > 8) {
      const questions = [
        "More than 8 repositories are in scope. Which repositories are essential for this ticket?",
      ];
      return {
        kind: "needs_human_input",
        output: { status: "needs_human_input", questions },
        questions,
      };
    }

    const repositoryContexts = await blockFetchPrContextsStep(selected);
    const workspaceRepositories: WorkspaceRepositoryInput[] = repositoryContexts.map(
      (context) => {
        const expectedResearchBaseSha = approvedBaselineByKey?.get(
          `${context.repository.provider}:${context.repository.repoPath.toLowerCase()}`,
        );
        return {
          ...context.repository,
          ...(context.hasConflicts ? { mergeBase: context.repository.defaultBranch } : {}),
          // A repository that already carries a workflow-owned branch (the PR-trigger
          // repo, or a ticket re-pickup whose branch ownership the DB ledger proved)
          // is remediating an existing branch: provision it write so the owned branch
          // is checked out, its base pre-merged, and its baselines recorded. The owned
          // branch already exists remotely, so this never creates or resets a branch.
          // Repositories without an owned branch keep the read-only default.
          ...(context.repository.workflowOwnedBranch ? { access: "write" as const } : {}),
          ...(expectedResearchBaseSha ? { expectedResearchBaseSha } : {}),
        };
      },
    );

    const arthurTaskId = await ensureArthurTask(ctx);

    const requiredAgents = requiredAgentsForDefinition({
      schemaVersion: ctx.schemaVersion,
      nodes: ctx.definitionNodes,
      defaultKind: ctx.runDefaultKind,
      defaults: ctx.defaults,
      harnessRuntimes: ctx.harnessRuntimes,
    });
    let sandboxId: string;
    let workspaceManifest: WorkspaceManifest;
    if (discoverySandboxId && options.hydrateDiscoveredWorkspace) {
      sandboxId = discoverySandboxId;
      workspaceManifest = await options.hydrateDiscoveredWorkspace(
        discoverySandboxId,
        workspaceRepositories,
      );
      const { promoteAgentSandboxToWorkspace } = await import(
        "../../sandbox/research-workspace.js"
      );
      promoteAgentSandboxToWorkspace(ctx, sandboxId, {
        manifest: workspaceManifest,
        repositories: workspaceRepositories,
        repositoryContexts,
      });
    } else {
      const provisioned = await blockPrepareWorkspaceProvisionStep(
        ctx.entry.subjectKey,
        ctx.entry.ownerToken,
        ctx.branchName,
        workspaceRepositories,
        arthurTaskId,
        requiredAgents,
        "read",
      );
      if (!provisioned.ok) return agentProtocolExecutionError(provisioned.failure);
      ({ sandboxId, workspaceManifest } = provisioned);
    }
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

/**
 * Promote the requested repositories to write scope through the ledger-guarded
 * promotion step, then refresh the ctx views every downstream block reads. This
 * is the single implementation the planning post-research path, the plan_approved
 * path, and the ticket-without-planning path (see maybePromoteTicketWorkspaceWrites)
 * all funnel through, so branch ownership, baselines, and manifest access stay
 * consistent regardless of which flow requested the promotion. Returns null on
 * success or an execution error to propagate.
 */
export async function promoteWorkspaceWrites(
  ctx: Parameters<BlockExecuteFn>[2],
  writeRepositories: ResearchRepository[],
  execution?: BlockExecutionContext,
): Promise<BlockExecutionResult | null> {
  if (!ctx.sandboxId || ctx.workspaceManifest?.version !== 2) {
    return executionError(
      "write-scope promotion requires a trusted V2 workspace",
      { category: "sandbox", phase: "research" },
    );
  }
  try {
    const { promoteRepositoryWriteScopeStep } = await import(
      "../repository-promotion.js"
    );
    ctx.workspaceManifest = await promoteRepositoryWriteScopeStep({
      sandboxId: ctx.sandboxId,
      manifest: ctx.workspaceManifest,
      writeRepositories,
      branchName: ctx.branchName,
      ticketKey: ctx.entry.ticketKey ?? ctx.ticket.identifier,
      owner: {
        subjectKey: ctx.entry.subjectKey,
        ownerToken: ctx.entry.ownerToken,
        runId: ctx.runId,
      },
    });
    const manifestByKey = new Map(
      ctx.workspaceManifest.repositories.map((repository) => [
        `${repository.provider}:${repository.repoPath.toLowerCase()}`,
        repository,
      ]),
    );
    ctx.selectedRepositories = ctx.selectedRepositories.map((repository) => {
      const promoted = manifestByKey.get(
        `${repository.provider}:${repository.repoPath.toLowerCase()}`,
      );
      return promoted?.workflowOwnedBranch
        ? { ...repository, workflowOwnedBranch: promoted.workflowOwnedBranch }
        : repository;
    });
    ctx.repositoryContexts = await blockFetchPrContextsStep(
      ctx.selectedRepositories,
    );
    await emitRepositoryWorkflowObservation(execution?.observations, {
      event: "scope",
      readCount: ctx.workspaceManifest.repositories.filter(
        (repository) => repository.access === "read",
      ).length,
      writeCount: ctx.workspaceManifest.repositories.filter(
        (repository) => repository.access === "write",
      ).length,
    });
    invalidateWorkspaceGate(ctx);
    return null;
  } catch (error) {
    if (isRunControlError(error)) throw error;
    return executionError(error instanceof Error ? error.message : String(error), {
      category: "sandbox",
      phase: "research",
    });
  }
}

/**
 * Ticket graphs without a planning_agent never reach the post-research write-scope
 * promotion, so their code-writing block would commit on a read-only checkout and
 * fail publication (read_only_changed). When a code-writing block is about to run on
 * an all-read V2 workspace for a ticket run whose definition has no planning node
 * and no completed research write set, promote every selected repository. Planning
 * graphs are excluded on purpose so research stays read-only until the plan declares
 * its write set, and the plan_approved path keeps owning its own promotion.
 */
export async function maybePromoteTicketWorkspaceWrites(
  ctx: Parameters<BlockExecuteFn>[2],
  execution?: BlockExecutionContext,
): Promise<BlockExecutionResult | null> {
  if (ctx.entry.kind !== "ticket") return null;
  const manifest = ctx.workspaceManifest;
  if (manifest?.version !== 2) return null;
  if (ctx.researchWriteRepositories.length > 0) return null;
  if (ctx.definitionNodes.some((node) => node.type === "planning_agent")) {
    return null;
  }
  if (manifest.repositories.length === 0) return null;
  if (!manifest.repositories.every((repository) => repository.access === "read")) {
    return null;
  }
  const writeRepositories: ResearchRepository[] = ctx.selectedRepositories.map(
    (repository) => ({
      provider: repository.provider,
      repoPath: repository.repoPath,
      rationale: repository.selectedRationale,
    }),
  );
  if (writeRepositories.length === 0) return null;
  const promotion = await promoteWorkspaceWrites(ctx, writeRepositories, execution);
  if (promotion) return promotion;
  ctx.researchWriteRepositories = writeRepositories;
  return null;
}

/**
 * A workspace-enabled generic_agent commits on the shared workspace but, unlike
 * implementation_agent (ensureCodeWorkspace) and fix_agent (its own ensureWorkspace),
 * reuses whatever prepare_workspace attached without routing through a write-ensuring
 * path. Promote its workspace here so a ticket graph without a planning node can
 * publish the generic block's commits. No-op for workspace-free generic blocks and
 * before a workspace is attached (the generic block then fails on its own).
 */
export async function maybePromoteGenericAgentWorkspace(
  ctx: Parameters<BlockExecuteFn>[2],
  node: WorkflowDefinitionNode,
  execution?: BlockExecutionContext,
): Promise<BlockExecutionResult | null> {
  if (node.type !== "generic_agent") return null;
  if (node.params.workspaceMode === "none") return null;
  if (!ctx.sandboxId) return null;
  return maybePromoteTicketWorkspaceWrites(ctx, execution);
}

/** Explicit Prepare is the author-controlled spelling of the same idempotent
 * operation specialized code agents invoke implicitly. */
export const execute: BlockExecuteFn = async (_block, _steps, ctx, _inputs, execution) =>
  ensureWorkspace(ctx, execution);
