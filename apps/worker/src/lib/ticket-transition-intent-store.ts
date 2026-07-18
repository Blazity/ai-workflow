import { sql } from "drizzle-orm";
import type { IssueTrackerMoveTarget } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";

// Jira retries failed webhook deliveries up to five times with 5–15 minute
// backoff. Keep the consumed intent beyond that complete retry window so a
// delayed retry cannot be mistaken for a human transition.
const DEFAULT_INTENT_TTL_MS = 2 * 60 * 60 * 1000;

interface RecordIntentInput {
  ticketKey: string;
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
  actorAccountId: string;
  target: IssueTrackerMoveTarget;
  ttlMs?: number;
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
  const result = await db.execute(sql`
    WITH expired AS (
      DELETE FROM ticket_transition_intents
      WHERE expires_at <= now()
    ), candidate AS (
      SELECT id
      FROM ticket_transition_intents
      WHERE ticket_key = ${ticketKey}
        AND actor_account_id = ${actorAccountId}
        AND expires_at > now()
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
      webhook_identifier = coalesce(intent.webhook_identifier, ${webhookIdentifier})
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
  await db.execute(sql`DELETE FROM ticket_transition_intents WHERE expires_at <= now()`);
}

function normalizeTarget(target: IssueTrackerMoveTarget): {
  name: string;
  statusId: string | null;
} {
  if (typeof target === "string") return { name: target, statusId: null };
  return { name: target.name, statusId: target.statusId ?? null };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
