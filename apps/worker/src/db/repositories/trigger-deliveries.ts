import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { activeRuns, triggerDeliveries, workflowRuns } from "../schema.js";

type Provider = "github" | "gitlab";

export async function findTriggerDeliveryRow(
  db: Db,
  input: { provider: Provider; deliveryId: string },
) {
  const rows = await db.select().from(triggerDeliveries).where(and(
    eq(triggerDeliveries.provider, input.provider),
    eq(triggerDeliveries.deliveryId, input.deliveryId),
  )).limit(1);
  return rows[0] ?? null;
}

export function findConnectedTriggerDeliveryRow(
  input: Parameters<typeof findTriggerDeliveryRow>[1],
) {
  return findTriggerDeliveryRow(getDb(), input);
}

export async function findTriggerDeliveryRowBySemanticKey(
  db: Db,
  input: { provider: Provider; semanticKey: string },
) {
  const rows = await db.select().from(triggerDeliveries).where(and(
    eq(triggerDeliveries.provider, input.provider),
    eq(triggerDeliveries.semanticKey, input.semanticKey),
  )).limit(1);
  return rows[0] ?? null;
}

export function findConnectedTriggerDeliveryRowBySemanticKey(
  input: Parameters<typeof findTriggerDeliveryRowBySemanticKey>[1],
) {
  return findTriggerDeliveryRowBySemanticKey(getDb(), input);
}

export async function insertTriggerDeliveryRow(
  db: Db,
  input: {
    provider: Provider; deliveryId: string; producer: string; semanticKey: string | null;
    triggerType: string; subjectKey: string; ticketKey: string | null; headSha: string;
    definitionId: number; definitionVersion: number; payload: unknown;
  },
) {
  const rows = await db.insert(triggerDeliveries).values(input).onConflictDoNothing().returning();
  return rows[0] ?? null;
}

export function insertConnectedTriggerDeliveryRow(
  input: Parameters<typeof insertTriggerDeliveryRow>[1],
) {
  return insertTriggerDeliveryRow(getDb(), input);
}

export async function listPendingTriggerDeliveryRows(
  db: Db,
  input: { subjectKey?: string; limit: number },
) {
  return db.select().from(triggerDeliveries).where(
    input.subjectKey === undefined
      ? eq(triggerDeliveries.pending, true)
      : and(eq(triggerDeliveries.subjectKey, input.subjectKey), eq(triggerDeliveries.pending, true)),
  ).orderBy(asc(triggerDeliveries.createdAt)).limit(input.limit);
}

export function listConnectedPendingTriggerDeliveryRows(
  input: Parameters<typeof listPendingTriggerDeliveryRows>[1],
) {
  return listPendingTriggerDeliveryRows(getDb(), input);
}

export function coalesceConnectedPendingTriggerDelivery(
  input: Parameters<typeof coalescePendingTriggerDelivery>[1],
): Promise<void> {
  return coalescePendingTriggerDelivery(getDb(), input);
}

export async function coalescePendingTriggerDelivery(
  db: Db,
  input: {
    provider: Provider;
    deliveryId: string;
    subjectKey: string;
    triggerType: string;
    ticketKey: string | null;
    headSha: string;
    definitionId: number;
    definitionVersion: number;
    payload: string;
  },
): Promise<void> {
  const coalesced = JSON.stringify({ result: "coalesced" });
  await db.execute(sql`
    WITH existing AS (
      SELECT provider, delivery_id FROM ${triggerDeliveries}
      WHERE subject_key = ${input.subjectKey} AND pending = true
      ORDER BY created_at LIMIT 1 FOR UPDATE
    ), merged AS (
      UPDATE ${triggerDeliveries} inbox
      SET trigger_type = ${input.triggerType}, ticket_key = ${input.ticketKey},
          head_sha = ${input.headSha}, definition_id = ${input.definitionId},
          definition_version = ${input.definitionVersion}, payload = ${input.payload}::jsonb,
          updated_at = now()
      FROM existing
      WHERE inbox.provider = existing.provider AND inbox.delivery_id = existing.delivery_id
      RETURNING inbox.provider, inbox.delivery_id
    ), queued AS (
      UPDATE ${triggerDeliveries} inbox
      SET pending = true, result = ${coalesced}::jsonb, updated_at = now()
      WHERE inbox.provider = ${input.provider} AND inbox.delivery_id = ${input.deliveryId}
        AND NOT EXISTS (SELECT 1 FROM existing)
      RETURNING inbox.provider, inbox.delivery_id
    )
    UPDATE ${triggerDeliveries} inbox
    SET result = ${coalesced}::jsonb, pending = false, updated_at = now()
    WHERE inbox.provider = ${input.provider} AND inbox.delivery_id = ${input.deliveryId}
      AND EXISTS (SELECT 1 FROM existing)
      AND NOT EXISTS (
        SELECT 1 FROM existing
        WHERE existing.provider = inbox.provider AND existing.delivery_id = inbox.delivery_id
      )
  `);
}

export async function recordCandidateStartedTriggerDelivery(
  db: Pick<Db, "execute">,
  input: { provider: Provider; deliveryId: string; subjectKey: string; ownerToken: string; runId: string },
): Promise<boolean> {
  const marker = JSON.stringify({ result: "candidate_started", runId: input.runId });
  const updated = await db.execute(sql`
    UPDATE ${triggerDeliveries} inbox
    SET result = ${marker}::jsonb, updated_at = now()
    WHERE inbox.provider = ${input.provider} AND inbox.delivery_id = ${input.deliveryId}
      AND inbox.subject_key = ${input.subjectKey} AND inbox.pending = true
      AND EXISTS (
        SELECT 1 FROM ${activeRuns}
        WHERE ${activeRuns.subjectKey} = ${input.subjectKey}
          AND ${activeRuns.ownerToken} = ${input.ownerToken}
          AND ((${activeRuns.state} = 'reserved' AND ${activeRuns.runId} IS NULL)
            OR (${activeRuns.state} = 'bound' AND ${activeRuns.runId} = ${input.runId}))
      )
      AND EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.runId} = ${input.runId})
    RETURNING inbox.delivery_id
  `);
  return ((updated as { rows?: unknown[] }).rows ?? []).length === 1;
}

export async function acknowledgeStartedTriggerDelivery(
  db: Pick<Db, "execute">,
  input: { provider: Provider; deliveryId: string; subjectKey: string; runId: string },
): Promise<boolean> {
  const result = JSON.stringify({ result: "started", runId: input.runId });
  const acknowledged = await db.execute(sql`
    UPDATE ${triggerDeliveries} inbox
    SET result = ${result}::jsonb, pending = false, updated_at = now()
    WHERE inbox.provider = ${input.provider} AND inbox.delivery_id = ${input.deliveryId}
      AND inbox.subject_key = ${input.subjectKey}
      AND EXISTS (
        SELECT 1 FROM ${activeRuns}
        WHERE ${activeRuns.subjectKey} = ${input.subjectKey}
          AND ${activeRuns.runId} = ${input.runId} AND ${activeRuns.state} = 'bound'
      )
      AND EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.runId} = ${input.runId})
      AND (inbox.result IS NULL OR inbox.result->>'result' IN ('candidate_started', 'coalesced')
        OR (inbox.result->>'result' = 'started' AND inbox.result->>'runId' = ${input.runId}))
    RETURNING inbox.delivery_id
  `);
  return ((acknowledged as { rows?: unknown[] }).rows ?? []).length === 1;
}

export function recordConnectedCandidateStartedTriggerDelivery(
  input: Parameters<typeof recordCandidateStartedTriggerDelivery>[1],
): Promise<boolean> {
  return recordCandidateStartedTriggerDelivery(getDb(), input);
}

export function acknowledgeConnectedStartedTriggerDelivery(
  input: Parameters<typeof acknowledgeStartedTriggerDelivery>[1],
): Promise<boolean> {
  return acknowledgeStartedTriggerDelivery(getDb(), input);
}

export async function completeTriggerDelivery(
  db: Db,
  provider: Provider,
  deliveryId: string,
  result: {
    result:
      | "started"
      | "candidate_started"
      | "error"
      | "coalesced"
      | "at_capacity"
      | "ignored_provider"
      | "ignored_stale_head"
      | "ignored_not_workflow_owned";
    runId?: string;
    diagnosticId?: string;
  },
): Promise<void> {
  const serializedResult = JSON.stringify(result);
  const pending =
    result.result === "error"
      ? true
      : result.result === "coalesced"
        ? sql`${triggerDeliveries.pending}`
        : false;
  await db
    .update(triggerDeliveries)
    .set({
      pending,
      result: sql`case
        when ${triggerDeliveries.result} is null
          then ${serializedResult}::jsonb
        when ${triggerDeliveries.result}->>'result' = 'coalesced'
          and ${result.result} = 'error'
          then ${serializedResult}::jsonb
        when ${triggerDeliveries.result}->>'result' in ('candidate_started', 'coalesced', 'error')
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

export function completeConnectedTriggerDelivery(
  provider: Provider,
  deliveryId: string,
  result: Parameters<typeof completeTriggerDelivery>[3],
): Promise<void> {
  return completeTriggerDelivery(getDb(), provider, deliveryId, result);
}

export async function deletePendingTriggerDelivery(
  db: Db,
  input: { provider: Provider; deliveryId: string; subjectKey: string },
): Promise<boolean> {
  const rows = await db
    .update(triggerDeliveries)
    .set({ pending: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(triggerDeliveries.provider, input.provider),
        eq(triggerDeliveries.deliveryId, input.deliveryId),
        eq(triggerDeliveries.subjectKey, input.subjectKey),
        eq(triggerDeliveries.pending, true),
      ),
    )
    .returning({ deliveryId: triggerDeliveries.deliveryId });
  return rows.length === 1;
}

export function deleteConnectedPendingTriggerDelivery(
  input: Parameters<typeof deletePendingTriggerDelivery>[1],
): Promise<boolean> {
  return deletePendingTriggerDelivery(getDb(), input);
}
