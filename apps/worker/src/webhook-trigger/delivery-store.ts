import { and, asc, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { WebhookDeliveryOutcome } from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  activeRuns,
  webhookTriggerDeliveries,
  workflowRuns,
} from "../db/schema.js";
import { isUniqueViolation } from "../lib/unique-violation.js";
import type { WebhookTriggerEntry } from "./payload-mapping.js";
import type { WebhookVerifiedWith } from "./verify.js";

/**
 * Durable inbox for authenticated webhook deliveries.
 *
 * Same three properties the provider trigger inbox has, restated for an ingress
 * this system owns end to end:
 *   - a delivery id is idempotent per endpoint, so a sender that retries gets
 *     the first envelope back instead of a second run;
 *   - at most one delivery per subject stays pending, and a newer delivery
 *     replaces that pending payload rather than queueing behind it;
 *   - a delivery that could not start yet stays pending so the drain can start
 *     it later, instead of relying on the sender to try again.
 */

/**
 * Outcomes a stored result envelope can carry. "test" is a dashboard-issued
 * probe that exercises verification and mapping without starting a run.
 *
 * Deliberately narrower than the contract's WebhookDeliveryOutcome, which also
 * has "pending": that is the row's pending column, not a decision anyone wrote,
 * and only the log projection below turns it into an outcome.
 */
export type StoredWebhookOutcome =
  | "started"
  | "coalesced"
  | "rejected"
  | "error"
  | "test";

export interface StoredWebhookResult {
  outcome: StoredWebhookOutcome;
  /** Machine-readable detail ("at_capacity", "endpoint_revoked", ...). */
  reason: string | null;
  runId: string | null;
  verifiedWith: WebhookVerifiedWith | null;
}

/** Everything a re-dispatch needs to rebuild the workflow input without
 *  re-reading the graph or re-parsing the body. Stored verbatim in payload. */
export interface AcceptedWebhookDelivery {
  endpointId: string;
  deliveryId: string;
  subjectKey: string;
  definitionId: number;
  definitionVersion: number;
  nodeId: string;
  entry: WebhookTriggerEntry;
  verifiedWith: WebhookVerifiedWith | null;
}

export interface StoredWebhookDelivery extends AcceptedWebhookDelivery {
  pending: boolean;
  result: StoredWebhookResult | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryLogRow {
  deliveryId: string;
  receivedAt: Date;
  outcome: WebhookDeliveryOutcome;
  reason: string | null;
  runId: string | null;
  verifiedWith: WebhookVerifiedWith | null;
}

/** "queued" means this delivery now owns its subject's pending slot and may be
 *  dispatched; "coalesced" means an older pending delivery absorbed this one's
 *  payload and will carry it instead. */
export type WebhookCoalesceOutcome = "queued" | "coalesced";

/**
 * Record one authenticated delivery. A resend of the same delivery id returns
 * the stored envelope untouched: its definition pin, its mapped entry, and its
 * result are all first-writer-wins, so a retry can never start a second run or
 * silently repin a run that is already going.
 */
export async function acceptWebhookDelivery(
  db: Db,
  accepted: AcceptedWebhookDelivery,
): Promise<{ inserted: boolean; stored: StoredWebhookDelivery }> {
  const rows = await db
    .insert(webhookTriggerDeliveries)
    .values({
      endpointId: accepted.endpointId,
      deliveryId: accepted.deliveryId,
      subjectKey: accepted.subjectKey,
      definitionId: accepted.definitionId,
      definitionVersion: accepted.definitionVersion,
      payload: accepted,
    })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) return { inserted: true, stored: mapDelivery(rows[0]) };
  const stored = await getWebhookDelivery(db, accepted.endpointId, accepted.deliveryId);
  if (!stored) throw new Error("webhook delivery disappeared after unique conflict");
  return { inserted: false, stored };
}

/**
 * Write the terminal envelope for a delivery.
 *
 * A started result is the strongest thing that can be recorded, so a later
 * error, refusal or coalesce may not overwrite it: those all describe this
 * dispatch attempt, while "started" describes a run that actually exists.
 *
 * The pending flag follows the outcome. An error stays pending (the drain
 * retries it), a coalesce leaves the flag exactly as it was (the row either is
 * or is not the subject's pending snapshot), and everything else releases it.
 */
export async function completeWebhookDelivery(
  db: Db,
  endpointId: string,
  deliveryId: string,
  result: StoredWebhookResult,
): Promise<void> {
  const serializedResult = JSON.stringify(result);
  // True exactly when a weaker outcome is trying to overwrite a started run.
  // NULL (no result yet) is not true, so a first write always lands.
  const overwritesStart = sql`${webhookTriggerDeliveries.result}->>'outcome' = 'started'
    and ${result.outcome} <> 'started'`;
  const pending =
    result.outcome === "error"
      ? sql`true`
      : result.outcome === "coalesced"
        ? sql`${webhookTriggerDeliveries.pending}`
        : sql`false`;
  await db
    .update(webhookTriggerDeliveries)
    .set({
      // The pending flag is guarded together with the result: a late error must
      // not requeue a delivery whose run is already going.
      pending: sql`case
        when ${overwritesStart} then ${webhookTriggerDeliveries.pending}
        else ${pending}
      end`,
      result: sql`case
        when ${overwritesStart} then ${webhookTriggerDeliveries.result}
        else ${serializedResult}::jsonb
      end`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(webhookTriggerDeliveries.endpointId, endpointId),
        eq(webhookTriggerDeliveries.deliveryId, deliveryId),
      ),
    );
}

/**
 * Keep exactly one pending delivery per subject, carrying the newest payload.
 *
 * Callers must replay a terminal result before calling this: the statement
 * assumes the delivery it is passed is still undecided.
 *
 * The single statement locks the subject's pending row (FOR UPDATE), refreshes
 * it with this delivery's payload, and then either promotes this delivery into
 * the free pending slot or marks it coalesced behind the row that absorbed it.
 * Two callers can still race into the free slot, which the partial unique index
 * turns into a 23505; the retry then sees the winner and coalesces.
 */
export async function coalescePendingWebhookDelivery(
  db: Db,
  accepted: AcceptedWebhookDelivery,
): Promise<WebhookCoalesceOutcome> {
  const payload = JSON.stringify(accepted);
  const coalesced = JSON.stringify({
    outcome: "coalesced",
    reason: null,
    runId: null,
    verifiedWith: accepted.verifiedWith,
  } satisfies StoredWebhookResult);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const executed = await db.execute(sql`
        WITH existing AS (
          SELECT endpoint_id, delivery_id
          FROM ${webhookTriggerDeliveries}
          WHERE subject_key = ${accepted.subjectKey}
            AND pending = true
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE
        ), merged AS (
          UPDATE ${webhookTriggerDeliveries} inbox
          SET definition_id = ${accepted.definitionId},
              definition_version = ${accepted.definitionVersion},
              payload = ${payload}::jsonb,
              updated_at = now()
          FROM existing
          WHERE inbox.endpoint_id = existing.endpoint_id
            AND inbox.delivery_id = existing.delivery_id
          RETURNING inbox.delivery_id
        ), queued AS (
          UPDATE ${webhookTriggerDeliveries} inbox
          SET pending = true,
              updated_at = now()
          WHERE inbox.endpoint_id = ${accepted.endpointId}
            AND inbox.delivery_id = ${accepted.deliveryId}
            AND NOT EXISTS (SELECT 1 FROM existing)
          RETURNING inbox.delivery_id
        ), absorbed AS (
          UPDATE ${webhookTriggerDeliveries} inbox
          SET result = ${coalesced}::jsonb,
              pending = false,
              updated_at = now()
          WHERE inbox.endpoint_id = ${accepted.endpointId}
            AND inbox.delivery_id = ${accepted.deliveryId}
            AND EXISTS (SELECT 1 FROM existing)
            AND NOT EXISTS (
              SELECT 1 FROM existing
              WHERE existing.endpoint_id = inbox.endpoint_id
                AND existing.delivery_id = inbox.delivery_id
            )
          RETURNING inbox.delivery_id
        )
        SELECT EXISTS (SELECT 1 FROM absorbed) AS absorbed
      `);
      return rawRows<{ absorbed: boolean }>(executed)[0]?.absorbed
        ? "coalesced"
        : "queued";
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) throw error;
    }
  }
  return "queued";
}

/** The three columns that identify one delivery row. Taken instead of the whole
 *  envelope so the winning workflow can publish its own start from the fields
 *  its input already carries. */
export interface WebhookDeliveryIdentity {
  endpointId: string;
  deliveryId: string;
  subjectKey: string;
}

/**
 * Publish the start and release the pending snapshot, but only while this owner
 * still holds the subject and no other run has claimed the delivery.
 *
 * Two writers call this for the same run: the dispatcher once start() returns,
 * and the winning workflow itself (acknowledgeWebhookDispatchStep) once it binds
 * the owner. Either one alone is enough, which is what closes the crash window
 * between commitHostedStart and the dispatcher-side write: a live run can never
 * be left with a pending row for the drain to start a second time.
 *
 * First start wins. A second run id cannot overwrite a published start, so the
 * pair is idempotent for the same run and exclusive across different ones. The
 * verifiedWith field is read back from the stored envelope rather than passed
 * in, so whichever writer gets there first records the same authentication fact.
 */
export async function recordWebhookDeliveryStarted(
  db: Pick<Db, "execute">,
  identity: WebhookDeliveryIdentity,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  const updated = await db.execute(sql`
    UPDATE ${webhookTriggerDeliveries} inbox
    SET result = jsonb_build_object(
          'outcome', 'started',
          'reason', null::text,
          'runId', ${runId}::text,
          'verifiedWith', inbox.payload->'verifiedWith'
        ),
        pending = false,
        updated_at = now()
    WHERE inbox.endpoint_id = ${identity.endpointId}
      AND inbox.delivery_id = ${identity.deliveryId}
      AND inbox.subject_key = ${identity.subjectKey}
      AND (
        inbox.result IS NULL
        OR inbox.result->>'outcome' <> 'started'
        OR inbox.result->>'runId' = ${runId}
      )
      AND EXISTS (
        SELECT 1 FROM ${activeRuns}
        WHERE ${activeRuns.subjectKey} = ${identity.subjectKey}
          AND ${activeRuns.ownerToken} = ${ownerToken}
          AND (
            (${activeRuns.state} = 'reserved' AND ${activeRuns.runId} IS NULL)
            OR (${activeRuns.state} = 'bound' AND ${activeRuns.runId} = ${runId})
          )
      )
      AND EXISTS (
        SELECT 1 FROM ${workflowRuns}
        WHERE ${workflowRuns.runId} = ${runId}
      )
    RETURNING inbox.delivery_id
  `);
  return rawRows(updated).length === 1;
}

export async function getWebhookDelivery(
  db: Db,
  endpointId: string,
  deliveryId: string,
): Promise<StoredWebhookDelivery | null> {
  const rows = await db
    .select()
    .from(webhookTriggerDeliveries)
    .where(
      and(
        eq(webhookTriggerDeliveries.endpointId, endpointId),
        eq(webhookTriggerDeliveries.deliveryId, deliveryId),
      ),
    )
    .limit(1);
  return rows[0] ? mapDelivery(rows[0]) : null;
}

/** Oldest pending delivery, optionally for one subject. The drain starts from
 *  the oldest so a subject that queued several payloads is served in order. */
export async function drainOldestPendingWebhookDelivery(
  db: Db,
  subjectKey?: string,
): Promise<StoredWebhookDelivery | null> {
  const rows = await db
    .select()
    .from(webhookTriggerDeliveries)
    .where(
      subjectKey
        ? and(
            eq(webhookTriggerDeliveries.pending, true),
            eq(webhookTriggerDeliveries.subjectKey, subjectKey),
          )
        : eq(webhookTriggerDeliveries.pending, true),
    )
    .orderBy(asc(webhookTriggerDeliveries.createdAt))
    .limit(1);
  return rows[0] ? mapDelivery(rows[0]) : null;
}

/**
 * Oldest pending deliveries across subjects, bounded, for the drain cron. One
 * pending row per subject means this is already one entry per waiting subject.
 *
 * Ordering is createdAt ASC with a limit, so a large backlog is served oldest
 * first and the tail waits for later passes: fair, but head-of-line blocking is
 * real if the oldest subjects keep failing to start.
 */
export async function listPendingWebhookDeliveries(
  db: Db,
  limit: number,
): Promise<StoredWebhookDelivery[]> {
  const rows = await db
    .select()
    .from(webhookTriggerDeliveries)
    .where(eq(webhookTriggerDeliveries.pending, true))
    .orderBy(asc(webhookTriggerDeliveries.createdAt))
    .limit(limit);
  return rows.map(mapDelivery);
}

/** Newest first, for the endpoint's delivery log. */
export async function listRecentWebhookDeliveries(
  db: Db,
  endpointId: string,
  limit: number,
): Promise<WebhookDeliveryLogRow[]> {
  const rows = await db
    .select()
    .from(webhookTriggerDeliveries)
    .where(eq(webhookTriggerDeliveries.endpointId, endpointId))
    .orderBy(desc(webhookTriggerDeliveries.createdAt))
    .limit(limit);
  return rows.map((row) => {
    const stored = mapDelivery(row);
    return {
      deliveryId: stored.deliveryId,
      receivedAt: stored.createdAt,
      // A pending row is waiting (for its subject, for capacity, or for a retry)
      // whatever its last recorded result says, and that is what the operator
      // needs to read. Only a settled row reports the decision that was written;
      // a row with no result at all never had a decision, so it also reads as
      // waiting rather than as superseded.
      outcome: stored.result && !stored.pending ? stored.result.outcome : "pending",
      reason: stored.result?.reason ?? null,
      runId: stored.result?.runId ?? null,
      verifiedWith: stored.result?.verifiedWith ?? stored.verifiedWith,
    };
  });
}

/** How long a settled delivery stays readable in the endpoint log before it is
 *  swept. Long enough to investigate a bad rotation, short enough to bound the
 *  table. */
const SETTLED_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop settled deliveries older than the retention window. Only rows that
 * reached a terminal result and released their pending slot are eligible: a
 * pending row is still waiting for its subject, for capacity, or for a retry, so
 * deleting it would strand work the drain still owns. Pending growth is bounded
 * operationally instead (an operator revokes a runaway endpoint), and the drain
 * itself stays capped at WEBHOOK_DRAIN_LIMIT per pass.
 */
export async function sweepWebhookDeliveries(
  db: Db,
  now: Date = new Date(),
): Promise<void> {
  await db
    .delete(webhookTriggerDeliveries)
    .where(
      and(
        eq(webhookTriggerDeliveries.pending, false),
        isNotNull(webhookTriggerDeliveries.result),
        lt(
          webhookTriggerDeliveries.createdAt,
          new Date(now.getTime() - SETTLED_DELIVERY_RETENTION_MS),
        ),
      ),
    );
}

function rawRows<T = { deliveryId: string }>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function mapDelivery(
  row: typeof webhookTriggerDeliveries.$inferSelect,
): StoredWebhookDelivery {
  const payload = row.payload as AcceptedWebhookDelivery;
  return {
    ...payload,
    endpointId: row.endpointId,
    deliveryId: row.deliveryId,
    subjectKey: row.subjectKey,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    pending: row.pending,
    result: row.result as StoredWebhookResult | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
