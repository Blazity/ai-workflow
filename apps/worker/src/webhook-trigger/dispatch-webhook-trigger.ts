import { createHash } from "node:crypto";
import { start } from "workflow/api";
import type { Db } from "../db/client.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { AgentWorkflowInput } from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import { claimSubjectRun } from "../lib/dispatch.js";
import { recordIngestionFailure } from "../lib/ingestion-diagnostic.js";
import { logger } from "../lib/logger.js";
import {
  enforceTriggerRateLimit,
  triggerRateLimitLogFields,
  type TriggerRateLimitConfig,
  type TriggerRateLimitDecision,
} from "../lib/trigger-rate-limit.js";
import { webhookSubjectKey } from "../lib/subject-key.js";
import {
  acceptWebhookDelivery,
  coalescePendingWebhookDelivery,
  completeWebhookDelivery,
  drainOldestPendingWebhookDelivery,
  getWebhookDelivery,
  listPendingWebhookDeliveries,
  recordWebhookDeliveryStarted,
  type AcceptedWebhookDelivery,
  type StoredWebhookDelivery,
  type StoredWebhookResult,
} from "./delivery-store.js";
import type { WebhookTriggerEntry } from "./payload-mapping.js";
import type { WebhookVerifiedWith } from "./verify.js";

/** Why an authenticated delivery still may not start. Re-checked under the
 *  reservation, because an endpoint can be revoked or a definition disabled
 *  while a delivery is in flight. */
export type WebhookDispatchGuardRejection =
  | "endpoint_revoked"
  | "definition_disabled"
  | "node_missing";

export interface WebhookDispatchTarget {
  endpointId: string;
  definitionId: number;
  /** Pinned version the delivery was accepted against. Passed to the guard so
   *  it can check the node against the exact graph this run would execute. */
  definitionVersion: number;
  nodeId: string;
}

export interface WebhookDispatchDeps {
  db: Db;
  runRegistry: RunRegistryAdapter;
  maxConcurrentAgents: number;
  /**
   * Re-read of endpoint and definition state, injected rather than imported so
   * this module stays independent of how endpoints are stored. Returns the
   * reason the delivery must not start, or null to proceed. Wired by the route
   * and cron layers.
   */
  ensureStillDispatchable: (
    target: WebhookDispatchTarget,
  ) => Promise<WebhookDispatchGuardRejection | null>;
  /**
   * The node's start budget, read from the definition version the delivery is
   * pinned to, or null when the node is unlimited. Injected for the same reason
   * as ensureStillDispatchable: this module does not know how definitions are
   * stored.
   */
  resolveTriggerRateLimit: (
    target: WebhookDispatchTarget,
  ) => Promise<TriggerRateLimitConfig | null>;
}

export interface DispatchWebhookDeliveryParams extends WebhookDispatchTarget {
  deliveryId: string;
  /** External identity from the endpoint's subjectPath, or null when the
   *  delivery has no subject of its own. */
  subjectId: string | null;
  entry: WebhookTriggerEntry;
  verifiedWith: WebhookVerifiedWith | null;
}

export type DispatchWebhookResult =
  | { result: "started"; runId: string }
  | { result: "coalesced" }
  | { result: "at_capacity" }
  | { result: "rejected"; reason: string }
  | { result: "error"; reason: string };

/** How many waiting subjects one drain pass starts at most. */
export const WEBHOOK_DRAIN_LIMIT = 10;

/** The stored reason on a delivery the node's rate limit refused. Terminal: the
 *  delivery is not replayed when the window rolls, because the limit drops
 *  excess starts rather than deferring them. */
export const RATE_LIMITED_DELIVERY_REASON = "rate_limited";

/** Count one delivery against the node's rate limit, or null when unlimited. */
async function consumeWebhookRateLimit(
  target: WebhookDispatchTarget,
  deps: WebhookDispatchDeps,
): Promise<TriggerRateLimitDecision | null> {
  const config = await deps.resolveTriggerRateLimit(target);
  if (config === null) return null;
  return enforceTriggerRateLimit(
    deps.db,
    { definitionId: String(target.definitionId), nodeId: target.nodeId },
    config,
    new Date(),
  );
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Identity for a sender that provides no delivery id header. The body's digest
 * dedupes retries of the same payload, and the six-hour bucket keeps a genuinely
 * repeated event (the same body sent again tomorrow) dispatchable instead of
 * being deduped away forever.
 *
 * The bucket is tumbling, not a sliding window: a retry that straddles a bucket
 * edge gets a different identity and can start at most one extra run, and clock
 * skew between the receiving instances widens that edge by the skew.
 */
export function fallbackWebhookDeliveryId(
  rawBody: string | Buffer,
  now: Date = new Date(),
): string {
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return `body:${digest}:${Math.floor(now.getTime() / SIX_HOURS_MS)}`;
}

/**
 * Accept one authenticated delivery and start a run for it.
 *
 * Exactly one run per delivery id: a resend replays the stored envelope, a
 * delivery that arrives while its subject is busy replaces the pending payload
 * and reports coalesced, and a delivery that loses on capacity stays pending so
 * the drain can start it instead of the sender having to try again.
 */
export async function dispatchWebhookDelivery(
  params: DispatchWebhookDeliveryParams,
  deps: WebhookDispatchDeps,
): Promise<DispatchWebhookResult> {
  const accepted: AcceptedWebhookDelivery = {
    endpointId: params.endpointId,
    deliveryId: params.deliveryId,
    subjectKey: webhookSubjectKey(
      params.endpointId,
      params.subjectId ?? params.deliveryId,
    ),
    definitionId: params.definitionId,
    definitionVersion: params.definitionVersion,
    nodeId: params.nodeId,
    entry: params.entry,
    verifiedWith: params.verifiedWith,
  };

  let durable: Awaited<ReturnType<typeof acceptWebhookDelivery>>;
  try {
    durable = await acceptWebhookDelivery(deps.db, accepted);
  } catch (error) {
    // Nothing is durable yet, so there is no envelope to record this against.
    return {
      result: "error",
      reason: recordIngestionFailure("webhook_delivery_accept_failed", error, {
        endpointId: accepted.endpointId,
        deliveryId: accepted.deliveryId,
      }),
    };
  }

  if (!durable.inserted) {
    const { result, pending } = durable.stored;
    // An error result is the one non-terminal result: it means "try again".
    if (result && result.outcome !== "error") return storedResultToDispatch(result);
    if (pending && !result) return { result: "coalesced" };
  }
  // Always dispatch the stored envelope: its definition pin and mapped entry are
  // first-writer-wins, so a retry can never repin a delivery already accepted.
  return dispatchAcceptedWebhookDelivery(acceptedFields(durable.stored), deps);
}

/** Drop the row's bookkeeping (pending, result, timestamps) before the envelope
 *  is written back into the payload column. Re-serializing a StoredWebhookDelivery
 *  would bake a stale snapshot of those columns into the payload. */
function acceptedFields(stored: StoredWebhookDelivery): AcceptedWebhookDelivery {
  return {
    endpointId: stored.endpointId,
    deliveryId: stored.deliveryId,
    subjectKey: stored.subjectKey,
    definitionId: stored.definitionId,
    definitionVersion: stored.definitionVersion,
    nodeId: stored.nodeId,
    entry: stored.entry,
    verifiedWith: stored.verifiedWith,
  };
}

/**
 * Start the successor for one subject. Seam for a future subject-release hook:
 * when a webhook run ends, the release path could call this to start the waiting
 * delivery immediately. Wiring that means changing shared run-lifecycle code,
 * which this change deliberately leaves alone. The cron drain below is correct
 * without it; the only cost is latency bounded by the cron period.
 */
export async function drainWebhookSubject(
  subjectKey: string,
  deps: WebhookDispatchDeps,
): Promise<DispatchWebhookResult | null> {
  const pending = await drainOldestPendingWebhookDelivery(deps.db, subjectKey);
  if (!pending) return null;
  return dispatchAcceptedWebhookDelivery(acceptedFields(pending), deps);
}

/** Cron entry point: start the oldest waiting delivery of every waiting subject.
 *  Each subject is re-read at drain time, so a payload that was replaced while
 *  waiting is dispatched in its newest form. Waiting subjects are served oldest
 *  first, bounded per pass, so a persistently failing head delays the tail. */
export async function redispatchPendingWebhookDeliveries(
  deps: WebhookDispatchDeps,
  limit: number = WEBHOOK_DRAIN_LIMIT,
): Promise<DispatchWebhookResult[]> {
  const results: DispatchWebhookResult[] = [];
  for (const pending of await listPendingWebhookDeliveries(deps.db, limit)) {
    const result = await drainWebhookSubject(pending.subjectKey, deps);
    if (result) results.push(result);
  }
  return results;
}

async function dispatchAcceptedWebhookDelivery(
  accepted: AcceptedWebhookDelivery,
  deps: WebhookDispatchDeps,
): Promise<DispatchWebhookResult> {
  try {
    // Persist the accepted envelope as this subject's pending snapshot before a
    // candidate can start. A delivery that arrives while another one is pending
    // hands over its payload here and stops.
    if ((await coalescePendingWebhookDelivery(deps.db, accepted)) === "coalesced") {
      return { result: "coalesced" };
    }

    // Held in an object because the exact reason is produced inside the claim
    // callback: claimSubjectRun's own reason vocabulary is shared with ticket
    // dispatch and has no webhook members.
    const guard: {
      rejection: WebhookDispatchGuardRejection | null;
      rateLimited: TriggerRateLimitDecision | null;
    } = { rejection: null, rateLimited: null };
    const dispatched = await claimSubjectRun(
      { subjectKey: accepted.subjectKey, ticketKey: null, kind: "webhook_trigger" },
      deps.runRegistry,
      deps.maxConcurrentAgents,
      {
        postClaimGuard: async () => {
          const target: WebhookDispatchTarget = {
            endpointId: accepted.endpointId,
            definitionId: accepted.definitionId,
            definitionVersion: accepted.definitionVersion,
            nodeId: accepted.nodeId,
          };
          guard.rejection = await deps.ensureStillDispatchable(target);
          if (guard.rejection) return { started: false, reason: "no_definition" };
          // Last, immediately before the start: a replay, a coalesced delivery
          // and a lost claim all stop before this point, so none of them spends
          // the endpoint's start budget.
          const decision = await consumeWebhookRateLimit(target, deps);
          if (decision && !decision.allowed) {
            guard.rateLimited = decision;
            return { started: false, reason: "rate_limited" };
          }
          return null;
        },
        startWorkflow: async (ownerToken) => {
          const input: AgentWorkflowInput = {
            kind: "webhook_trigger",
            endpointId: accepted.endpointId,
            definitionId: accepted.definitionId,
            definitionVersion: accepted.definitionVersion,
            nodeId: accepted.nodeId,
            deliveryId: accepted.deliveryId,
            subjectKey: accepted.subjectKey,
            entry: accepted.entry,
            ownerToken,
          };
          const handle = await start(agentWorkflow, [input]);
          return handle.runId;
        },
      },
    );

    if (dispatched.started) {
      const runId = dispatched.runId!;
      const recorded = await recordWebhookDeliveryStarted(
        deps.db,
        accepted,
        dispatched.ownerToken!,
        runId,
      );
      if (recorded) return { result: "started", runId };
      // A newer owner took the subject between start() and this write. Report
      // the durable winner instead of acknowledging a candidate that lost.
      const stored = await getWebhookDelivery(
        deps.db,
        accepted.endpointId,
        accepted.deliveryId,
      );
      return storedResultToDispatch(stored?.result ?? null);
    }

    if (guard.rejection) {
      await completeDelivery(deps, accepted, {
        outcome: "rejected",
        reason: guard.rejection,
        runId: null,
        verifiedWith: accepted.verifiedWith,
      });
      return { result: "rejected", reason: guard.rejection };
    }

    if (guard.rateLimited) {
      logger.info(
        {
          endpointId: accepted.endpointId,
          deliveryId: accepted.deliveryId,
          triggerType: "trigger_webhook",
          nodeId: accepted.nodeId,
          ...triggerRateLimitLogFields(guard.rateLimited),
        },
        "trigger_rate_limited",
      );
      // Terminal, not coalesced: a rejected outcome clears the pending flag, so
      // the drain never retries this delivery. Deliberately not a 429 on the
      // POST either, which is why this runs after the 202: senders like Zendesk
      // deactivate a webhook target after a run of 4xx answers, and losing the
      // integration is worse than losing the deliveries the operator capped.
      await completeDelivery(deps, accepted, {
        outcome: "rejected",
        reason: RATE_LIMITED_DELIVERY_REASON,
        runId: null,
        verifiedWith: accepted.verifiedWith,
      });
      return { result: "rejected", reason: RATE_LIMITED_DELIVERY_REASON };
    }

    if (dispatched.reason === "at_capacity" || dispatched.reason === "already_claimed") {
      // Stays pending on purpose: a coalesced result leaves the pending flag
      // alone, so the drain starts this delivery once the subject frees up.
      await completeDelivery(deps, accepted, {
        outcome: "coalesced",
        reason: dispatched.reason,
        runId: null,
        verifiedWith: accepted.verifiedWith,
      });
      return dispatched.reason === "at_capacity"
        ? { result: "at_capacity" }
        : { result: "coalesced" };
    }

    return await persistRetryableFailure(
      deps,
      accepted,
      new Error(`webhook claim failed: ${dispatched.reason ?? "unknown"}`),
    );
  } catch (error) {
    return persistRetryableFailure(deps, accepted, error);
  }
}

/** A failed dispatch stays pending with its diagnostic, so the drain retries it
 *  instead of the delivery being lost. */
async function persistRetryableFailure(
  deps: WebhookDispatchDeps,
  accepted: AcceptedWebhookDelivery,
  error: unknown,
): Promise<DispatchWebhookResult> {
  const diagnosticId = recordIngestionFailure(
    "webhook_delivery_dispatch_retryable_failure",
    error,
    {
      endpointId: accepted.endpointId,
      deliveryId: accepted.deliveryId,
      subjectKey: accepted.subjectKey,
    },
  );
  await completeDelivery(deps, accepted, {
    outcome: "error",
    reason: diagnosticId,
    runId: null,
    verifiedWith: accepted.verifiedWith,
  }).catch((persistError) => {
    recordIngestionFailure(
      "webhook_delivery_retry_state_persistence_failed",
      persistError,
      { endpointId: accepted.endpointId, deliveryId: accepted.deliveryId },
      diagnosticId,
    );
  });
  return { result: "error", reason: diagnosticId };
}

async function completeDelivery(
  deps: WebhookDispatchDeps,
  accepted: AcceptedWebhookDelivery,
  result: StoredWebhookResult,
): Promise<void> {
  await completeWebhookDelivery(
    deps.db,
    accepted.endpointId,
    accepted.deliveryId,
    result,
  );
}

function storedResultToDispatch(
  result: StoredWebhookResult | null,
): DispatchWebhookResult {
  if (!result) return { result: "coalesced" };
  if (result.outcome === "started" && result.runId) {
    return { result: "started", runId: result.runId };
  }
  if (result.outcome === "rejected") {
    return { result: "rejected", reason: result.reason ?? "rejected" };
  }
  if (result.outcome === "error") {
    return { result: "error", reason: result.reason ?? "error" };
  }
  // "coalesced" and "test" both mean "no run was started for this delivery".
  return { result: "coalesced" };
}
