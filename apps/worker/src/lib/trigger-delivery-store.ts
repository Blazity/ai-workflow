import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  activeRuns,
  pendingTriggerEvents,
  triggerDeliveries,
} from "../db/schema.js";
import type { PrTriggerPayload } from "../workflows/agent-input.js";
import type { PrTriggerType, TriggerEvent } from "./trigger-events.js";

export type TriggerScope = "workflow_owned" | "any";

export interface ReceivedTriggerDelivery extends TriggerEvent {
  scope: TriggerScope;
  definitionId: number;
  definitionVersion: number;
}

export interface AcceptedTriggerDelivery extends TriggerEvent {
  scope: TriggerScope;
  subjectKey: string;
  ticketKey: string | null;
  definitionId: number;
  definitionVersion: number;
}

export type StoredTriggerResult =
  | { result: "started"; runId: string }
  | { result: "candidate_started"; runId: string }
  | {
      result:
        | "coalesced"
        | "at_capacity"
        | "error"
        | "ignored_provider"
        | "ignored_stale_head"
        | "ignored_not_workflow_owned";
    };

export interface StoredTriggerDelivery extends TriggerEvent {
  scope: TriggerScope;
  subjectKey: string | null;
  ticketKey: string | null;
  definitionId: number;
  definitionVersion: number;
  status: "received" | "accepted" | "completed";
  result: StoredTriggerResult | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function receiveTriggerDelivery(
  db: Db,
  received: ReceivedTriggerDelivery,
): Promise<
  | { inserted: true; stored: StoredTriggerDelivery }
  | { inserted: false; stored: StoredTriggerDelivery }
> {
  const rows = await db
    .insert(triggerDeliveries)
    .values({
      provider: received.delivery.provider,
      deliveryId: received.delivery.deliveryId,
      producer: received.delivery.producer,
      triggerType: received.triggerType,
      subjectKey: null,
      ticketKey: null,
      headSha: received.pr.headSha,
      definitionId: received.definitionId,
      definitionVersion: received.definitionVersion,
      payload: received,
      status: "received",
    })
    .onConflictDoNothing({
      target: [triggerDeliveries.provider, triggerDeliveries.deliveryId],
    })
    .returning();
  if (rows[0]) return { inserted: true, stored: mapDelivery(rows[0]) };
  const stored = await getTriggerDelivery(
    db,
    received.delivery.provider,
    received.delivery.deliveryId,
  );
  if (!stored) throw new Error("trigger delivery disappeared after unique conflict");
  return { inserted: false, stored };
}

export async function acceptReceivedTriggerDelivery(
  db: Db,
  accepted: AcceptedTriggerDelivery,
): Promise<{ enriched: boolean; stored: StoredTriggerDelivery }> {
  const rows = await db
    .update(triggerDeliveries)
    .set({
      subjectKey: accepted.subjectKey,
      ticketKey: accepted.ticketKey,
      headSha: accepted.pr.headSha,
      payload: accepted,
      status: "accepted",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(triggerDeliveries.provider, accepted.delivery.provider),
        eq(triggerDeliveries.deliveryId, accepted.delivery.deliveryId),
        eq(triggerDeliveries.status, "received"),
        isNull(triggerDeliveries.result),
      ),
    )
    .returning();
  if (rows[0]) return { enriched: true, stored: mapDelivery(rows[0]) };
  const stored = await getTriggerDelivery(
    db,
    accepted.delivery.provider,
    accepted.delivery.deliveryId,
  );
  if (!stored) throw new Error("received trigger delivery disappeared before enrichment");
  return { enriched: false, stored };
}

export async function acceptTriggerDelivery(
  db: Db,
  accepted: AcceptedTriggerDelivery,
): Promise<
  | { inserted: true; stored: StoredTriggerDelivery }
  | { inserted: false; stored: StoredTriggerDelivery }
> {
  const rows = await db
    .insert(triggerDeliveries)
    .values({
      provider: accepted.delivery.provider,
      deliveryId: accepted.delivery.deliveryId,
      producer: accepted.delivery.producer,
      triggerType: accepted.triggerType,
      subjectKey: accepted.subjectKey,
      ticketKey: accepted.ticketKey,
      headSha: accepted.pr.headSha,
      definitionId: accepted.definitionId,
      definitionVersion: accepted.definitionVersion,
      payload: accepted,
      status: "accepted",
    })
    .onConflictDoNothing({
      target: [triggerDeliveries.provider, triggerDeliveries.deliveryId],
    })
    .returning();
  if (rows[0]) return { inserted: true, stored: mapDelivery(rows[0]) };
  const stored = await getTriggerDelivery(
    db,
    accepted.delivery.provider,
    accepted.delivery.deliveryId,
  );
  if (!stored) throw new Error("trigger delivery disappeared after unique conflict");
  return { inserted: false, stored };
}

export async function completeTriggerDelivery(
  db: Db,
  provider: "github" | "gitlab",
  deliveryId: string,
  result: StoredTriggerResult,
): Promise<void> {
  const serializedResult = JSON.stringify(result);
  await db
    .update(triggerDeliveries)
    .set({
      status: "completed",
      result: sql`case
        when ${triggerDeliveries.result} is null
          then ${serializedResult}::jsonb
        when ${triggerDeliveries.result}->>'result' in ('candidate_started', 'coalesced')
          and ${result.result} in ('ignored_stale_head', 'ignored_not_workflow_owned')
          then ${serializedResult}::jsonb
        else ${triggerDeliveries.result}
      end`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(triggerDeliveries.provider, provider),
        eq(triggerDeliveries.deliveryId, deliveryId),
      ),
    );
}

/**
 * Publishes the recoverable start marker only while this exact candidate still
 * owns the subject. The candidate may already have bound, or it may still be
 * between start() and its first Workflow step. Terminal delivery outcomes are
 * immutable; a live recovery owner may replace a dead candidate marker, while
 * a delayed predecessor without ownership cannot replace the recovery marker.
 */
export async function recordCandidateStartedTriggerDelivery(
  db: Pick<Db, "execute">,
  accepted: AcceptedTriggerDelivery,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  const marker = JSON.stringify({ result: "candidate_started", runId });
  const updated = await db.execute(sql`
    update ${triggerDeliveries}
    set status = 'completed',
        result = ${marker}::jsonb,
        updated_at = now()
    where ${triggerDeliveries.provider} = ${accepted.delivery.provider}
      and ${triggerDeliveries.deliveryId} = ${accepted.delivery.deliveryId}
      and ${triggerDeliveries.subjectKey} = ${accepted.subjectKey}
      and ${triggerDeliveries.headSha} = ${accepted.pr.headSha}
      and ${triggerDeliveries.triggerType} = ${accepted.triggerType}
      and ${triggerDeliveries.definitionId} = ${accepted.definitionId}
      and ${triggerDeliveries.definitionVersion} = ${accepted.definitionVersion}
      and (
        ${triggerDeliveries.result} is null
        or ${triggerDeliveries.result}->>'result' in ('coalesced', 'candidate_started')
      )
      and exists (
        select 1
        from ${activeRuns}
        where ${activeRuns.subjectKey} = ${accepted.subjectKey}
          and ${activeRuns.ownerToken} = ${ownerToken}
          and (
            (
              ${activeRuns.state} = 'reserved'
              and ${activeRuns.runId} is null
            )
            or (
              ${activeRuns.state} = 'bound'
              and ${activeRuns.runId} = ${runId}
            )
          )
      )
    returning ${triggerDeliveries.deliveryId}
  `);
  return rawRows<{ deliveryId: string }>(updated).length === 1;
}

export async function completeReceivedTriggerDelivery(
  db: Db,
  provider: "github" | "gitlab",
  deliveryId: string,
  result: StoredTriggerResult,
): Promise<boolean> {
  const rows = await db
    .update(triggerDeliveries)
    .set({
      status: "completed",
      result,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(triggerDeliveries.provider, provider),
        eq(triggerDeliveries.deliveryId, deliveryId),
        eq(triggerDeliveries.status, "received"),
        isNull(triggerDeliveries.result),
      ),
    )
    .returning({ deliveryId: triggerDeliveries.deliveryId });
  return rows.length === 1;
}

export async function getTriggerDelivery(
  db: Db,
  provider: "github" | "gitlab",
  deliveryId: string,
): Promise<StoredTriggerDelivery | null> {
  const rows = await db
    .select()
    .from(triggerDeliveries)
    .where(
      and(
        eq(triggerDeliveries.provider, provider),
        eq(triggerDeliveries.deliveryId, deliveryId),
      ),
    )
    .limit(1);
  return rows[0] ? mapDelivery(rows[0]) : null;
}

/**
 * Find deliveries whose durable receipt or acceptance was never followed by a
 * terminal result. The grace cutoff keeps the poller away from an in-flight
 * webhook; dispatch still acquires the normal subject reservation as the final
 * CAS once enrichment has resolved a subject.
 */
export async function listRecoverableAcceptedTriggerDeliveries(
  db: Db,
  updatedBefore: Date,
): Promise<StoredTriggerDelivery[]> {
  const rows = await db
    .select()
    .from(triggerDeliveries)
    .where(
      and(
        inArray(triggerDeliveries.status, ["received", "accepted"]),
        isNull(triggerDeliveries.result),
        lte(triggerDeliveries.updatedAt, updatedBefore),
      ),
    )
    .orderBy(asc(triggerDeliveries.updatedAt))
    .limit(100);
  return rows.map(mapDelivery);
}

export async function coalescePendingTrigger(
  db: Db,
  accepted: AcceptedTriggerDelivery,
): Promise<void> {
  const failedChecks = accepted.pr.failedChecks ?? [];
  const reviews = [
    ...(accepted.pr.reviews ?? []),
    ...(accepted.pr.review ? [accepted.pr.review] : []),
  ];
  await db
    .insert(pendingTriggerEvents)
    .values({
      subjectKey: accepted.subjectKey,
      headSha: accepted.pr.headSha,
      triggerType: accepted.triggerType,
      provider: accepted.delivery.provider,
      deliveryId: accepted.delivery.deliveryId,
      ticketKey: accepted.ticketKey,
      definitionId: accepted.definitionId,
      definitionVersion: accepted.definitionVersion,
      payload: accepted,
      failedChecks,
      reviews,
    })
    .onConflictDoUpdate({
      target: [
        pendingTriggerEvents.subjectKey,
        pendingTriggerEvents.headSha,
        pendingTriggerEvents.triggerType,
        pendingTriggerEvents.definitionId,
        pendingTriggerEvents.definitionVersion,
      ],
      set: {
        // The newest provider delivery id is also the row's immutable snapshot
        // token. Consumers delete with this value so feedback merged after a
        // drain snapshot cannot be erased by the older consumer.
        provider: sql`excluded.provider`,
        deliveryId: sql`excluded.delivery_id`,
        // Preserve the first event's scope/pin while keeping the newest
        // provider delivery identity and PR snapshot internally coherent.
        payload: sql`jsonb_set(
          jsonb_set(
            ${pendingTriggerEvents.payload},
            '{delivery}',
            excluded.payload->'delivery',
            true
          ),
          '{pr}',
          excluded.payload->'pr',
          true
        )`,
        failedChecks: sql`case
          when ${pendingTriggerEvents.payload}->'pr'->>'provider' = 'gitlab'
            and excluded.payload->'pr'->>'provider' = 'gitlab'
            and ${pendingTriggerEvents.payload}->'pr'->>'pipelineId'
              is distinct from excluded.payload->'pr'->>'pipelineId'
          then excluded.failed_checks
          else ${mergeJsonArrays(pendingTriggerEvents.failedChecks, "failed_checks")}
        end`,
        reviews: mergeJsonArrays(pendingTriggerEvents.reviews, "reviews"),
        updatedAt: sql`now()`,
      },
    });
}

export async function getPendingTrigger(
  db: Db,
  subjectKey: string,
  headSha: string,
  triggerType: PrTriggerType,
): Promise<AcceptedTriggerDelivery | null> {
  const rows = await db
    .select()
    .from(pendingTriggerEvents)
    .where(
      and(
        eq(pendingTriggerEvents.subjectKey, subjectKey),
        eq(pendingTriggerEvents.headSha, headSha),
        eq(pendingTriggerEvents.triggerType, triggerType),
      ),
    )
    .limit(1);
  return rows[0] ? mapPending(rows[0]) : null;
}

export async function listPendingTriggersForSubject(
  db: Db,
  subjectKey: string,
): Promise<AcceptedTriggerDelivery[]> {
  const rows = await db
    .select()
    .from(pendingTriggerEvents)
    .where(eq(pendingTriggerEvents.subjectKey, subjectKey))
    .orderBy(asc(pendingTriggerEvents.createdAt));
  return rows.map(mapPending);
}

export async function listPendingSubjectKeys(db: Db): Promise<string[]> {
  const rows = await db
    .select({
      subjectKey: pendingTriggerEvents.subjectKey,
      oldest: sql<Date>`min(${pendingTriggerEvents.createdAt})`,
    })
    .from(pendingTriggerEvents)
    .groupBy(pendingTriggerEvents.subjectKey)
    .orderBy(sql`min(${pendingTriggerEvents.createdAt})`);
  return rows.map(({ subjectKey }) => subjectKey);
}

export async function deletePendingTrigger(
  db: Db,
  accepted: Pick<
    AcceptedTriggerDelivery,
    | "subjectKey"
    | "triggerType"
    | "pr"
    | "delivery"
    | "definitionId"
    | "definitionVersion"
  >,
): Promise<boolean> {
  const rows = await db
    .delete(pendingTriggerEvents)
    .where(
      and(
        eq(pendingTriggerEvents.subjectKey, accepted.subjectKey),
        eq(pendingTriggerEvents.headSha, accepted.pr.headSha),
        eq(pendingTriggerEvents.triggerType, accepted.triggerType),
        eq(pendingTriggerEvents.definitionId, accepted.definitionId),
        eq(pendingTriggerEvents.definitionVersion, accepted.definitionVersion),
        eq(pendingTriggerEvents.provider, accepted.delivery.provider),
        eq(pendingTriggerEvents.deliveryId, accepted.delivery.deliveryId),
      ),
    )
    .returning({ subjectKey: pendingTriggerEvents.subjectKey });
  return rows.length > 0;
}

/** Commit the winning workflow correlation and consumption of its pending
 * snapshot together. If the step is interrupted, neither half is visible; a
 * replay is idempotent. */
export async function acknowledgeStartedTriggerDelivery(
  db: Pick<Db, "execute">,
  accepted: Pick<
    AcceptedTriggerDelivery,
    | "subjectKey"
    | "triggerType"
    | "pr"
    | "delivery"
    | "definitionId"
    | "definitionVersion"
  >,
  runId: string,
): Promise<boolean> {
  const result = JSON.stringify({ result: "started", runId });
  const acknowledged = await db.execute(sql`
    with started_delivery as (
      update ${triggerDeliveries}
      set
        status = 'completed',
        result = ${result}::jsonb,
        updated_at = now()
      where ${triggerDeliveries.provider} = ${accepted.delivery.provider}
        and ${triggerDeliveries.deliveryId} = ${accepted.delivery.deliveryId}
        and ${triggerDeliveries.subjectKey} = ${accepted.subjectKey}
        and ${triggerDeliveries.headSha} = ${accepted.pr.headSha}
        and ${triggerDeliveries.triggerType} = ${accepted.triggerType}
        and ${triggerDeliveries.definitionId} = ${accepted.definitionId}
        and ${triggerDeliveries.definitionVersion} = ${accepted.definitionVersion}
        and exists (
          select 1
          from ${activeRuns}
          where ${activeRuns.subjectKey} = ${accepted.subjectKey}
            and ${activeRuns.runId} = ${runId}
            and ${activeRuns.state} = 'bound'
        )
        -- Only an unfinished/recoverable delivery can advance to started.
        -- Every ignored/error/capacity outcome is terminal for this delivery;
        -- an exact started replay remains idempotent for Workflow retries.
        and (
          ${triggerDeliveries.result} is null
          or ${triggerDeliveries.result}->>'result' in ('candidate_started', 'coalesced')
          or (
            ${triggerDeliveries.result}->>'result' = 'started'
            and ${triggerDeliveries.result}->>'runId' = ${runId}
          )
        )
      returning
        ${triggerDeliveries.provider},
        ${triggerDeliveries.deliveryId},
        ${triggerDeliveries.subjectKey},
        ${triggerDeliveries.headSha},
        ${triggerDeliveries.triggerType},
        ${triggerDeliveries.definitionId},
        ${triggerDeliveries.definitionVersion}
    ), deleted_pending as (
      delete from ${pendingTriggerEvents}
      using started_delivery
      where ${pendingTriggerEvents.provider} = started_delivery.provider
        and ${pendingTriggerEvents.deliveryId} = started_delivery.delivery_id
        and ${pendingTriggerEvents.subjectKey} = started_delivery.subject_key
        and ${pendingTriggerEvents.headSha} = started_delivery.head_sha
        and ${pendingTriggerEvents.triggerType} = started_delivery.trigger_type
        and ${pendingTriggerEvents.definitionId} = started_delivery.definition_id
        and ${pendingTriggerEvents.definitionVersion} = started_delivery.definition_version
      returning ${pendingTriggerEvents.subjectKey}
    )
    select exists(select 1 from started_delivery) as acknowledged
  `);
  return rawRows<{ acknowledged: boolean }>(acknowledged)[0]?.acknowledged === true;
}

function mergeJsonArrays(
  column: typeof pendingTriggerEvents.failedChecks | typeof pendingTriggerEvents.reviews,
  excludedName: string,
) {
  return sql`(
    select coalesce(jsonb_agg(value order by value::text), '[]'::jsonb)
    from (
      select distinct value
      from jsonb_array_elements(
        coalesce(${column}, '[]'::jsonb) || coalesce(excluded.${sql.raw(excludedName)}, '[]'::jsonb)
      )
    ) as merged
  )`;
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function mapDelivery(row: typeof triggerDeliveries.$inferSelect): StoredTriggerDelivery {
  const payload = row.payload as ReceivedTriggerDelivery | AcceptedTriggerDelivery;
  return {
    ...payload,
    subjectKey: row.subjectKey,
    ticketKey: row.ticketKey,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    status: row.status as StoredTriggerDelivery["status"],
    result: row.result as StoredTriggerResult | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPending(row: typeof pendingTriggerEvents.$inferSelect): AcceptedTriggerDelivery {
  const payload = row.payload as AcceptedTriggerDelivery;
  const pr: PrTriggerPayload = {
    ...payload.pr,
    failedChecks: row.failedChecks as PrTriggerPayload["failedChecks"],
    reviews: row.reviews as PrTriggerPayload["reviews"],
  };
  return {
    ...payload,
    delivery: {
      ...payload.delivery,
      provider: row.provider as AcceptedTriggerDelivery["delivery"]["provider"],
      deliveryId: row.deliveryId,
    },
    subjectKey: row.subjectKey,
    ticketKey: row.ticketKey,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    pr,
  };
}
