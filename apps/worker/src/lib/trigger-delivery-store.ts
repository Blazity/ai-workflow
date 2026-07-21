import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activeRuns, triggerDeliveries } from "../db/schema.js";
import type { PrTriggerType, TriggerEvent } from "./trigger-events.js";

export type TriggerScope = "workflow_owned" | "any";

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

export interface StoredTriggerDelivery extends AcceptedTriggerDelivery {
  pending: boolean;
  result: StoredTriggerResult | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Insert one fully authenticated and normalized provider event. Provider
 * retries return the first stored envelope and can never change its pin. */
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
      pending:
        result.result === "coalesced"
          ? sql`${triggerDeliveries.pending}`
          : false,
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

/** Keep exactly one pending semantic event for a subject. Newer feedback
 * replaces the pending payload while every provider delivery id remains a
 * separate dedupe record. */
export async function coalescePendingTrigger(
  db: Db,
  accepted: AcceptedTriggerDelivery,
): Promise<void> {
  const payload = JSON.stringify(accepted);
  const coalesced = JSON.stringify({ result: "coalesced" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await db.execute(sql`
        WITH existing AS (
          SELECT provider, delivery_id
          FROM ${triggerDeliveries}
          WHERE subject_key = ${accepted.subjectKey}
            AND pending = true
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE
        ), merged AS (
          UPDATE ${triggerDeliveries} inbox
          SET trigger_type = ${accepted.triggerType},
              ticket_key = ${accepted.ticketKey},
              head_sha = ${accepted.pr.headSha},
              definition_id = ${accepted.definitionId},
              definition_version = ${accepted.definitionVersion},
              payload = ${payload}::jsonb,
              updated_at = now()
          FROM existing
          WHERE inbox.provider = existing.provider
            AND inbox.delivery_id = existing.delivery_id
          RETURNING inbox.provider, inbox.delivery_id
        ), queued AS (
          UPDATE ${triggerDeliveries} inbox
          SET pending = true,
              result = ${coalesced}::jsonb,
              updated_at = now()
          WHERE inbox.provider = ${accepted.delivery.provider}
            AND inbox.delivery_id = ${accepted.delivery.deliveryId}
            AND NOT EXISTS (SELECT 1 FROM existing)
          RETURNING inbox.provider, inbox.delivery_id
        )
        UPDATE ${triggerDeliveries} inbox
        SET result = ${coalesced}::jsonb,
            pending = false,
            updated_at = now()
        WHERE inbox.provider = ${accepted.delivery.provider}
          AND inbox.delivery_id = ${accepted.delivery.deliveryId}
          AND EXISTS (SELECT 1 FROM existing)
          AND NOT EXISTS (
            SELECT 1 FROM existing
            WHERE existing.provider = inbox.provider
              AND existing.delivery_id = inbox.delivery_id
          )
      `);
      return;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) throw error;
    }
  }
}

export async function getPendingTrigger(
  db: Db,
  subjectKey: string,
  headSha: string,
  triggerType: PrTriggerType,
): Promise<AcceptedTriggerDelivery | null> {
  const rows = await db
    .select()
    .from(triggerDeliveries)
    .where(
      and(
        eq(triggerDeliveries.subjectKey, subjectKey),
        eq(triggerDeliveries.headSha, headSha),
        eq(triggerDeliveries.triggerType, triggerType),
        eq(triggerDeliveries.pending, true),
      ),
    )
    .limit(1);
  return rows[0] ? mapDelivery(rows[0]) : null;
}

export async function listPendingTriggersForSubject(
  db: Db,
  subjectKey: string,
): Promise<AcceptedTriggerDelivery[]> {
  const rows = await db
    .select()
    .from(triggerDeliveries)
    .where(
      and(
        eq(triggerDeliveries.subjectKey, subjectKey),
        eq(triggerDeliveries.pending, true),
      ),
    )
    .orderBy(asc(triggerDeliveries.createdAt))
    .limit(1);
  return rows.map(mapDelivery);
}

export async function deletePendingTrigger(
  db: Db,
  accepted: Pick<
    AcceptedTriggerDelivery,
    "delivery" | "subjectKey" | "triggerType" | "pr" | "definitionId" | "definitionVersion"
  >,
): Promise<boolean> {
  const rows = await db
    .update(triggerDeliveries)
    .set({ pending: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(triggerDeliveries.provider, accepted.delivery.provider),
        eq(triggerDeliveries.deliveryId, accepted.delivery.deliveryId),
        eq(triggerDeliveries.subjectKey, accepted.subjectKey),
        eq(triggerDeliveries.pending, true),
      ),
    )
    .returning({ deliveryId: triggerDeliveries.deliveryId });
  return rows.length === 1;
}

/** Record start only while this candidate still owns the subject. */
export async function recordCandidateStartedTriggerDelivery(
  db: Pick<Db, "execute">,
  accepted: AcceptedTriggerDelivery,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  const marker = JSON.stringify({ result: "candidate_started", runId });
  const updated = await db.execute(sql`
    UPDATE ${triggerDeliveries} inbox
    SET result = ${marker}::jsonb,
        updated_at = now()
    WHERE inbox.provider = ${accepted.delivery.provider}
      AND inbox.delivery_id = ${accepted.delivery.deliveryId}
      AND inbox.subject_key = ${accepted.subjectKey}
      AND inbox.pending = true
      AND EXISTS (
        SELECT 1 FROM ${activeRuns}
        WHERE ${activeRuns.subjectKey} = ${accepted.subjectKey}
          AND ${activeRuns.ownerToken} = ${ownerToken}
          AND (
            (${activeRuns.state} = 'reserved' AND ${activeRuns.runId} IS NULL)
            OR (${activeRuns.state} = 'bound' AND ${activeRuns.runId} = ${runId})
          )
      )
    RETURNING inbox.delivery_id
  `);
  return rawRows(updated).length === 1;
}

/** Atomically acknowledge the winning Workflow and consume its pending row. */
export async function acknowledgeStartedTriggerDelivery(
  db: Pick<Db, "execute">,
  accepted: Pick<
    AcceptedTriggerDelivery,
    "delivery" | "subjectKey" | "triggerType" | "pr" | "definitionId" | "definitionVersion"
  >,
  runId: string,
): Promise<boolean> {
  const result = JSON.stringify({ result: "started", runId });
  const acknowledged = await db.execute(sql`
    UPDATE ${triggerDeliveries} inbox
    SET result = ${result}::jsonb,
        pending = false,
        updated_at = now()
    WHERE inbox.provider = ${accepted.delivery.provider}
      AND inbox.delivery_id = ${accepted.delivery.deliveryId}
      AND inbox.subject_key = ${accepted.subjectKey}
      AND EXISTS (
        SELECT 1 FROM ${activeRuns}
        WHERE ${activeRuns.subjectKey} = ${accepted.subjectKey}
          AND ${activeRuns.runId} = ${runId}
          AND ${activeRuns.state} = 'bound'
      )
      AND (
        inbox.result IS NULL
        OR inbox.result->>'result' IN ('candidate_started', 'coalesced')
        OR (inbox.result->>'result' = 'started' AND inbox.result->>'runId' = ${runId})
      )
    RETURNING inbox.delivery_id
  `);
  return rawRows(acknowledged).length === 1;
}

function rawRows<T = { deliveryId: string }>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function mapDelivery(row: typeof triggerDeliveries.$inferSelect): StoredTriggerDelivery {
  const payload = row.payload as AcceptedTriggerDelivery;
  return {
    ...payload,
    delivery: {
      provider: row.provider as TriggerEvent["delivery"]["provider"],
      deliveryId: row.deliveryId,
      producer: row.producer,
      ...(payload.delivery.source ? { source: payload.delivery.source } : {}),
    },
    triggerType: row.triggerType as PrTriggerType,
    subjectKey: row.subjectKey,
    ticketKey: row.ticketKey,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    pending: row.pending,
    result: row.result as StoredTriggerResult | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
