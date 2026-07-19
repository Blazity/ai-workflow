import { sql } from "drizzle-orm";
import type { IssueTrackerMoveTarget } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";

// This TTL bounds unused intent records. Once a provider call starts, expiry is
// never negative proof that Jira rejected it: the exact owner remains fenced
// until completion is positively observed.
const DEFAULT_INTENT_TTL_MS = 2 * 60 * 60 * 1000;

// Keep positive provider evidence well beyond Jira's complete webhook retry
// window. Delayed bot echoes can then still be suppressed after owner release;
// every matching delivery renews the same evidence window.
const FINISHED_ECHO_EVIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface RecordIntentInput {
  ticketKey: string;
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
  actorAccountId: string;
  target: IssueTrackerMoveTarget;
  ttlMs?: number;
}

interface IntentOwner {
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
}

interface CancellationFenceInput extends IntentOwner {
  ticketKey: string;
  target: IssueTrackerMoveTarget;
  webhookIdentifier: string;
  occurredAt: Date;
  ttlMs?: number;
}

export interface TicketCancellationFence {
  id: number;
  target: IssueTrackerMoveTarget;
  occurredAt: Date;
  createdAt: Date;
}

export interface TicketCancellationFenceOwner {
  ownerToken: string;
  runId: string | null;
}

export interface PotentialLateTicketTransition {
  id: number;
  target: IssueTrackerMoveTarget;
  providerFinishedAt: Date | null;
}

export interface UnfinishedTicketTransition {
  id: number;
  target: IssueTrackerMoveTarget;
}

export async function recordTicketTransitionIntent(
  db: Db,
  input: RecordIntentInput,
): Promise<number> {
  await deleteExpiredIntents(db);
  const target = normalizeTarget(input.target);
  const ownerState =
    input.runId === null
      ? sql`state = 'reserved' AND run_id IS NULL`
      : sql`state = 'bound' AND run_id = ${input.runId}`;
  const result = await db.execute(sql`
    INSERT INTO ticket_transition_intents (
      ticket_key,
      subject_key,
      owner_token,
      run_id,
      actor_account_id,
      target_status_id,
      target_status_name,
      provider_started_at,
      expires_at
    )
    SELECT
      ${input.ticketKey},
      ${input.subjectKey},
      ${input.ownerToken},
      ${input.runId},
      ${input.actorAccountId},
      ${target.statusId},
      ${target.name},
      NULL,
      ${new Date(Date.now() + (input.ttlMs ?? DEFAULT_INTENT_TTL_MS))}
    FROM active_runs
    WHERE subject_key = ${input.subjectKey}
      AND owner_token = ${input.ownerToken}
      AND ${ownerState}
    RETURNING id
  `);
  const row = rawRows<{ id: number }>(result)[0];
  if (!row) {
    throw new Error("Cannot record ticket transition intent without the exact current owner.");
  }
  return row.id;
}

/** Atomically opens the provider boundary while the intent's exact owner is
 * still dispatchable. Cancellation updates that same owner row to
 * `cancelling`, so either this marker wins and becomes drain-visible or the
 * provider call is never made. */
export async function beginTicketTransitionIntent(
  db: Db,
  intentId: number,
  owner: IntentOwner,
): Promise<boolean> {
  const ownerState =
    owner.runId === null
      ? sql`active.state = 'reserved' AND active.run_id IS NULL`
      : sql`active.state = 'bound' AND active.run_id = ${owner.runId}`;
  const result = await db.execute(sql`
    WITH exact_owner AS MATERIALIZED (
      SELECT active.subject_key, active.owner_token, active.run_id
      FROM active_runs AS active
      WHERE active.subject_key = ${owner.subjectKey}
        AND active.owner_token = ${owner.ownerToken}
        AND ${ownerState}
      FOR UPDATE
    ), started_intent AS (
      UPDATE ticket_transition_intents AS intent
      SET
        provider_started_at = coalesce(intent.provider_started_at, now()),
        expires_at = greatest(
          intent.expires_at,
          ${new Date(Date.now() + DEFAULT_INTENT_TTL_MS)}
        )
      FROM exact_owner AS owner
      WHERE intent.id = ${intentId}
        AND intent.subject_key = owner.subject_key
        AND intent.owner_token = owner.owner_token
        AND ${owner.runId === null ? sql`intent.run_id IS NULL` : sql`intent.run_id = ${owner.runId}`}
        AND intent.provider_finished_at IS NULL
      RETURNING intent.id
    )
    SELECT id FROM started_intent
  `);
  return rawRows<{ id: number }>(result).length > 0;
}

export async function finishTicketTransitionIntent(
  db: Db,
  intentId: number,
): Promise<boolean> {
  const evidenceExpiresAt = new Date(
    Date.now() + FINISHED_ECHO_EVIDENCE_RETENTION_MS,
  );
  const result = await db.execute(sql`
    UPDATE ticket_transition_intents
    SET
      provider_finished_at = coalesce(provider_finished_at, now()),
      expires_at = greatest(expires_at, ${evidenceExpiresAt})
    WHERE id = ${intentId}
      AND provider_started_at IS NOT NULL
    RETURNING id
  `);
  return rawRows<{ id: number }>(result).length > 0;
}

/** Starts the clarification recovery provider boundary in the same statement
 * that proves its exact predecessor is still parked. Cancellation updates that
 * owner row to `cancelling`, so row locking linearizes the two operations: if
 * cancellation wins, no intent is inserted and no provider call may begin. */
export async function recordStartedParkedTicketTransitionIntent(
  db: Db,
  input: Omit<RecordIntentInput, "runId"> & { runId: string },
): Promise<number> {
  await deleteExpiredIntents(db);
  const target = normalizeTarget(input.target);
  const result = await db.execute(sql`
    WITH exact_owner AS MATERIALIZED (
      SELECT active.subject_key, active.owner_token, active.run_id
      FROM active_runs AS active
      WHERE active.subject_key = ${input.subjectKey}
        AND active.owner_token = ${input.ownerToken}
        AND active.run_id = ${input.runId}
        AND active.state = 'parked'
        AND active.ticket_provider_calls_in_flight = 0
        AND NOT EXISTS (
          SELECT 1
          FROM ticket_transition_intents AS unfinished
          WHERE unfinished.subject_key = active.subject_key
            AND unfinished.owner_token = active.owner_token
            AND unfinished.run_id = active.run_id
            AND unfinished.provider_started_at IS NOT NULL
            AND unfinished.provider_finished_at IS NULL
        )
      FOR UPDATE
    ), started_intent AS (
      INSERT INTO ticket_transition_intents (
        ticket_key,
        subject_key,
        owner_token,
        run_id,
        actor_account_id,
        target_status_id,
        target_status_name,
        provider_started_at,
        expires_at
      )
      SELECT
        ${input.ticketKey},
        owner.subject_key,
        owner.owner_token,
        owner.run_id,
        ${input.actorAccountId},
        ${target.statusId},
        ${target.name},
        now(),
        ${new Date(Date.now() + (input.ttlMs ?? DEFAULT_INTENT_TTL_MS))}
      FROM exact_owner AS owner
      RETURNING id
    )
    SELECT id FROM started_intent
  `);
  const row = rawRows<{ id: number }>(result)[0];
  if (!row) {
    throw new Error(
      "Cannot start ticket transition without the exact parked owner.",
    );
  }
  return row.id;
}

/** Records an echo-suppression intent for the compensating transition while
 * the exact owner remains closed. The start marker is part of the same SQL
 * statement, so cancellation cannot release without seeing this mutation. */
export async function recordStartedTicketReconciliationIntent(
  db: Db,
  input: RecordIntentInput,
): Promise<number> {
  await deleteExpiredIntents(db);
  const target = normalizeTarget(input.target);
  const runMatch =
    input.runId === null
      ? sql`active.run_id IS NULL`
      : sql`active.run_id = ${input.runId}`;
  const result = await db.execute(sql`
    WITH exact_owner AS MATERIALIZED (
      SELECT active.subject_key, active.owner_token, active.run_id
      FROM active_runs AS active
      WHERE active.subject_key = ${input.subjectKey}
        AND active.owner_token = ${input.ownerToken}
        AND active.state = 'cancelling'
        AND ${runMatch}
      FOR UPDATE
    ), started_intent AS (
      INSERT INTO ticket_transition_intents (
        ticket_key,
        subject_key,
        owner_token,
        run_id,
        actor_account_id,
        target_status_id,
        target_status_name,
        provider_started_at,
        expires_at
      )
      SELECT
        ${input.ticketKey},
        owner.subject_key,
        owner.owner_token,
        owner.run_id,
        ${input.actorAccountId},
        ${target.statusId},
        ${target.name},
        now(),
        ${new Date(Date.now() + (input.ttlMs ?? DEFAULT_INTENT_TTL_MS))}
      FROM exact_owner AS owner
      RETURNING id
    )
    SELECT id FROM started_intent
  `);
  const row = rawRows<{ id: number }>(result)[0];
  if (!row) {
    throw new Error(
      "Cannot record ticket reconciliation intent without the exact cancelling owner.",
    );
  }
  return row.id;
}

/** Stores every unmatched Jira status delivery separately. Jira reuses the
 * delivery id for retries, while ordering by the provider occurrence time
 * preserves a later human destination if an older delivery is retried. */
export async function recordTicketCancellationFence(
  db: Db,
  input: CancellationFenceInput,
): Promise<boolean> {
  return (await recordTicketCancellationFenceOwner(db, input)) !== null;
}

/** Records the human destination and returns the exact claim closed by that
 * same statement. It may follow only the successor token durably minted by
 * the observed clarification checkpoint; callers never cancel a generic
 * current-owner reread. */
export async function recordTicketCancellationFenceOwner(
  db: Db,
  input: CancellationFenceInput,
): Promise<TicketCancellationFenceOwner | null> {
  await deleteExpiredCancellationFences(db);
  const target = normalizeTarget(input.target);
  const runMatch =
    input.runId === null
      ? sql`active.run_id IS NULL`
      : sql`active.run_id = ${input.runId}`;
  const result = await db.execute(sql`
    WITH exact_owner AS MATERIALIZED (
      SELECT active.subject_key, active.owner_token, active.run_id
      FROM active_runs AS active
      WHERE active.subject_key = ${input.subjectKey}
        AND active.state IN ('reserved', 'bound', 'parking', 'parked', 'cancelling')
        AND (
          (active.owner_token = ${input.ownerToken} AND ${runMatch})
          OR EXISTS (
            SELECT 1
            FROM clarification_requests AS clarification
            WHERE clarification.subject_key = active.subject_key
              AND clarification.owner_token = ${input.ownerToken}
              AND ${input.runId === null ? sql`false` : sql`clarification.run_id = ${input.runId}`}
              AND clarification.successor_owner_token = active.owner_token
          )
        )
      FOR UPDATE
    ), accepted_fence AS (
      INSERT INTO ticket_cancellation_fences (
        ticket_key,
        subject_key,
        owner_token,
        run_id,
        target_status_id,
        target_status_name,
        webhook_identifier,
        occurred_at,
        expires_at
      )
      SELECT
        ${input.ticketKey},
        owner.subject_key,
        owner.owner_token,
        owner.run_id,
        ${target.statusId},
        ${target.name},
        ${input.webhookIdentifier},
        ${input.occurredAt},
        ${new Date(Date.now() + (input.ttlMs ?? DEFAULT_INTENT_TTL_MS))}
      FROM exact_owner AS owner
      ON CONFLICT (webhook_identifier) DO UPDATE
      SET webhook_identifier = EXCLUDED.webhook_identifier
      WHERE ticket_cancellation_fences.ticket_key = EXCLUDED.ticket_key
        AND ticket_cancellation_fences.subject_key = EXCLUDED.subject_key
        AND ticket_cancellation_fences.owner_token = EXCLUDED.owner_token
        AND ticket_cancellation_fences.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
      RETURNING id
    ), closed_owner AS (
      UPDATE active_runs AS active
      SET
        state = 'cancelling',
        ticket_mutation_version = active.ticket_mutation_version + 1,
        ticket_cancellation_reconciled_version = -1,
        updated_at = now()
      FROM exact_owner AS owner
      WHERE active.subject_key = owner.subject_key
        AND active.owner_token = owner.owner_token
        AND active.run_id IS NOT DISTINCT FROM owner.run_id
        AND EXISTS (SELECT 1 FROM accepted_fence)
      RETURNING
        active.owner_token AS "ownerToken",
        active.run_id AS "runId"
    )
    SELECT closed_owner."ownerToken", closed_owner."runId"
    FROM accepted_fence, closed_owner
  `);
  return rawRows<TicketCancellationFenceOwner>(result)[0] ?? null;
}

/** Reads the exact post-reconciliation CAS value. Provider starts and human
 * fences increment it in their atomic owner-locked statement. */
export async function getTicketMutationVersion(
  db: Db,
  owner: IntentOwner,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT ticket_mutation_version AS "mutationVersion"
    FROM active_runs
    WHERE subject_key = ${owner.subjectKey}
      AND owner_token = ${owner.ownerToken}
      AND state = 'cancelling'
      AND ${owner.runId === null ? sql`run_id IS NULL` : sql`run_id = ${owner.runId}`}
    LIMIT 1
  `);
  const row = rawRows<{ mutationVersion: number | string }>(result)[0];
  if (!row) {
    throw new Error("Cannot read ticket mutation version without the exact cancelling owner.");
  }
  return Number(row.mutationVersion);
}

export async function getTicketCancellationFence(
  db: Db,
  input: IntentOwner & { ticketKey: string },
): Promise<TicketCancellationFence | null> {
  await deleteExpiredCancellationFences(db);
  const result = await db.execute(sql`
    SELECT
      id,
      target_status_id AS "targetStatusId",
      target_status_name AS "targetStatusName",
      occurred_at AS "occurredAt",
      created_at AS "createdAt"
    FROM ticket_cancellation_fences
    WHERE ticket_key = ${input.ticketKey}
      AND subject_key = ${input.subjectKey}
      AND owner_token = ${input.ownerToken}
      AND ${input.runId === null ? sql`run_id IS NULL` : sql`run_id = ${input.runId}`}
      AND (
        expires_at > now()
        OR EXISTS (
          SELECT 1 FROM active_runs AS active
          WHERE active.subject_key = ticket_cancellation_fences.subject_key
            AND active.owner_token = ticket_cancellation_fences.owner_token
            AND active.state = 'cancelling'
            AND (
              active.run_id = ticket_cancellation_fences.run_id
              OR (active.run_id IS NULL AND ticket_cancellation_fences.run_id IS NULL)
            )
        )
      )
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `);
  const row = rawRows<{
    id: number;
    targetStatusId: string | null;
    targetStatusName: string;
    occurredAt: Date | string;
    createdAt: Date | string;
  }>(result)[0];
  if (!row) return null;
  return {
    id: row.id,
    target: denormalizeTarget(row.targetStatusName, row.targetStatusId),
    occurredAt: toDate(row.occurredAt),
    createdAt: toDate(row.createdAt),
  };
}

export async function listPotentialLateTicketTransitionTargets(
  db: Db,
  input: IntentOwner & { ticketKey: string; finishedAfter: Date },
): Promise<PotentialLateTicketTransition[]> {
  const result = await db.execute(sql`
    SELECT
      id,
      target_status_id AS "targetStatusId",
      target_status_name AS "targetStatusName",
      provider_finished_at AS "providerFinishedAt"
    FROM ticket_transition_intents
    WHERE ticket_key = ${input.ticketKey}
      AND subject_key = ${input.subjectKey}
      AND owner_token = ${input.ownerToken}
      AND ${input.runId === null ? sql`run_id IS NULL` : sql`run_id = ${input.runId}`}
      AND provider_started_at IS NOT NULL
      AND (provider_finished_at IS NULL OR provider_finished_at >= ${input.finishedAfter})
      -- Expiry is never settlement proof for a started call. Unfinished calls
      -- remain visible while the exact cancelling owner is quarantined;
      -- finished evidence uses its renewed retention window after release.
      AND (
        expires_at > now()
        OR EXISTS (
          SELECT 1 FROM active_runs AS active
          WHERE active.subject_key = ticket_transition_intents.subject_key
            AND active.owner_token = ticket_transition_intents.owner_token
            AND active.state = 'cancelling'
            AND (
              active.run_id = ticket_transition_intents.run_id
              OR (active.run_id IS NULL AND ticket_transition_intents.run_id IS NULL)
            )
        )
      )
    ORDER BY provider_finished_at ASC NULLS LAST, id ASC
  `);
  return rawRows<{
    id: number;
    targetStatusId: string | null;
    targetStatusName: string;
    providerFinishedAt: Date | string | null;
  }>(result).map((row) => ({
    id: row.id,
    target: denormalizeTarget(row.targetStatusName, row.targetStatusId),
    providerFinishedAt:
      row.providerFinishedAt === null ? null : toDate(row.providerFinishedAt),
  }));
}

export async function listUnfinishedTicketTransitions(
  db: Db,
  owner: IntentOwner & { ticketKey: string },
): Promise<UnfinishedTicketTransition[]> {
  const result = await db.execute(sql`
    SELECT
      id,
      target_status_id AS "targetStatusId",
      target_status_name AS "targetStatusName"
    FROM ticket_transition_intents
    WHERE ticket_key = ${owner.ticketKey}
      AND subject_key = ${owner.subjectKey}
      AND owner_token = ${owner.ownerToken}
      AND ${owner.runId === null ? sql`run_id IS NULL` : sql`run_id = ${owner.runId}`}
      AND provider_started_at IS NOT NULL
      AND provider_finished_at IS NULL
    ORDER BY provider_started_at ASC, id ASC
  `);
  return rawRows<{
    id: number;
    targetStatusId: string | null;
    targetStatusName: string;
  }>(result).map((row) => ({
    id: row.id,
    target: denormalizeTarget(row.targetStatusName, row.targetStatusId),
  }));
}

export async function consumeTicketTransitionIntent(
  db: Db,
  ticketKey: string,
  status: { id?: string | null; name?: string | null },
  echo: { webhookIdentifier: string; actorAccountId: string },
): Promise<boolean> {
  const statusId = status.id?.trim() ?? "";
  const statusName = status.name?.trim() ?? "";
  const webhookIdentifier = echo.webhookIdentifier.trim();
  const actorAccountId = echo.actorAccountId.trim();
  if ((!statusId && !statusName) || !webhookIdentifier || !actorAccountId) return false;

  const match = statusId && statusName
    ? sql`(
        (target_status_id IS NOT NULL AND target_status_id = ${statusId})
        OR (target_status_id IS NULL AND lower(target_status_name) = lower(${statusName}))
      )`
    : statusId
      ? sql`target_status_id = ${statusId}`
      : sql`target_status_id IS NULL AND lower(target_status_name) = lower(${statusName})`;

  // This is deliberately one statement: the production neon-http driver does
  // not provide interactive transactions. Do not skip a locked row. Under
  // READ COMMITTED, a concurrent delivery waits and PostgreSQL re-evaluates the
  // candidate predicate against the now-current row: the same stable webhook
  // id remains eligible, while a different delivery fails closed.
  const evidenceExpiresAt = new Date(
    Date.now() + FINISHED_ECHO_EVIDENCE_RETENTION_MS,
  );
  const result = await db.execute(sql`
    WITH expired AS (
      DELETE FROM ticket_transition_intents AS stale
      WHERE stale.expires_at <= now()
        AND NOT EXISTS (
            SELECT 1 FROM active_runs AS active
            WHERE active.subject_key = stale.subject_key
              AND active.owner_token = stale.owner_token
              AND stale.provider_started_at IS NOT NULL
              AND (
                stale.provider_finished_at IS NULL
                OR active.state = 'cancelling'
              )
              AND (
                active.run_id = stale.run_id
                OR (active.run_id IS NULL AND stale.run_id IS NULL)
              )
        )
    ), candidate AS (
      SELECT id
      FROM ticket_transition_intents
      WHERE ticket_key = ${ticketKey}
        AND actor_account_id = ${actorAccountId}
        AND (
          expires_at > now()
          OR (
            provider_started_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM active_runs AS active
              WHERE active.subject_key = ticket_transition_intents.subject_key
                AND active.owner_token = ticket_transition_intents.owner_token
                AND (
                  provider_finished_at IS NULL
                  OR active.state = 'cancelling'
                )
                AND (
                  active.run_id = ticket_transition_intents.run_id
                  OR (active.run_id IS NULL AND ticket_transition_intents.run_id IS NULL)
                )
            )
          )
        )
        AND ${match}
        AND (
          (consumed_at IS NULL AND webhook_identifier IS NULL)
          OR webhook_identifier = ${webhookIdentifier}
        )
      ORDER BY
        CASE WHEN webhook_identifier = ${webhookIdentifier} THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
      LIMIT 1
      FOR UPDATE
    )
    UPDATE ticket_transition_intents AS intent
    SET
      consumed_at = coalesce(intent.consumed_at, now()),
      webhook_identifier = coalesce(intent.webhook_identifier, ${webhookIdentifier}),
      provider_finished_at = CASE
        WHEN intent.provider_started_at IS NOT NULL
          THEN coalesce(intent.provider_finished_at, now())
        ELSE intent.provider_finished_at
      END,
      expires_at = greatest(intent.expires_at, ${evidenceExpiresAt})
    FROM candidate
    WHERE intent.id = candidate.id
      AND (
        (intent.consumed_at IS NULL AND intent.webhook_identifier IS NULL)
        OR intent.webhook_identifier = ${webhookIdentifier}
      )
    RETURNING intent.id
  `);
  return rawRows<{ id: number }>(result).length > 0;
}

export async function discardTicketTransitionIntent(
  db: Db,
  intentId: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    DELETE FROM ticket_transition_intents
    WHERE id = ${intentId}
    RETURNING id
  `);
  return rawRows<{ id: number }>(result).length > 0;
}

async function deleteExpiredIntents(db: Db): Promise<void> {
  await db.execute(sql`
    DELETE FROM ticket_transition_intents AS stale
    WHERE stale.expires_at <= now()
      -- An expired retention timestamp never settles a started ambiguous call:
      -- it fences its exact active owner until positive completion proof.
      -- Finished calls additionally survive while cancellation may still need
      -- their destination evidence; ordinary finished evidence is renewed when
      -- it is recorded and therefore survives owner release independently.
      AND NOT EXISTS (
          SELECT 1 FROM active_runs AS active
          WHERE active.subject_key = stale.subject_key
            AND active.owner_token = stale.owner_token
            AND stale.provider_started_at IS NOT NULL
            AND (
              stale.provider_finished_at IS NULL
              OR active.state = 'cancelling'
            )
            AND (
              active.run_id = stale.run_id
              OR (active.run_id IS NULL AND stale.run_id IS NULL)
            )
      )
  `);
}

async function deleteExpiredCancellationFences(db: Db): Promise<void> {
  await db.execute(sql`
    DELETE FROM ticket_cancellation_fences AS stale
    WHERE stale.expires_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM active_runs AS active
        WHERE active.subject_key = stale.subject_key
          AND active.owner_token = stale.owner_token
          AND active.state = 'cancelling'
          AND (
            active.run_id = stale.run_id
            OR (active.run_id IS NULL AND stale.run_id IS NULL)
          )
      )
  `);
}

function normalizeTarget(target: IssueTrackerMoveTarget): {
  name: string;
  statusId: string | null;
} {
  if (typeof target === "string") return { name: target, statusId: null };
  return { name: target.name, statusId: target.statusId ?? null };
}

function denormalizeTarget(
  name: string,
  statusId: string | null,
): IssueTrackerMoveTarget {
  return statusId === null ? name : { name, statusId };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
