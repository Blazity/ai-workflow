import { start } from "workflow/api";
import type { Db } from "../db/client.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { AgentWorkflowInput, PrTriggerPayload } from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import { findWorkflowOwnedPullRequest } from "../db/queries/workflow-owned-branches.js";
import { getEnabledWorkflowDefinitionForTrigger } from "../workflow-definition/store.js";
import { createAdapters } from "./adapters.js";
import { claimSubjectRun } from "./dispatch.js";
import { logger } from "./logger.js";
import { prSubjectKey, ticketSubjectKey } from "./subject-key.js";
import {
  acceptTriggerDelivery,
  coalescePendingTrigger,
  completeTriggerDelivery,
  deletePendingTrigger,
  getTriggerDelivery,
  listPendingTriggersForSubject,
  type AcceptedTriggerDelivery,
  type StoredTriggerResult,
  type TriggerScope,
} from "./trigger-delivery-store.js";
import type { TriggerEvent } from "./trigger-events.js";
import { createRepositoryVCS } from "./vcs-runtime.js";

export type DispatchTriggerResult =
  | { result: "no_definition" }
  | { result: "ignored_not_workflow_owned" }
  | { result: "ignored_provider" }
  | { result: "ignored_producer" }
  | { result: "ignored_stale_head" }
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
  /** Failure-injection seam; production uses deletePendingTrigger. */
  deletePending?: typeof deletePendingTrigger;
}

function triggerNodeParams(
  definition: { nodes: { type: string; params: Record<string, unknown> }[] },
  triggerType: string,
): Record<string, unknown> {
  return definition.nodes.find((node) => node.type === triggerType)?.params ?? {};
}

export async function resolveEnabledReviewStates(db: Db): Promise<string[]> {
  const enabled = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review");
  if (!enabled?.current) return ["changes_requested"];
  const on = triggerNodeParams(enabled.current.definition, "trigger_pr_review").on;
  return Array.isArray(on) && on.length > 0
    ? on.filter((state): state is string => typeof state === "string")
    : ["changes_requested"];
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

  // Delivery identity is immutable. A retry must return the first attempt's
  // durable result without consulting mutable definition/head/correlation state.
  const existing = await getTriggerDelivery(
    deps.db,
    event.delivery.provider,
    event.delivery.deliveryId,
  );
  if (existing) {
    // The process may have died after durable acceptance but before recording
    // dispatch. Resume the exact pinned envelope; owner CAS still guarantees
    // that concurrent redeliveries cannot start two effective runs.
    if (existing.status === "accepted" && existing.result === null) {
      return resumeAcceptedTrigger(existing, deps);
    }
    return storedResultToDispatch(existing.result);
  }

  const enabled = await getEnabledWorkflowDefinitionForTrigger(deps.db, event.triggerType);
  if (!enabled?.current) return { result: "no_definition" };

  const params = triggerNodeParams(enabled.current.definition, event.triggerType);
  const providers = params.providers;
  if (Array.isArray(providers) && providers.length > 0 && !providers.includes(event.pr.provider)) {
    return { result: "ignored_provider" };
  }
  if (event.triggerType === "trigger_pr_checks_failed") {
    const configured = Array.isArray(params.producers)
      ? params.producers.filter((producer): producer is string => typeof producer === "string")
      : ["github-actions", "gitlab-ci"];
    if (!configured.includes(event.delivery.producer)) {
      logger.info(
        { provider: event.delivery.provider, producer: event.delivery.producer },
        "trigger_ignored_untrusted_ci_producer",
      );
      return { result: "ignored_producer" };
    }
  }

  const currentHead = await readCurrentHead(event.pr, deps);
  if (currentHead.status === "unreachable") return { result: "error" };
  if (currentHead.headSha !== event.pr.headSha) {
    logger.info(
      { subject: event.pr, currentHead: currentHead.headSha },
      "trigger_ignored_stale_head",
    );
    return { result: "ignored_stale_head" };
  }

  const scope: TriggerScope = params.scope === "any" ? "any" : "workflow_owned";
  const identity = await resolveSubjectIdentity(event, scope, deps);
  if (!identity) return { result: "ignored_not_workflow_owned" };

  const accepted: AcceptedTriggerDelivery = {
    ...event,
    scope,
    subjectKey: identity.subjectKey,
    ticketKey: identity.ticketKey,
    definitionId: enabled.definition.id,
    definitionVersion: enabled.current.version,
  };

  try {
    const durable = await acceptTriggerDelivery(deps.db, accepted);
    if (!durable.inserted) {
      return durable.stored.status === "accepted" && durable.stored.result === null
        ? resumeAcceptedTrigger(durable.stored, deps)
        : storedResultToDispatch(durable.stored.result);
    }
    return await dispatchAcceptedTrigger(accepted, deps);
  } catch (error) {
    logger.warn(
      { delivery: event.delivery, error: (error as Error).message },
      "trigger_delivery_dispatch_failed",
    );
    return { result: "error" };
  }
}

async function resumeAcceptedTrigger(
  accepted: AcceptedTriggerDelivery,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult> {
  const currentHead = await readCurrentHead(accepted.pr, deps);
  if (currentHead.status === "unreachable") return { result: "error" };
  if (currentHead.headSha !== accepted.pr.headSha) {
    await completeAccepted(deps.db, accepted, { result: "ignored_stale_head" });
    return { result: "ignored_stale_head" };
  }
  return dispatchAcceptedTrigger(accepted, deps);
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
  const inputBase = {
    kind: "pr_trigger" as const,
    triggerType: accepted.triggerType,
    subjectKey: accepted.subjectKey,
    ...(accepted.ticketKey ? { ticketKey: accepted.ticketKey } : {}),
    definitionId: accepted.definitionId,
    definitionVersion: accepted.definitionVersion,
    scope: accepted.scope,
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
    await completeAccepted(deps.db, accepted, result);
    return result;
  }

  if (dispatched.reason === "already_claimed" || dispatched.reason === "at_capacity") {
    await coalescePendingTrigger(deps.db, accepted);
    await completeAccepted(deps.db, accepted, { result: "coalesced" });
    return { result: "coalesced" };
  }

  // A start failure is durable too: retain the accepted semantic event for the
  // owner/reconciliation drain instead of relying on provider retry timing.
  await coalescePendingTrigger(deps.db, accepted);
  await completeAccepted(deps.db, accepted, { result: "coalesced" });
  return { result: "coalesced" };
}

/** Called only after an owner-matching terminal release returned true. */
export async function drainOldestPendingTrigger(
  subjectKey: string,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult | null> {
  for (const pending of await listPendingTriggersForSubject(deps.db, subjectKey)) {
    const currentHead = await readCurrentHead(pending.pr, deps);
    if (currentHead.status === "unreachable") return { result: "error" };
    if (currentHead.headSha !== pending.pr.headSha) {
      await deletePendingTrigger(deps.db, pending);
      await completeAccepted(deps.db, pending, { result: "ignored_stale_head" });
      continue;
    }
    const result = await dispatchAcceptedTrigger(pending, deps, {
      headSha: pending.pr.headSha,
      triggerType: pending.triggerType,
      deliveryId: pending.delivery.deliveryId,
    });
    if (result.result === "started") {
      await (deps.deletePending ?? deletePendingTrigger)(deps.db, pending).catch((error) => {
        logger.warn(
          { subjectKey, error: (error as Error).message },
          "trigger_pending_dispatcher_delete_failed",
        );
        return false;
      });
    }
    // Capacity/claim races stay pending. Drain starts at most one successor.
    return result;
  }
  return null;
}

async function resolveSubjectIdentity(
  event: TriggerEvent,
  scope: TriggerScope,
  deps: DispatchTriggerDeps,
): Promise<{ subjectKey: string; ticketKey: string | null } | null> {
  if (scope === "any") {
    return {
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
  });
  if (!correlation) return null;

  try {
    const issueTracker = deps.issueTracker ?? createAdapters().issueTracker;
    const ticket = await issueTracker.fetchTicket(correlation.ticketKey);
    if (ticket.identifier.trim().toUpperCase() !== correlation.ticketKey.trim().toUpperCase()) {
      return null;
    }
    return {
      subjectKey: ticketSubjectKey("jira", correlation.ticketKey),
      ticketKey: correlation.ticketKey,
    };
  } catch {
    return null;
  }
}

async function readCurrentHead(
  pr: PrTriggerPayload,
  deps: DispatchTriggerDeps,
): Promise<{ status: "ok"; headSha: string } | { status: "unreachable" }> {
  try {
    const headSha = deps.getCurrentHead
      ? await deps.getCurrentHead(pr)
      : await createRepositoryVCS({
          provider: pr.provider,
          repoPath: pr.repoPath,
          baseBranch: pr.baseRef,
        }).getBranchSha(pr.headRef);
    return { status: "ok", headSha };
  } catch (error) {
    logger.warn(
      { provider: pr.provider, repoPath: pr.repoPath, error: (error as Error).message },
      "trigger_current_head_lookup_failed_closed",
    );
    return { status: "unreachable" };
  }
}

async function completeAccepted(
  db: Db,
  accepted: AcceptedTriggerDelivery,
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
  if (result.result === "ignored_stale_head") return { result: "ignored_stale_head" };
  if (result.result === "at_capacity") return { result: "at_capacity" };
  if (result.result === "error") return { result: "error" };
  return { result: "coalesced" };
}
