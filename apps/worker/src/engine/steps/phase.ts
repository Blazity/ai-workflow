/* eslint-disable max-lines, max-lines-per-function */
import type { AgentOutput, AgentProtocolResult, CollectedPhaseArtifacts, PhaseUsage, PhaseKind, PhaseArtifactPaths, ResearchResult, ReviewOutput } from "../../sandbox/agents/types.js";
import type { AgentKind } from "../../sandbox/agents/index.js";
import { isAgentRuntimeError } from "../../sandbox/agents/runtime-error.js";
import type { TicketAttachment } from "../../adapters/issue-tracker/types.js";
import type { DownloadedAttachment } from "../../sandbox/attachments.js";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import { executionError, type StepsRecord } from "../../workflow-definition/interpreter.js";
import type { BlockExecutionResult } from "../../workflow-definition/interpreter.js";
import { agentProtocolExecutionError as agentProtocolBlockError, type EngineCtx } from "../blocks/support/types.js";
import { type WorkspaceManifest, type WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import type { RepositoryExpansionDecision } from "../internal/ports.js";
import { ensureAgentSandbox } from "../blocks/agent-sandbox.js";
import { recoverChecksCeilingFromSteps } from "../blocks/pre-pr-checks.js";
import { addElapsed, checksElapsedOf, createRunBudgetState, observeRunBudget, recordBudgetUsage, type RunBudgetAttribution, type RunBudgetLimits, type RunBudgetObservation } from "../helpers/run-budget.js";
import { isRunControlError } from "../helpers/run-control-error.js";
import type { VcsProviderKind, WorkflowRepositoryScope } from "@shared/contracts";
import { combineHarnessRuntimeLimits } from "../../sandbox/harness-runtime-limits.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";

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
function checksCeilingOption(steps: StepsRecord): { checksCeilingMs?: number } {
  const ceilingMs = recoverChecksCeilingFromSteps(steps);
  return ceilingMs === null ? {} : { checksCeilingMs: ceilingMs };
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
    "../../repository-discovery/runner.js"
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

// --- Step Functions ---

async function fetchAttachments(
  ticketIdentifier: string,
  attachments: TicketAttachment[],
) {
  "use step";
  const { loadAdaptersPort, loadEnvironmentPort } = await import(
    "../internal/ports.js"
  );
  const { logger } = await import("../../infra/logger.js");
  const log = logger.child({ ticket_identifier: ticketIdentifier, step: "fetchAttachments" });
  log.info({ count: attachments.length }, "fetchAttachments: start");

  if (attachments.length === 0) {
    log.info({}, "fetchAttachments: no attachments");
    return [];
  }

  const { env } = await loadEnvironmentPort();
  const { createAdapters } = await loadAdaptersPort();
  const { fetchAttachmentsWithRetry } = await import("../../sandbox/attachments.js");
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
  const { logger } = await import("../../infra/logger.js");
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
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");

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
    const { isRunControlError } = await import("../helpers/run-control-error.js");
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
  const { fetchModelPrice } = await import("../../sandbox/agents/pricing.js");
  try {
    return await fetchModelPrice(model);
  } catch (err) {
    const { logger } = await import("../../infra/logger.js");
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
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");

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
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
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
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
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
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
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
  const { loadEnvironmentPort } = await import("../internal/ports.js");
  const { getConfiguredVcsProviders } = await loadEnvironmentPort();
  const { createRepositoryDirectoryForProviders } = await import(
    "../../adapters/vcs/repository-directory.js"
  );
  const { buildRepositoryCatalog } = await import(
    "../../repository-discovery/catalog.js"
  );
  const { filterRepositoriesForScope } = await import(
    "../../lib/repo-allowlist.js"
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
  const { loadAdaptersPort, loadEnvironmentPort, loadVcsRuntimePort } = await import(
    "../internal/ports.js"
  );
  const { Sandbox } = await import("@vercel/sandbox");
  const { env } = await loadEnvironmentPort();
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { buildSandboxProviderConfigs } = await loadVcsRuntimePort();
  const {
    attachResearchRepositories,
    materializeResearchRepositories,
  } = await import(
    "../../sandbox/research-workspace.js"
  );
  // AIW-147 minor: re-check the allowlist at the single materialization choke
  // point every attach path shares, so an allowlist tightened mid-run cuts off
  // new read attaches before any clone happens (the earlier catalog check may be
  // stale by the time this step runs).
  const { isRepoAllowedForScope } = await import("../../lib/repo-allowlist.js");
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
  const { createAdapters } = await loadAdaptersPort();
  const { stopSandboxAndConfirm } = await import(
    "../../sandbox/stop-ticket-sandboxes.js"
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
  const {
    loadEnvironmentPort,
    loadRepositoryDiscoveryPort,
  } = await import("../internal/ports.js");
  const { getConfiguredVcsProviders } = await loadEnvironmentPort();
  const { createRepositoryDirectoryForProviders } = await import(
    "../../adapters/vcs/repository-directory.js"
  );
  const { buildRepositoryCatalog } = await import(
    "../../repository-discovery/catalog.js"
  );
  const { filterRepositoriesForScope } = await import(
    "../../lib/repo-allowlist.js"
  );
  const { validateHumanRepositoryExpansion } =
    await loadRepositoryDiscoveryPort();
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
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
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
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  return {
    result: a.parseReviewOutputProtocol(artifacts, phase),
    usage: a.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

export interface HarnessInvocationBudget {
  limits: RunBudgetLimits;
  observeBudget(
    requireRemainingDuration?: boolean,
    attribution?: RunBudgetAttribution,
    observedAtMs?: number,
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
    observedAtMs?: number,
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
      observedAtMs?: number,
    ) {
      const workflow = observedAtMs === undefined
        ? await observeWorkflowBudget(requireRemainingDuration, attribution)
        : await observeWorkflowBudget(requireRemainingDuration, attribution, observedAtMs);
      const now = observedAtMs ?? await readClock();
      state = addElapsed(state, now - lastClockMs, attribution);
      lastClockMs = Math.max(lastClockMs, now);
      const profile = observeRunBudget(
        state,
        limits,
        requireRemainingDuration,
      );
      return {
        ...mergeBudgetObservations(workflow, profile),
        observedAtMs: lastClockMs,
      };
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
  const observedAtValues = [workflow.observedAtMs, profile.observedAtMs].filter(
    (value): value is number => value !== undefined,
  );
  const observedAt = observedAtValues.length > 0
    ? { observedAtMs: Math.max(...observedAtValues) }
    : {};
  if (workflow.check.status !== "ok") {
    return { ...workflow, remainingDurationMs, checksElapsedMs, ...observedAt };
  }
  if (profile.check.status !== "ok") {
    return { ...profile, remainingDurationMs, checksElapsedMs, ...observedAt };
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
    ...observedAt,
  };
}
export { attachResearchRepositoriesStep, checksCeilingOption, fetchAttachments, fetchModelPriceStep, listFreshRepositoryCatalogStep, parseAgentOutputStep, parseRepositoryDiscoveryStep, parseResearchStep, parseReviewStep, planPhaseStep, readRunBudgetClockStep, resolveHumanRepositoryExpansionStep, setCommitGuardStep, writeAndStartPhase, writeAttachments };
