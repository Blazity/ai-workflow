import { start } from "workflow/api";
import type { VcsProviderKind } from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type {
  LatestCheckRun,
  PullRequestHead,
  VCSAdapter,
} from "../adapters/vcs/types.js";
import type { AgentWorkflowInput, PrTriggerPayload } from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import {
  bindWorkflowOwnedPullRequestIntent,
  findWorkflowOwnedPullRequest,
  findWorkflowOwnedPullRequestIntent,
} from "../db/queries/workflow-owned-branches.js";
import { getEnabledWorkflowDefinitionForTrigger } from "../workflow-definition/store.js";
import { createAdapters } from "./adapters.js";
import { claimSubjectRun } from "./dispatch.js";
import { logger } from "./logger.js";
import { isRepoAllowed } from "./repo-allowlist.js";
import { prSubjectKey, ticketSubjectKey } from "./subject-key.js";
import {
  acceptReceivedTriggerDelivery,
  coalescePendingTrigger,
  completeReceivedTriggerDelivery,
  completeTriggerDelivery,
  deletePendingTrigger,
  getTriggerDelivery,
  listPendingTriggersForSubject,
  receiveTriggerDelivery,
  type AcceptedTriggerDelivery,
  type ReceivedTriggerDelivery,
  type StoredTriggerDelivery,
  type StoredTriggerResult,
  type TriggerScope,
} from "./trigger-delivery-store.js";
import type { TriggerEvent } from "./trigger-events.js";
import { createRepositoryVCS } from "./vcs-runtime.js";
import { normalizeVcsLogin } from "./vcs-bot-identity.js";

export type DispatchTriggerResult =
  | { result: "no_definition" }
  | { result: "ignored_not_workflow_owned" }
  | { result: "ignored_provider" }
  | { result: "ignored_producer" }
  | { result: "ignored_stale_head" }
  | { result: "ignored_untrusted_event" }
  | { result: "ignored_malformed_delivery" }
  | { result: "coalesced" }
  | { result: "at_capacity" }
  | { result: "error" }
  | { result: "started"; runId: string };

export interface DispatchTriggerDeps {
  db: Db;
  runRegistry: RunRegistryAdapter;
  maxConcurrentAgents: number;
  issueTracker?: IssueTrackerAdapter;
  getCurrentHead?: (pr: PrTriggerPayload) => Promise<string>;
  getCurrentPullRequest?: (pr: PrTriggerPayload) => Promise<PullRequestHead>;
  getLatestCheckRuns?: (pr: PrTriggerPayload) => Promise<LatestCheckRun[]>;
  isRepositoryConfigured?: (pr: PrTriggerPayload) => Promise<boolean>;
  /** Failure-injection seam; production uses deletePendingTrigger. */
  deletePending?: typeof deletePendingTrigger;
}

function triggerNodeParams(
  definition: { nodes: { type: string; params: Record<string, unknown> }[] },
  triggerType: string,
): Record<string, unknown> {
  return definition.nodes.find((node) => node.type === triggerType)?.params ?? {};
}

export async function resolveEnabledReviewStates(
  db: Db,
  provider: VcsProviderKind,
  botLogin: string | undefined,
): Promise<string[]> {
  const enabled = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review");
  if (!enabled?.current) return provider === "github" ? ["changes_requested"] : [];
  const params = triggerNodeParams(enabled.current.definition, "trigger_pr_review");
  const providers = Array.isArray(params.providers) ? params.providers : ["github"];
  if (!providers.includes(provider)) return [];

  const configuredStates =
    Array.isArray(params.on) && params.on.length > 0 ? params.on : ["changes_requested"];
  return configuredStates.filter(
    (state): state is string =>
      (state === "changes_requested" && provider === "github") ||
      (state === "commented" && Boolean(normalizeVcsLogin(botLogin))),
  );
}

export async function dispatchTriggerEvent(
  event: TriggerEvent,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult> {
  if (
    !event.delivery?.deliveryId ||
    event.delivery.provider !== event.pr.provider ||
    event.delivery.deliveryId.trim().length === 0
  ) {
    return { result: "ignored_malformed_delivery" };
  }

  // Delivery identity and pinned definition are immutable. An unfinished retry
  // resumes the durable envelope through enrichment or dispatch; a completed
  // retry returns its stored result.
  const existing = await getTriggerDelivery(
    deps.db,
    event.delivery.provider,
    event.delivery.deliveryId,
  );
  if (existing) {
    return resumeStoredTriggerDelivery(existing, deps);
  }

  const enabled = await getEnabledWorkflowDefinitionForTrigger(deps.db, event.triggerType);
  if (!enabled?.current) return { result: "no_definition" };

  const params = triggerNodeParams(enabled.current.definition, event.triggerType);
  const providers = params.providers;
  if (Array.isArray(providers) && providers.length > 0 && !providers.includes(event.pr.provider)) {
    return { result: "ignored_provider" };
  }
  const scope: TriggerScope = params.scope === "any" ? "any" : "workflow_owned";
  if (scope === "any" && !isRepoAllowed(event.pr.repoPath)) {
    logger.info(
      { provider: event.pr.provider, repoPath: event.pr.repoPath },
      "trigger_repo_not_allowed",
    );
    return { result: "ignored_provider" };
  }

  const eligibleEvent = selectEligibleEvent(event, params);
  if (!eligibleEvent) return { result: "ignored_untrusted_event" };

  const received: ReceivedTriggerDelivery = {
    ...eligibleEvent,
    scope,
    definitionId: enabled.definition.id,
    definitionVersion: enabled.current.version,
  };

  try {
    const durable = await receiveTriggerDelivery(deps.db, received);
    return await resumeStoredTriggerDelivery(durable.stored, deps);
  } catch (error) {
    logger.warn(
      { delivery: event.delivery, error: (error as Error).message },
      "trigger_delivery_dispatch_failed",
    );
    return { result: "error" };
  }
}

async function resumeStoredTriggerDelivery(
  stored: StoredTriggerDelivery,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult> {
  if (stored.status === "received" && stored.result === null) {
    return enrichReceivedTrigger(stored, deps);
  }
  if (stored.status === "accepted" && stored.result === null) {
    const accepted = acceptedFromStored(stored);
    if (!accepted) return { result: "error" };
    return resumeAcceptedTrigger(accepted, deps);
  }
  return storedResultToDispatch(stored.result);
}

async function enrichReceivedTrigger(
  received: StoredTriggerDelivery,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult> {
  const event = triggerEventFromStored(received);
  const repositoryScope = await readRepositoryScope(event.pr, deps);
  if (repositoryScope.status === "unreachable") return { result: "error" };
  if (!repositoryScope.configured) {
    return completeReceivedDelivery(received, { result: "ignored_provider" }, deps);
  }
  const currentResult = await readCurrentPullRequest(event.pr, deps);
  if (currentResult.status === "unreachable") return { result: "error" };
  const currentEvent = bindCurrentPullRequest(event, currentResult.current);
  if (!currentEvent) {
    logger.info(
      { subject: event.pr, current: currentResult.current },
      "trigger_ignored_stale_head",
    );
    return completeReceivedDelivery(
      received,
      { result: "ignored_stale_head" },
      deps,
    );
  }

  const identity = await resolveSubjectIdentity(currentEvent, received.scope, deps);
  if (identity.status === "ignored") {
    return completeReceivedDelivery(
      received,
      { result: "ignored_not_workflow_owned" },
      deps,
    );
  }
  if (identity.status === "retryable_error") return { result: "error" };

  const accepted: AcceptedTriggerDelivery = {
    ...currentEvent,
    scope: received.scope,
    subjectKey: identity.subjectKey,
    ticketKey: identity.ticketKey,
    definitionId: received.definitionId,
    definitionVersion: received.definitionVersion,
  };
  const enrichment = await acceptReceivedTriggerDelivery(deps.db, accepted);
  if (!enrichment.enriched) {
    return resumeStoredTriggerDelivery(enrichment.stored, deps);
  }
  if (identity.status === "pending_correlation") return { result: "error" };
  return dispatchAcceptedTrigger(accepted, deps);
}

async function readRepositoryScope(
  pr: PrTriggerPayload,
  deps: DispatchTriggerDeps,
): Promise<{ status: "ok"; configured: boolean } | { status: "unreachable" }> {
  try {
    const configured = deps.isRepositoryConfigured
      ? await deps.isRepositoryConfigured(pr)
      : await isConfiguredTriggerRepository(pr);
    return { status: "ok", configured };
  } catch (error) {
    logger.warn(
      { provider: pr.provider, repoPath: pr.repoPath, error: (error as Error).message },
      "trigger_repository_scope_lookup_failed_closed",
    );
    return { status: "unreachable" };
  }
}

async function isConfiguredTriggerRepository(pr: PrTriggerPayload): Promise<boolean> {
  if (pr.provider !== "gitlab") return true;
  const { env, getConfiguredVcsProviders } = await import("../../env.js");
  if (env.GITLAB_PROJECT_ID) {
    return (
      pr.repoPath === env.GITLAB_PROJECT_ID ||
      String(pr.providerProjectId ?? "") === env.GITLAB_PROJECT_ID
    );
  }
  const { createRepositoryDirectoryForProviders } = await import(
    "../adapters/vcs/repository-directory.js"
  );
  const providers = getConfiguredVcsProviders().filter(
    (provider) => provider.kind === "gitlab",
  );
  if (providers.length === 0) return false;
  const repositories = await createRepositoryDirectoryForProviders(
    providers,
  ).listRepositories();
  return repositories.some(
    (repository) =>
      repository.provider === "gitlab" && repository.repoPath === pr.repoPath,
  );
}

async function completeReceivedDelivery(
  received: StoredTriggerDelivery,
  result: StoredTriggerResult,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult> {
  const completed = await completeReceivedTriggerDelivery(
    deps.db,
    received.delivery.provider,
    received.delivery.deliveryId,
    result,
  );
  if (completed) return storedResultToDispatch(result);

  const current = await getTriggerDelivery(
    deps.db,
    received.delivery.provider,
    received.delivery.deliveryId,
  );
  if (!current || (current.status === "received" && current.result === null)) {
    return { result: "error" };
  }
  return resumeStoredTriggerDelivery(current, deps);
}

function triggerEventFromStored(stored: StoredTriggerDelivery): TriggerEvent {
  return {
    delivery: stored.delivery,
    triggerType: stored.triggerType,
    pr: stored.pr,
  };
}

function acceptedFromStored(stored: StoredTriggerDelivery): AcceptedTriggerDelivery | null {
  if (stored.subjectKey === null) return null;
  return {
    ...triggerEventFromStored(stored),
    scope: stored.scope,
    subjectKey: stored.subjectKey,
    ticketKey: stored.ticketKey,
    definitionId: stored.definitionId,
    definitionVersion: stored.definitionVersion,
  };
}

async function resumeAcceptedTrigger(
  accepted: AcceptedTriggerDelivery,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult> {
  const currentResult = await readCurrentPullRequest(accepted.pr, deps);
  if (currentResult.status === "unreachable") return { result: "error" };
  const currentAccepted = bindCurrentPullRequest(accepted, currentResult.current);
  if (!currentAccepted) {
    await completeDelivery(deps.db, accepted, { result: "ignored_stale_head" });
    return { result: "ignored_stale_head" };
  }
  if (currentAccepted.scope === "workflow_owned") {
    const identity = await resolveSubjectIdentity(currentAccepted, currentAccepted.scope, deps);
    if (identity.status === "pending_correlation" || identity.status === "retryable_error") {
      return { result: "error" };
    }
    if (
      identity.status === "ignored" ||
      identity.subjectKey !== currentAccepted.subjectKey ||
      identity.ticketKey !== currentAccepted.ticketKey
    ) {
      await completeDelivery(deps.db, currentAccepted, {
        result: "ignored_not_workflow_owned",
      });
      return { result: "ignored_not_workflow_owned" };
    }
  }
  return dispatchAcceptedTrigger(currentAccepted, deps);
}

/**
 * Poll-side recovery for a process death after durable receipt but before
 * enrichment or the pending snapshot/result write. Re-read the row so a stale
 * scan cannot replay a delivery that another dispatcher already completed.
 */
export async function recoverAcceptedTriggerDelivery(
  scanned: StoredTriggerDelivery,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult | null> {
  const current = await getTriggerDelivery(
    deps.db,
    scanned.delivery.provider,
    scanned.delivery.deliveryId,
  );
  if (
    !current ||
    (current.status !== "received" && current.status !== "accepted") ||
    current.result !== null
  ) {
    return null;
  }
  return resumeStoredTriggerDelivery(current, deps);
}

function selectEligibleEvent(
  event: TriggerEvent,
  params: Record<string, unknown>,
): TriggerEvent | null {
  if (event.triggerType !== "trigger_pr_checks_failed") return event;

  const checkNames = stringArray(params.checkNames);
  if (checkNames.length === 0) return null;
  if (event.pr.provider === "github") {
    const trustedApps = stringArray(params.githubAppSlugs, ["github-actions"]);
    if (!trustedApps.includes(event.delivery.producer)) return null;
  } else {
    const trustedSources = stringArray(params.gitlabPipelineSources, ["merge_request_event"]);
    if (!event.delivery.source || !trustedSources.includes(event.delivery.source)) return null;
  }

  const failedChecks = (event.pr.failedChecks ?? []).filter(
    (check) => checkNames.includes(check.name),
  );
  if (failedChecks.length === 0) return null;
  return {
    ...event,
    pr: { ...event.pr, failedChecks },
  };
}

function stringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

async function dispatchAcceptedTrigger(
  accepted: AcceptedTriggerDelivery,
  deps: DispatchTriggerDeps,
  pendingEvent?: {
    headSha: string;
    triggerType: AcceptedTriggerDelivery["triggerType"];
    deliveryId: string;
  },
): Promise<DispatchTriggerResult> {
  // Persist the exact accepted envelope before a Workflow candidate can be
  // started. The candidate removes this row only after it wins owner CAS and
  // binds its runtime id. If start returns but that candidate never reaches
  // bind, stale-owner reconciliation can therefore recover the same pinned
  // definition and provider snapshot without waiting for a redelivery.
  await coalescePendingTrigger(deps.db, accepted);

  const inputBase = {
    kind: "pr_trigger" as const,
    triggerType: accepted.triggerType,
    subjectKey: accepted.subjectKey,
    ...(accepted.ticketKey ? { ticketKey: accepted.ticketKey } : {}),
    definitionId: accepted.definitionId,
    definitionVersion: accepted.definitionVersion,
    scope: accepted.scope,
    delivery: accepted.delivery,
    ...(pendingEvent ? { pendingEvent } : {}),
    pr: accepted.pr,
  };
  const dispatched = await claimSubjectRun(
    {
      subjectKey: accepted.subjectKey,
      ticketKey: accepted.ticketKey,
      kind: "pr_trigger",
    },
    deps.runRegistry,
    deps.maxConcurrentAgents,
    {
      startWorkflow: async (ownerToken) => {
        const input: AgentWorkflowInput = { ...inputBase, ownerToken };
        const handle = await start(agentWorkflow, [input]);
        return handle.runId;
      },
    },
  );

  if (dispatched.started) {
    const result = { result: "started" as const, runId: dispatched.runId! };
    await completeDelivery(deps.db, accepted, {
      result: "candidate_started",
      runId: dispatched.runId!,
    });
    return result;
  }

  if (dispatched.reason === "already_claimed" || dispatched.reason === "at_capacity") {
    return coalesceOrRecoverStarted(accepted, deps.db);
  }

  // A start failure is durable too: retain the accepted semantic event for the
  // owner/reconciliation drain instead of relying on provider retry timing.
  return coalesceOrRecoverStarted(accepted, deps.db);
}

async function coalesceOrRecoverStarted(
  accepted: AcceptedTriggerDelivery,
  db: Db,
): Promise<DispatchTriggerResult> {
  await completeDelivery(db, accepted, { result: "coalesced" });

  // The winning workflow may have bound and self-recorded `started` after this
  // recovery read began. Preserve that stronger result and remove only this
  // delivery's pending snapshot; a newer merged delivery has a different CAS
  // token and remains queued.
  const stored = await getTriggerDelivery(
    db,
    accepted.delivery.provider,
    accepted.delivery.deliveryId,
  );
  if (stored?.result?.result === "started") {
    await deletePendingTrigger(db, accepted);
    return stored.result;
  }
  if (stored?.result?.result === "candidate_started") {
    // This dispatch attempt lost owner CAS to the already-recorded candidate.
    // Keep the durable pending snapshot for that candidate's bind, but report
    // no new start so poll recovery metrics do not double-count the same run.
    return { result: "coalesced" };
  }
  return { result: "coalesced" };
}

/** Called only after an owner-matching terminal release returned true. */
export async function drainOldestPendingTrigger(
  subjectKey: string,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult | null> {
  for (const pending of await listPendingTriggersForSubject(deps.db, subjectKey)) {
    const stored = await getTriggerDelivery(
      deps.db,
      pending.delivery.provider,
      pending.delivery.deliveryId,
    );
    if (stored?.result?.result === "started") {
      await (deps.deletePending ?? deletePendingTrigger)(deps.db, pending).catch((error) => {
        logger.warn(
          { subjectKey, error: (error as Error).message },
          "trigger_stale_started_pending_delete_failed",
        );
        return false;
      });
      continue;
    }

    const currentResult = await readCurrentPullRequest(pending.pr, deps);
    if (currentResult.status === "unreachable") return { result: "error" };
    const currentPending = bindCurrentPullRequest(pending, currentResult.current);
    if (!currentPending) {
      await deletePendingTrigger(deps.db, pending);
      await completeDelivery(deps.db, pending, { result: "ignored_stale_head" });
      continue;
    }
    const result = await dispatchAcceptedTrigger(currentPending, deps, {
      headSha: pending.pr.headSha,
      triggerType: pending.triggerType,
      deliveryId: pending.delivery.deliveryId,
    });
    // Capacity/claim races stay pending. Drain starts at most one successor.
    return result;
  }
  return null;
}

async function resolveSubjectIdentity(
  event: TriggerEvent,
  scope: TriggerScope,
  deps: DispatchTriggerDeps,
): Promise<
  | {
      status: "resolved" | "pending_correlation";
      subjectKey: string;
      ticketKey: string | null;
    }
  | { status: "ignored" }
  | { status: "retryable_error" }
> {
  if (scope === "any") {
    return {
      status: "resolved",
      subjectKey: prSubjectKey(event.pr.provider, event.pr.repoPath, event.pr.prNumber),
      ticketKey: null,
    };
  }

  const correlation = await findWorkflowOwnedPullRequest(deps.db, {
    provider: event.pr.provider,
    repoPath: event.pr.repoPath,
    prNumber: event.pr.prNumber,
    branchName: event.pr.headRef,
    publishedHeadSha: event.pr.headSha,
    baseBranch: event.pr.baseRef,
  });
  if (correlation) {
    return resolveTicketIdentity(correlation.ticketKey, "resolved", deps);
  }

  const intent = await findWorkflowOwnedPullRequestIntent(deps.db, {
    provider: event.pr.provider,
    repoPath: event.pr.repoPath,
    branchName: event.pr.headRef,
    publishedHeadSha: event.pr.headSha,
    baseBranch: event.pr.baseRef,
  });
  if (!intent) return { status: "ignored" };
  if (event.triggerType !== "trigger_pr_created") {
    return resolveTicketIdentity(intent.ticketKey, "pending_correlation", deps);
  }

  const bound = await bindWorkflowOwnedPullRequestIntent(deps.db, {
    ticketKey: intent.ticketKey,
    provider: event.pr.provider,
    repoPath: event.pr.repoPath,
    branchName: event.pr.headRef,
    publishedHeadSha: event.pr.headSha,
    baseBranch: event.pr.baseRef,
    prNumber: event.pr.prNumber,
    prUrl: event.pr.prUrl,
  });
  if (bound) return resolveTicketIdentity(bound.ticketKey, "resolved", deps);

  // The CAS can lose to publication correlation or a newer intent between
  // lookup and bind. Re-read exact state; never dispatch from the stale
  // pre-CAS snapshot.
  const concurrent = await findWorkflowOwnedPullRequest(deps.db, {
    provider: event.pr.provider,
    repoPath: event.pr.repoPath,
    prNumber: event.pr.prNumber,
    branchName: event.pr.headRef,
    publishedHeadSha: event.pr.headSha,
    baseBranch: event.pr.baseRef,
  });
  if (concurrent) return resolveTicketIdentity(concurrent.ticketKey, "resolved", deps);
  const stillPending = await findWorkflowOwnedPullRequestIntent(deps.db, {
    provider: event.pr.provider,
    repoPath: event.pr.repoPath,
    branchName: event.pr.headRef,
    publishedHeadSha: event.pr.headSha,
    baseBranch: event.pr.baseRef,
  });
  if (!stillPending) return { status: "ignored" };
  return resolveTicketIdentity(stillPending.ticketKey, "pending_correlation", deps);
}

async function resolveTicketIdentity(
  ticketKey: string,
  status: "resolved" | "pending_correlation",
  deps: DispatchTriggerDeps,
): Promise<
  | {
      status: "resolved" | "pending_correlation";
      subjectKey: string;
      ticketKey: string;
    }
  | { status: "ignored" }
  | { status: "retryable_error" }
> {
  try {
    const issueTracker = deps.issueTracker ?? createAdapters().issueTracker;
    const ticket = await issueTracker.fetchTicket(ticketKey);
    if (ticket.identifier.trim().toUpperCase() !== ticketKey.trim().toUpperCase()) {
      return { status: "ignored" };
    }
    return {
      status,
      subjectKey: ticketSubjectKey("jira", ticketKey),
      ticketKey,
    };
  } catch (error) {
    if (error instanceof IssueTrackerNotFoundError) return { status: "ignored" };
    logger.warn(
      { ticketKey, error: (error as Error).message },
      "trigger_ticket_identity_lookup_retryable_failure",
    );
    return { status: "retryable_error" };
  }
}

async function readCurrentPullRequest(
  pr: PrTriggerPayload,
  deps: DispatchTriggerDeps,
): Promise<
  | { status: "ok"; current: PullRequestHead }
  | { status: "unreachable" }
> {
  try {
    let adapter: VCSAdapter | undefined;
    let current: PullRequestHead;
    if (deps.getCurrentPullRequest) {
      current = await deps.getCurrentPullRequest(pr);
    } else if (deps.getCurrentHead) {
      current = { headSha: await deps.getCurrentHead(pr) };
    } else {
      adapter = createRepositoryVCS({
        provider: pr.provider,
        repoPath: pr.repoPath,
        baseBranch: pr.baseRef,
      });
      current = await adapter.getPRHead(pr.prNumber);
    }
    if (pr.provider === "github" && (pr.failedChecks?.length ?? 0) > 0) {
      const latestCheckRuns =
        current.latestCheckRuns ??
        (deps.getLatestCheckRuns
          ? await deps.getLatestCheckRuns(pr)
          : adapter?.getLatestCheckRuns
            ? await adapter.getLatestCheckRuns(current.headSha)
            : null);
      if (!latestCheckRuns) throw new Error("GitHub latest Check Runs are unavailable");
      current = { ...current, latestCheckRuns };
    }
    return { status: "ok", current };
  } catch (error) {
    logger.warn(
      { provider: pr.provider, repoPath: pr.repoPath, error: (error as Error).message },
      "trigger_current_head_lookup_failed_closed",
    );
    return { status: "unreachable" };
  }
}

function bindCurrentPullRequest<T extends TriggerEvent>(
  event: T,
  current: PullRequestHead | null,
): T | null {
  if (!current) return null;
  const { pr } = event;
  if (pr.provider === "github") {
    if (current.headSha !== pr.headSha) return null;
    if (event.triggerType !== "trigger_pr_checks_failed") return event;
    const failedChecks = (pr.failedChecks ?? []).filter((failed) =>
      current.latestCheckRuns?.some(
        (latest) =>
          latest.id === failed.checkRunId &&
          latest.name === failed.name &&
          latest.appSlug === failed.appSlug &&
          latest.status === "completed" &&
          latest.conclusion === failed.conclusion,
      ),
    );
    if (failedChecks.length === 0) return null;
    return { ...event, pr: { ...pr, failedChecks } };
  }
  if (pr.pipelineId === undefined) return current.headSha === pr.headSha ? event : null;
  if (current.headPipelineId !== pr.pipelineId) return null;
  if (pr.headSha && pr.headSha !== current.headSha) return null;
  return { ...event, pr: { ...pr, headSha: current.headSha } };
}

async function completeDelivery(
  db: Db,
  accepted: Pick<TriggerEvent, "delivery">,
  result: StoredTriggerResult,
) {
  await completeTriggerDelivery(
    db,
    accepted.delivery.provider,
    accepted.delivery.deliveryId,
    result,
  );
}

function storedResultToDispatch(result: StoredTriggerResult | null): DispatchTriggerResult {
  if (!result) return { result: "coalesced" };
  if (result.result === "started") return result;
  if (result.result === "candidate_started") {
    return { result: "started", runId: result.runId };
  }
  if (result.result === "ignored_stale_head") return { result: "ignored_stale_head" };
  if (result.result === "ignored_not_workflow_owned") {
    return { result: "ignored_not_workflow_owned" };
  }
  if (result.result === "ignored_provider") return { result: "ignored_provider" };
  if (result.result === "at_capacity") return { result: "at_capacity" };
  if (result.result === "error") return { result: "error" };
  return { result: "coalesced" };
}
