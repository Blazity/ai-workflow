import type { Db } from "../../db/types.js";
import {
  acknowledgeStartedTriggerDelivery as acknowledgeStartedTriggerDeliveryRow,
  coalesceConnectedPendingTriggerDelivery,
  coalescePendingTriggerDelivery,
  completeTriggerDelivery as completeTriggerDeliveryRow,
  completeConnectedTriggerDelivery,
  deletePendingTriggerDelivery,
  deleteConnectedPendingTriggerDelivery,
  findConnectedTriggerDeliveryRow,
  findConnectedTriggerDeliveryRowBySemanticKey,
  insertConnectedTriggerDeliveryRow,
  insertTriggerDeliveryRow,
  listConnectedPendingTriggerDeliveryRows,
  listPendingTriggerDeliveryRows,
  findTriggerDeliveryRow,
  findTriggerDeliveryRowBySemanticKey,
  recordConnectedCandidateStartedTriggerDelivery,
  recordCandidateStartedTriggerDelivery as recordCandidateStartedTriggerDeliveryRow,
} from "../../db/repositories/trigger-deliveries.js";
import { isUniqueViolation } from "../../infra/unique-violation.js";
import type { PrTriggerType } from "../../engine/agent-input.js";
import type { TriggerEvent } from "./trigger-events.js";

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
  | { result: "error"; diagnosticId: string }
  | {
      result:
        | "coalesced"
        | "at_capacity"
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
 * retries return the first stored envelope and can never change its pin. A
 * delivery whose semantic key already exists returns the semantic winner's
 * envelope instead: the loser's delivery id is never recorded, and provider
 * redeliveries of the loser keep resolving to the same winner. */
export async function acceptTriggerDelivery(
  db: Db,
  accepted: AcceptedTriggerDelivery,
): Promise<
  | { inserted: true; stored: StoredTriggerDelivery }
  | { inserted: false; stored: StoredTriggerDelivery }
> {
  const inserted = await insertTriggerDeliveryRow(db, {
      provider: accepted.delivery.provider,
      deliveryId: accepted.delivery.deliveryId,
      producer: accepted.delivery.producer,
      semanticKey: accepted.delivery.semanticKey ?? null,
      triggerType: accepted.triggerType,
      subjectKey: accepted.subjectKey,
      ticketKey: accepted.ticketKey,
      headSha: accepted.pr.headSha,
      definitionId: accepted.definitionId,
      definitionVersion: accepted.definitionVersion,
      payload: accepted,
    });
  if (inserted) return { inserted: true, stored: mapDelivery(inserted) };
  const stored =
    (await getTriggerDelivery(
      db,
      accepted.delivery.provider,
      accepted.delivery.deliveryId,
    )) ??
    (accepted.delivery.semanticKey
      ? await getTriggerDeliveryBySemanticKey(
          db,
          accepted.delivery.provider,
          accepted.delivery.semanticKey,
        )
      : null);
  if (!stored) throw new Error("trigger delivery disappeared after unique conflict");
  return { inserted: false, stored };
}

export async function completeTriggerDelivery(
  db: Db,
  provider: "github" | "gitlab",
  deliveryId: string,
  result: StoredTriggerResult,
): Promise<void> {
  await completeTriggerDeliveryRow(db, provider, deliveryId, result);
}

export async function getTriggerDelivery(
  db: Db,
  provider: "github" | "gitlab",
  deliveryId: string,
): Promise<StoredTriggerDelivery | null> {
  const row = await findTriggerDeliveryRow(db, { provider, deliveryId });
  return row ? mapDelivery(row) : null;
}

/** Resolve the delivery that owns a semantic key (the winner of a
 * semantic-key conflict). */
export async function getTriggerDeliveryBySemanticKey(
  db: Db,
  provider: "github" | "gitlab",
  semanticKey: string,
): Promise<StoredTriggerDelivery | null> {
  const row = await findTriggerDeliveryRowBySemanticKey(db, { provider, semanticKey });
  return row ? mapDelivery(row) : null;
}

/** Keep exactly one pending semantic event for a subject. Newer feedback
 * replaces the pending payload while every provider delivery id remains a
 * separate dedupe record. */
export async function coalescePendingTrigger(
  db: Db,
  accepted: AcceptedTriggerDelivery,
): Promise<void> {
  const payload = JSON.stringify(accepted);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await coalescePendingTriggerDelivery(db, {
        provider: accepted.delivery.provider,
        deliveryId: accepted.delivery.deliveryId,
        subjectKey: accepted.subjectKey,
        triggerType: accepted.triggerType,
        ticketKey: accepted.ticketKey,
        headSha: accepted.pr.headSha,
        definitionId: accepted.definitionId,
        definitionVersion: accepted.definitionVersion,
        payload,
      });
      return;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) throw error;
    }
  }
}

export async function listPendingTriggersForSubject(
  db: Db,
  subjectKey: string,
): Promise<AcceptedTriggerDelivery[]> {
  const rows = await listPendingTriggerDeliveryRows(db, { subjectKey, limit: 1 });
  return rows.map(mapDelivery);
}

export async function listPendingTriggers(
  db: Db,
  limit: number,
): Promise<AcceptedTriggerDelivery[]> {
  const rows = await listPendingTriggerDeliveryRows(db, { limit });
  return rows.map(mapDelivery);
}

export async function listConnectedPendingTriggers(
  limit: number,
): Promise<{ subjectKey: string; updatedAt: Date }[]> {
  return listConnectedPendingTriggerDeliveryRows({ limit });
}

export async function deletePendingTrigger(
  db: Db,
  accepted: Pick<
    AcceptedTriggerDelivery,
    "delivery" | "subjectKey" | "triggerType" | "pr" | "definitionId" | "definitionVersion"
  >,
): Promise<boolean> {
  return deletePendingTriggerDelivery(db, {
    provider: accepted.delivery.provider,
    deliveryId: accepted.delivery.deliveryId,
    subjectKey: accepted.subjectKey,
  });
}

/** Record start only while this candidate still owns the subject. */
export async function recordCandidateStartedTriggerDelivery(
  db: Pick<Db, "execute">,
  accepted: AcceptedTriggerDelivery,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  return recordCandidateStartedTriggerDeliveryRow(db, {
    provider: accepted.delivery.provider,
    deliveryId: accepted.delivery.deliveryId,
    subjectKey: accepted.subjectKey,
    ownerToken,
    runId,
  });
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
  return acknowledgeStartedTriggerDeliveryRow(db, {
    provider: accepted.delivery.provider,
    deliveryId: accepted.delivery.deliveryId,
    subjectKey: accepted.subjectKey,
    runId,
  });
}

export async function getConnectedTriggerDelivery(
  provider: "github" | "gitlab",
  deliveryId: string,
): Promise<StoredTriggerDelivery | null> {
  const row = await findConnectedTriggerDeliveryRow({ provider, deliveryId });
  return row ? mapDelivery(row) : null;
}

export async function acceptConnectedTriggerDelivery(
  accepted: AcceptedTriggerDelivery,
): Promise<{ inserted: boolean; stored: StoredTriggerDelivery }> {
  const inserted = await insertConnectedTriggerDeliveryRow({
    provider: accepted.delivery.provider,
    deliveryId: accepted.delivery.deliveryId,
    producer: accepted.delivery.producer,
    semanticKey: accepted.delivery.semanticKey ?? null,
    triggerType: accepted.triggerType,
    subjectKey: accepted.subjectKey,
    ticketKey: accepted.ticketKey,
    headSha: accepted.pr.headSha,
    definitionId: accepted.definitionId,
    definitionVersion: accepted.definitionVersion,
    payload: accepted,
  });
  if (inserted) return { inserted: true, stored: mapDelivery(inserted) };
  const byDeliveryId = await getConnectedTriggerDelivery(
    accepted.delivery.provider,
    accepted.delivery.deliveryId,
  );
  const bySemanticKey = accepted.delivery.semanticKey
    ? await findConnectedTriggerDeliveryRowBySemanticKey({
        provider: accepted.delivery.provider,
        semanticKey: accepted.delivery.semanticKey,
      })
    : null;
  const stored = byDeliveryId ?? (bySemanticKey ? mapDelivery(bySemanticKey) : null);
  if (!stored) throw new Error("trigger delivery disappeared after unique conflict");
  return { inserted: false, stored };
}

export async function coalesceConnectedPendingTrigger(
  accepted: AcceptedTriggerDelivery,
): Promise<void> {
  const payload = JSON.stringify(accepted);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await coalesceConnectedPendingTriggerDelivery({
        provider: accepted.delivery.provider,
        deliveryId: accepted.delivery.deliveryId,
        subjectKey: accepted.subjectKey,
        triggerType: accepted.triggerType,
        ticketKey: accepted.ticketKey,
        headSha: accepted.pr.headSha,
        definitionId: accepted.definitionId,
        definitionVersion: accepted.definitionVersion,
        payload,
      });
      return;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) throw error;
    }
  }
}

export async function listConnectedPendingTriggersForSubject(
  subjectKey: string,
): Promise<AcceptedTriggerDelivery[]> {
  return (await listConnectedPendingTriggerDeliveryRows({ subjectKey, limit: 1 })).map(mapDelivery);
}

export async function completeConnectedTriggerDeliveryResult(
  accepted: Pick<TriggerEvent, "delivery">,
  result: StoredTriggerResult,
): Promise<void> {
  await completeConnectedTriggerDelivery(
    accepted.delivery.provider,
    accepted.delivery.deliveryId,
    result,
  );
}

export async function deleteConnectedPendingTrigger(
  accepted: Pick<AcceptedTriggerDelivery, "delivery" | "subjectKey">,
): Promise<boolean> {
  return deleteConnectedPendingTriggerDelivery({
    provider: accepted.delivery.provider,
    deliveryId: accepted.delivery.deliveryId,
    subjectKey: accepted.subjectKey,
  });
}

export async function recordConnectedCandidateStartedTrigger(
  accepted: AcceptedTriggerDelivery,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  return recordConnectedCandidateStartedTriggerDelivery({
    provider: accepted.delivery.provider,
    deliveryId: accepted.delivery.deliveryId,
    subjectKey: accepted.subjectKey,
    ownerToken,
    runId,
  });
}

function mapDelivery(row: NonNullable<Awaited<ReturnType<typeof findTriggerDeliveryRow>>>): StoredTriggerDelivery {
  const payload = row.payload as AcceptedTriggerDelivery;
  return {
    ...payload,
    delivery: {
      provider: row.provider as TriggerEvent["delivery"]["provider"],
      deliveryId: row.deliveryId,
      producer: row.producer,
      ...(payload.delivery.source ? { source: payload.delivery.source } : {}),
      ...(row.semanticKey ? { semanticKey: row.semanticKey } : {}),
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
