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
import { hydrateWorkspaceMemoryStep } from "../memory-steps.js";
import { captureDefaultBranchFilesStep } from "../repo-memory-steps.js";
import { seedRepoMemoryStep } from "../repo-seed-steps.js";
import { invalidateWorkspaceGate } from "../workspace-gate.js";
import { emitRepositoryWorkflowObservation } from "../../run-observability/agent-observations.js";
import {
  blockFetchPrContextsStep,
  blockPrTriggerRepositoriesWithSiblingsStep,
} from "./fetch-pr-context.js";
import {
  agentProtocolExecutionError,
  blockBudgetObserver,
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";
import {
  resolveChecksProvisioningStep,
  runRepositorySetup,
} from "./pre-pr-checks.js";
import { formatPrePrCheckFailures } from "../../pre-pr-checks/runner.js";
import type { BlockExecutionContext } from "../../workflow-definition/interpreter.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";
import type {
  PreSandboxRepositoryCatalogDegradation,
  PreSandboxRepositoryDiscovery,
  PreSandboxRepositoryScopeNarrowing,
} from "../../pre-sandbox/types.js";
import type {
  ApprovedRepositoryScope,
  WorkflowRepositoryScope,
} from "@shared/contracts";

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
  repositoryScope?: WorkflowRepositoryScope;
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
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      /** The reason inside `message`, isolated by the step so it survives the
       *  user-facing bounds. See PreSandboxStepResult. */
      cause?: string;
      questions?: string[];
      promptAdditions?: PreSandboxPromptAdditionsByTarget;
      selectedRepositories?: SelectedRepository[];
      repositoryDiscovery?: PreSandboxRepositoryDiscovery;
      repositoryScopeNarrowing?: PreSandboxRepositoryScopeNarrowing;
      repositoryCatalogDegradation?: PreSandboxRepositoryCatalogDegradation;
    };

async function blockPrepareWorkspacePreSandboxStep(
  context: PreSandboxTicketContext,
): Promise<PreSandboxOutcome> {
  "use step";
  const { runPreSandboxPhase } = await import("../../pre-sandbox/runner.js");
  return runPreSandboxPhase(context);
}
blockPrepareWorkspacePreSandboxStep.maxRetries = 0;

// Runtime shape guard for the approved scope read back from jsonb. A corrupted
// row must fail as a clean "replan required" here instead of a raw TypeError
// deeper in the step (or in the baseline map built from it).
const approvedRepositoryScopeSchema = z.object({
  repositories: z
    .array(
      z.object({
        provider: z.enum(["github", "gitlab"]),
        repoPath: z.string().min(1),
        defaultBranch: z.string().min(1),
        researchBranch: z.string().min(1),
        researchBaseSha: z.string().regex(/^[0-9a-f]{40}$/i),
        access: z.enum(["read", "write"]),
        rationale: z.string(),
      }),
    )
    .min(1)
    .max(8),
});

async function blockApprovedRepositoryScopeStep(
  ticketKey: string,
  scope: ApprovedRepositoryScope,
  pinnedScope: WorkflowRepositoryScope | null,
): Promise<SelectedRepository[]> {
  "use step";
  const parsed = approvedRepositoryScopeSchema.safeParse(scope);
  if (!parsed.success) {
    throw new Error(
      "Approved repository scope is malformed or out of bounds; replan required",
    );
  }
  scope = parsed.data;
  const { getConfiguredVcsProviders } = await import("../../../env.js");
  const { createRepositoryDirectoryForProviders, isRepositoryWithinPinnedScope } =
    await import("../../adapters/vcs/repository-directory.js");
  const { createRepositoryVCS } = await import("../../lib/vcs-runtime.js");
  const { filterRepositoriesForScope } = await import(
    "../../lib/repo-allowlist.js"
  );
  const { getDb } = await import("../../db/client.js");
  const { listWorkflowOwnedBranchesForTicket } = await import(
    "../../db/queries/workflow-owned-branches.js"
  );
  const available = filterRepositoriesForScope(
    await createRepositoryDirectoryForProviders(
      getConfiguredVcsProviders(),
    ).listRepositories(),
    pinnedScope ?? undefined,
  );
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
    // Here the pin is a control, never a filter. A human already approved this
    // exact scope, so a pin that no longer covers it must force a replan instead
    // of silently narrowing what was reviewed and approved.
    if (pinnedScope && !isRepositoryWithinPinnedScope(pinnedScope, approved)) {
      throw new Error(
        `Approved repository ${key} is outside the repositories pinned to this workflow; replan required`,
      );
    }
    const current = byKey.get(key);
    if (!current) {
      throw new Error(`Approved repository ${key} is unavailable or no longer allowed; replan required`);
    }
    // An archived repository is as stale as a missing one: the provider rejects
    // writes to it, so force a replan here instead of dying later with a 403.
    if (current.archived) {
      throw new Error(`Approved repository ${key} is archived; replan required`);
    }
    if (current.defaultBranch !== approved.defaultBranch) {
      throw new Error(`Approved repository ${key} changed its default branch; replan required`);
    }
    // getBranchShaIfExists returns null ONLY when the provider authoritatively
    // reports no such branch (a genuine miss/move that warrants a replan). Any
    // thrown error is a transient provider/network failure: rethrow it as an
    // infrastructure failure so the run does NOT discard a still-valid plan.
    let currentSha: string | null;
    try {
      currentSha = await createRepositoryVCS({
        provider: current.provider,
        repoPath: current.repoPath,
        baseBranch: current.defaultBranch,
      }).getBranchShaIfExists(approved.researchBranch);
    } catch (error) {
      throw new Error(
        `Approved repository ${key} scope recheck could not reach the provider; transient infrastructure failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (currentSha === null) {
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
  checksCeilingMs: number,
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
      ...(runtime.modelSettings
        ? { modelSettings: runtime.modelSettings }
        : {}),
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
    // The run's own budget plus the checks phase's, because the checks run in
    // THIS sandbox and no longer spend the run's duration. Sizing the lifetime
    // from JOB_TIMEOUT_MS alone would kill the sandbox under a batch that is
    // still perfectly within its bound, and the batch would be collected as an
    // infrastructure fault instead of as a result.
    jobTimeoutMs: sandboxLifetimeMs(env.JOB_TIMEOUT_MS, checksCeilingMs),
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
          const { createAdapters } = await import("../../lib/adapters.js");
          await createAdapters().runRegistry.registerSandbox(
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

/**
 * Install and configure every legacy agent CLI the definition needs into an
 * already-provisioned sandbox. The provision path installs these inside
 * blockPrepareWorkspaceProvisionStep; the discovery-promotion path instead reuses
 * the scratch sandbox that repository discovery created, which carries only the
 * run-default CLI. Without this, a later block resolving to a different legacy
 * kind (e.g. review_agent: claude while the run default is codex) would fail with
 * cli_exit. Runtime-backed (V2 Harness Profile) agents rebuild their pinned CLI
 * immediately before each invocation, so they are skipped here exactly as
 * SandboxManager.prepareAgent skips them; only legacy kinds need this install.
 */
async function blockInstallPromotedWorkspaceAgentsStep(
  sandboxId: string,
  requiredAgents: WorkspaceAgentRuntime[],
  arthurTaskId: string | null,
): Promise<
  | { ok: true }
  | { ok: false; failure: Extract<AgentProtocolResult<unknown>, { ok: false }> }
> {
  "use step";
  const { env } = await import("../../../env.js");
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const { runtimePreparationError } = await import(
    "../../sandbox/agents/protocol.js"
  );
  const { isAgentRuntimeError } = await import(
    "../../sandbox/agents/runtime-error.js"
  );

  const arthur =
    env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT && arthurTaskId
      ? {
          apiKey: env.GENAI_ENGINE_API_KEY,
          taskId: arthurTaskId,
          endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
        }
      : undefined;

  try {
    const sandbox = await Sandbox.get({
      sandboxId,
      ...getSandboxCredentials(),
    });
    for (const { kind, model, runtime } of requiredAgents) {
      if (runtime) continue;
      const adapter = createAgentAdapter(kind);
      const missingCodexCreds =
        kind === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN;
      const missingClaudeCreds = kind === "claude" && !env.ANTHROPIC_API_KEY;
      if (missingCodexCreds || missingClaudeCreds) {
        const error = runtimePreparationError(
          adapter.cliSpec,
          `${kind === "codex" ? "Codex" : "Claude"} authentication credentials are missing from the deployed environment.`,
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
      await adapter.install(sandbox);
      await adapter.configure(sandbox, {
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        codexApiKey: env.CODEX_API_KEY,
        codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
        model,
        arthur,
      });
    }
    return { ok: true };
  } catch (error) {
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
blockInstallPromotedWorkspaceAgentsStep.maxRetries = 0;

async function blockPrepareWorkspaceRegisterSandboxStep(
  subjectKey: string,
  ownerToken: string,
  sandboxId: string,
): Promise<void> {
  "use step";
  const { createAdapters } = await import("../../lib/adapters.js");
  const { runRegistry } = createAdapters();
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
/**
 * How long a sandbox that may host a check batch is allowed to live.
 *
 * One rule in one place, because it has to hold for every route that produces
 * such a sandbox: fresh provisioning, a promoted discovery sandbox, and a
 * workspace rebuilt from a clarification snapshot. `baseMs` is whatever budget
 * that route already sized itself by (JOB_TIMEOUT_MS when it creates a
 * workspace up front, the run's remaining duration when it resumes into one).
 *
 * The ceiling is added because the checks no longer spend the run's duration.
 * Before that split the two were coupled by construction, since the batch cap
 * was derived from the same remaining duration the lifetime came from; now
 * nothing couples them except this function. A route that forgets it gets a
 * sandbox that dies under a batch still well inside its own bound, which
 * surfaces as a lost workspace and blames the wrong thing entirely.
 */
export function sandboxLifetimeMs(baseMs: number, checksCeilingMs: number): number {
  const base = Number.isFinite(baseMs) ? Math.max(1, Math.floor(baseMs)) : 1;
  const ceiling =
    Number.isFinite(checksCeilingMs) && checksCeilingMs > 0
      ? Math.floor(checksCeilingMs)
      : 0;
  return base + ceiling;
}

/**
 * The run's checks ceiling, resolved once per run and cached on the context.
 *
 * Every path that creates a sandbox capable of hosting a check batch reads it,
 * so they all size their lifetime against the same number. A run that never
 * touches checks pays exactly one extra step for it.
 */
export async function ensureChecksCeiling(
  ctx: Pick<Parameters<BlockExecuteFn>[2], "checksCeilingMs">,
): Promise<number> {
  if (ctx.checksCeilingMs !== null) return ctx.checksCeilingMs;
  const { ceilingMs } = await resolveChecksProvisioningStep();
  ctx.checksCeilingMs = ceilingMs;
  return ceilingMs;
}

/**
 * Block types that hand commands to the repository scripts engine.
 *
 * The gate on running setup at all. Setup provisions a toolchain for scripts,
 * so a definition that runs none has nothing to provision, and a failing setup
 * command must not brick it: a tenant whose private registry is returning 401
 * would otherwise lose every workflow they have, including research-only ones
 * that never touch a repository script. Fail fast keeps its blast radius to
 * the workflows that were going to run those commands anyway.
 */
const SCRIPT_ENGINE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "run_scripts",
  "run_pre_pr_checks",
  "run_checks",
]);

export function definitionRunsScripts(
  nodes: ReadonlyArray<{ type: string }>,
): boolean {
  return nodes.some((node) => SCRIPT_ENGINE_BLOCK_TYPES.has(node.type));
}

/**
 * Run the configured setup for this workspace, or nothing at all, and return an
 * execution error when a setup command failed.
 *
 * Returns null when there is nothing to report, so both the provisioning path
 * and the reuse path can call it the same way and neither can drift into a
 * different verdict for the same failure.
 */
async function verifyRepositorySetup(
  ctx: Parameters<BlockExecuteFn>[2],
  sandboxId: string,
  config: unknown,
  checksCeilingMs: number,
  execution?: BlockExecutionContext,
): Promise<BlockExecutionResult | null> {
  if (config === null || !definitionRunsScripts(ctx.definitionNodes)) return null;
  const setup = await runRepositorySetup({
    sandboxId,
    config,
    // The plain observer: setup time is the run's, never the checks ceiling's.
    observeBudget: blockBudgetObserver(ctx, execution),
    checksCeilingMs,
    ...(execution?.cancellation ? { cancellation: execution.cancellation } : {}),
    // Provisioning is the longest stretch of a run with nothing to show for
    // itself: it precedes every block that produces output, and a five minute
    // `uv sync` is indistinguishable from a hung workspace without this.
    ...(execution?.observations ? { observations: execution.observations } : {}),
  });
  if (setup.failures.length === 0) return null;
  // Loud and terminal for this block. A missing toolchain is not something a
  // later block routes around, and it is not a check result either.
  return executionError(formatPrePrCheckFailures(setup.failures), {
    category: "checks",
    phase: "setup",
    message: setup.summary,
  });
}

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
  // Resolved lazily. When a sandbox created earlier in this run already fixed
  // the ceiling, that number wins and the step is not worth its record: two
  // ceilings in one run would mean two different bounds for the same phase.
  // A definition that runs scripts still pays for the step, because the same
  // row carries the setup commands this block is about to run.
  const needsScripts = definitionRunsScripts(ctx.definitionNodes);
  const provisioning =
    ctx.checksCeilingMs !== null && !needsScripts
      ? { ceilingMs: ctx.checksCeilingMs, config: null }
      : await resolveChecksProvisioningStep();
  ctx.checksCeilingMs ??= provisioning.ceilingMs;
  const checksCeilingMs = ctx.checksCeilingMs;
  if (ctx.sandboxId) {
    try {
      // Re-assert the durable child record when an existing code workspace is reused.
      await blockPrepareWorkspaceRegisterSandboxStep(
        ctx.entry.subjectKey,
        ctx.entry.ownerToken,
        ctx.sandboxId,
      );
      // The reuse path verifies setup too. It is reachable from a clarification
      // restore, where the workspace is a fresh sandbox rebuilt from a snapshot,
      // and letting it skip the substep would quietly return setup to running
      // inside the first check batch: the exact behaviour this moved out of.
      // The marker makes the repeat cheap, since the wrapper skips a setup it
      // has already completed in this sandbox.
      const reuseSetup = await verifyRepositorySetup(
        ctx,
        ctx.sandboxId,
        provisioning.config,
        checksCeilingMs,
        execution,
      );
      if (reuseSetup) return reuseSetup;
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
          checksCeilingMs,
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
      // The step validates the jsonb-sourced scope (a corrupted row fails here as
      // a clean replan), so build the trusted baseline map only after it returns.
      selected = await blockApprovedRepositoryScopeStep(
        ctx.ticket.identifier,
        scope,
        ctx.repositoryScope ?? null,
      );
      approvedBaselineByKey = new Map(
        scope.repositories.map((repository) => [
          `${repository.provider}:${repository.repoPath.toLowerCase()}`,
          repository.researchBaseSha,
        ]),
      );
    } else if (ctx.entry.kind === "pr_trigger") {
      selected = await blockPrTriggerRepositoriesWithSiblingsStep(
        ctx.runId,
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
        ...(ctx.repositoryScope ? { repositoryScope: ctx.repositoryScope } : {}),
        // Structurally an answer to a which-repository question, not merely a
        // reply that happens to be in hand: the interpreter only ever returns a
        // clarification answer to the block that asked for it, and every
        // clarification this block raises is a repository question. The synthetic
        // comment above stays, because it is what the selection scan reads; this
        // is what tells a step it may be trusted as testimony.
        ...(execution?.clarificationAnswer
          ? {
              clarification: {
                answer: execution.clarificationAnswer,
                resolves: "repository_selection" as const,
              },
            }
          : {}),
      });
      if (preSandbox.repositoryScopeNarrowing) {
        ctx.repositoryScopeNarrowing = preSandbox.repositoryScopeNarrowing;
      }
      // Emitted before the halt below returns, so a run that failed closed on an
      // incomplete catalog still tells an operator which provider was missing.
      if (preSandbox.repositoryCatalogDegradation) {
        await emitRepositoryWorkflowObservation(execution?.observations, {
          event: "catalog_degraded",
          providers: preSandbox.repositoryCatalogDegradation.providers,
          outcome: preSandbox.repositoryCatalogDegradation.outcome,
        });
      }
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
          // The reason the step reported, handed over separately so it leads the
          // user-facing message instead of being clamped out of its middle.
          ...(preSandbox.cause ? { evidence: { cause: preSandbox.cause } } : {}),
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

    const repositoryContexts = await blockFetchPrContextsStep(
      selected,
      ctx.repositoryScope,
    );
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
      // The provision path installs every agent kind the definition needs; the
      // promoted discovery sandbox only carries the run-default CLI, so install the
      // rest here before any block runs (IM-8) or a later different-kind block dies
      // with cli_exit.
      const installedAgents = await blockInstallPromotedWorkspaceAgentsStep(
        discoverySandboxId,
        requiredAgents,
        arthurTaskId,
      );
      if (!installedAgents.ok) {
        return agentProtocolExecutionError(installedAgents.failure);
      }
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
        checksCeilingMs,
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

    // Both provisioning paths converge here, so the memory document lands in the
    // workspace before any block reads it. The step swallows its own failures;
    // this guard keeps even a step-boundary error from failing the block, which
    // is already fully provisioned at this point.
    try {
      await hydrateWorkspaceMemoryStep({
        sandboxId,
        subjectKey: ctx.entry.subjectKey,
        ticketKey: ctx.entry.ticketKey ?? null,
        taskId: ctx.ticket.identifier,
        workspaceManifest,
        runId: ctx.runId,
      });
    } catch (err) {
      if (isRunControlError(err)) throw err;
      // Memory is an optimization; the workspace is ready either way.
    }

    // Derived from the checkout rather than from a model, so a repository has
    // useful facts before its first successful run distills any. Gated here at
    // the call site rather than inside the step: a "use step" invocation writes
    // a durable step record even when its body returns immediately.
    const { env } = await import("../../../env.js");
    if (env.ENABLE_REPO_MEMORY) {
      // The branch fields come from this trusted in-memory manifest rather than
      // from the sandbox's copy of it: they gate a retraction of durable memory
      // in the seed and choose which ref counts as the repository in the capture,
      // and on the promoted discovery path agent code has already run in that
      // sandbox. Built once because both steps decide on exactly the same fields
      // and must never drift into deciding on different ones.
      const memoryRepositories = workspaceManifest.repositories.map((repository) => ({
        provider: repository.provider,
        repoPath: repository.repoPath,
        localPath: repository.localPath,
        branchName: repository.branchName,
        defaultBranch: repository.defaultBranch,
        workflowOwnedBranch: repository.workflowOwnedBranch?.branchName ?? null,
      }));
      try {
        await seedRepoMemoryStep({
          sandboxId,
          runId: ctx.runId,
          repositories: memoryRepositories,
        });
      } catch (err) {
        if (isRunControlError(err)) throw err;
        // Memory is an optimization; the workspace is ready either way.
      }
      // Listed here and nowhere later because this is the last moment the
      // checkout is still only what the clone produced. The distill that consumes
      // it runs after teardown, on a run whose agent branch holds files the
      // default branch does not, so a workspace read there would confirm exactly
      // the entries the listing exists to reject. Its own try, so a seed that
      // failed at the step boundary does not also cost the listing.
      try {
        ctx.defaultBranchFiles = await captureDefaultBranchFilesStep({
          sandboxId,
          runId: ctx.runId,
          repositories: memoryRepositories,
        });
      } catch (err) {
        if (isRunControlError(err)) throw err;
        // Memory is an optimization; the workspace is ready either way.
      }
    }

    // Provisioning, as a visible substep of workspace creation rather than as
    // the slow first minutes of the first check batch. A failing setup command
    // is not a failing check: no code edit repairs it, and the operator has a
    // command to go and fix, so it stops the run here with that command named.
    const setupFailure = await verifyRepositorySetup(
      ctx,
      sandboxId,
      provisioning.config,
      checksCeilingMs,
      execution,
    );
    if (setupFailure) return setupFailure;

    return {
      kind: "next",
      output: {
        status: "ok",
        sandboxId,
        repositories,
        workspace: { id: sandboxId, repositories },
        // Published rather than left for the checks block to re-derive. This is
        // the number the sandbox lifetime above was sized against, so a
        // configuration edited later in the run must not be able to hand a
        // batch a longer bound than its sandbox will live.
        checksCeilingMs,
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
      repositoryScope: ctx.repositoryScope,
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
      ctx.repositoryScope,
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

/** Entry kinds that own a branch off a synthesized or ticket identifier and have
 *  no other path that makes their workspace writable. */
function promotableEntryKind(
  kind: Parameters<BlockExecuteFn>[2]["entry"]["kind"],
): boolean {
  return kind === "ticket" || kind === "webhook_trigger" || kind === "schedule";
}

/**
 * Ticket graphs without a planning_agent never reach the post-research write-scope
 * promotion, so their code-writing block would commit on a read-only checkout and
 * fail publication (read_only_changed). When a code-writing block is about to run on
 * an all-read V2 workspace for a ticket run whose definition has no planning node
 * and no completed research write set, promote every selected repository. Planning
 * graphs are excluded on purpose so research stays read-only until the plan declares
 * its write set, and the plan_approved path keeps owning its own promotion.
 *
 * Webhook and schedule runs qualify for the same reason: they own a fresh branch
 * off the synthesized identifier and no other path ever promotes them. Leaving a
 * scheduled run out means it can never open a pull request, silently.
 * pr_trigger stays excluded because Part 1 already provisions the write on its
 * owned branch.
 */
export async function maybePromoteTicketWorkspaceWrites(
  ctx: Parameters<BlockExecuteFn>[2],
  execution?: BlockExecutionContext,
): Promise<BlockExecutionResult | null> {
  if (!promotableEntryKind(ctx.entry.kind)) return null;
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
 * A code-writing block on a planning graph relies on the post-research write-scope
 * promotion to make its workspace writable. When research completed with an empty
 * write set (a research-only ticket: investigation, question, or "no changes
 * needed"), that promotion is correctly skipped and maybePromoteTicketWorkspaceWrites
 * stays out because a planning node owns promotion. The workspace therefore stays
 * all-read, and committing on it would only surface as read_only_changed at
 * publication. Fail loud and early instead so the operator can replan. Returns an
 * execution error to propagate, or null when the workspace is writable or this is
 * not the research-declared-no-writes case. Called only from write-requiring paths
 * (implementation_agent's requireWrite path); read paths never reach it.
 */
export function researchDeclaredNoWritesGuard(
  ctx: Parameters<BlockExecuteFn>[2],
): BlockExecutionResult | null {
  if (!promotableEntryKind(ctx.entry.kind)) return null;
  const manifest = ctx.workspaceManifest;
  if (manifest?.version !== 2) return null;
  if (ctx.researchWriteRepositories.length > 0) return null;
  if (!ctx.definitionNodes.some((node) => node.type === "planning_agent")) {
    return null;
  }
  if (manifest.repositories.length === 0) return null;
  if (
    !manifest.repositories.every((repository) => repository.access === "read")
  ) {
    return null;
  }
  return executionError(
    "research declared no repository changes; nothing to implement, replan required",
    { category: "engine", phase: "impl" },
  );
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
