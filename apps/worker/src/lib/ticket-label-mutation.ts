import { sql } from "drizzle-orm";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type TicketContent,
} from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { ActiveRunOwnerError } from "./run-control-errors.js";
import type { TicketTransitionOwner } from "./ticket-transition.js";

const DEFAULT_INTENT_TTL_MS = 2 * 60 * 60 * 1000;

export type TicketLabelMutationOwnerState =
  | "reserved"
  | "bound"
  | "parked"
  | "cancelling";

export interface TicketLabelChanges {
  add?: string[];
  remove?: string[];
}

interface UnfinishedTicketLabelMutation {
  id: number;
  addLabels: string[];
  removeLabels: string[];
}

export interface TicketLabelMutationSettlementResult {
  settled: boolean;
  settledIntentIds: number[];
  pendingIntentIds: number[];
}

/**
 * Applies one idempotent label delta behind an exact owner/provider boundary.
 * The owner state is explicit so pre-start writes can require `reserved`, live
 * workflow writes can require `bound`, clarification recovery can require
 * `parked`, and cancellation cleanup can require `cancelling`; none can borrow
 * another phase's claim or race a cancellation, handoff, or release.
 */
export async function updateTicketLabelsWithIntent(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  owner: TicketTransitionOwner;
  requiredOwnerState: TicketLabelMutationOwnerState;
  changes: TicketLabelChanges;
  ttlMs?: number;
}): Promise<void> {
  if (typeof input.issueTracker.updateLabels !== "function") {
    throw new Error("Issue tracker does not support label mutations.");
  }
  const changes = normalizeChanges(input.changes);
  if (changes.add.length === 0 && changes.remove.length === 0) return;

  const settlement = await reconcileUnfinishedTicketLabelMutations({
    db: input.db,
    issueTracker: input.issueTracker,
    ticketKey: input.ticketKey,
    owner: input.owner,
  });
  if (!settlement.settled) {
    throw new Error("Ticket label mutation is still in flight.");
  }

  const current = await input.issueTracker.fetchTicket(input.ticketKey);
  if (ticketMatchesLabelChanges(current, changes)) {
    await assertTicketLabelMutationOwner(input.db, {
      owner: input.owner,
      requiredOwnerState: input.requiredOwnerState,
    });
    return;
  }

  const intentId = await recordStartedTicketLabelMutationIntent(input.db, {
    ticketKey: input.ticketKey,
    owner: input.owner,
    requiredOwnerState: input.requiredOwnerState,
    changes,
    ttlMs: input.ttlMs,
  });

  // The initial provider read precedes the owner-row lock. Re-read after the
  // durable start so a concurrent idempotent writer does not cause a duplicate
  // provider call while this caller waited for the exact owner.
  const afterFence = await input.issueTracker.fetchTicket(input.ticketKey);
  if (ticketMatchesLabelChanges(afterFence, changes)) {
    await confirmLabelIntentFinished(input.db, intentId);
    return;
  }

  try {
    await input.issueTracker.updateLabels(input.ticketKey, {
      ...(changes.add.length > 0 ? { add: changes.add } : {}),
      ...(changes.remove.length > 0 ? { remove: changes.remove } : {}),
    });
  } catch (error) {
    try {
      const afterError = await input.issueTracker.fetchTicket(input.ticketKey);
      if (ticketMatchesLabelChanges(afterError, changes)) {
        await confirmLabelIntentFinished(input.db, intentId);
        return;
      }
    } catch {
      // Keep the started provider boundary unresolved. A retry requires
      // positive live-state proof before this owner can re-drive or release.
    }
    throw error;
  }
  await confirmLabelIntentFinished(input.db, intentId);
}

/** Settles ambiguous label calls only from positive live-state proof (including
 * the ticket no longer existing). A deadline is not negative provider proof;
 * callers must retain the exact owner while this returns pending. */
export async function reconcileUnfinishedTicketLabelMutations(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  owner: TicketTransitionOwner;
  /** Retained for reconciliation call compatibility; elapsed time is not proof. */
  now?: Date;
}): Promise<TicketLabelMutationSettlementResult> {
  const intents = await listUnfinishedTicketLabelMutations(
    input.db,
    input.ticketKey,
    input.owner,
  );
  if (intents.length === 0) {
    return { settled: true, settledIntentIds: [], pendingIntentIds: [] };
  }

  let liveTicket: TicketContent;
  try {
    liveTicket = await input.issueTracker.fetchTicket(input.ticketKey);
  } catch (error) {
    if (
      !(error instanceof IssueTrackerNotFoundError) &&
      getErrorCode(error) !== "NOT_FOUND"
    ) {
      throw error;
    }
    const settledIntentIds: number[] = [];
    for (const intent of intents) {
      await confirmLabelIntentFinished(input.db, intent.id);
      settledIntentIds.push(intent.id);
    }
    return { settled: true, settledIntentIds, pendingIntentIds: [] };
  }

  const settledIntentIds: number[] = [];
  const pendingIntentIds: number[] = [];
  for (const intent of intents) {
    const observed = ticketMatchesLabelChanges(liveTicket, {
      add: intent.addLabels,
      remove: intent.removeLabels,
    });
    if (!observed) {
      pendingIntentIds.push(intent.id);
      continue;
    }
    await confirmLabelIntentFinished(input.db, intent.id);
    settledIntentIds.push(intent.id);
  }
  return {
    settled: pendingIntentIds.length === 0,
    settledIntentIds,
    pendingIntentIds,
  };
}

async function recordStartedTicketLabelMutationIntent(
  db: Db,
  input: {
    ticketKey: string;
    owner: TicketTransitionOwner;
    requiredOwnerState: TicketLabelMutationOwnerState;
    changes: { add: string[]; remove: string[] };
    ttlMs?: number;
  },
): Promise<number> {
  await deleteExpiredTicketLabelMutationIntents(db);
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_INTENT_TTL_MS));
  const addLabels = textArray(input.changes.add);
  const removeLabels = textArray(input.changes.remove);
  const result = await db.execute(sql`
    WITH exact_owner AS MATERIALIZED (
      ${exactTicketLabelMutationOwner(input.owner, input.requiredOwnerState)}
    ), started_intent AS (
      INSERT INTO ticket_label_mutation_intents (
        ticket_key,
        subject_key,
        owner_token,
        run_id,
        add_labels,
        remove_labels,
        provider_started_at,
        expires_at
      )
      SELECT
        ${input.ticketKey},
        owner.subject_key,
        owner.owner_token,
        owner.run_id,
        ${addLabels},
        ${removeLabels},
        now(),
        ${expiresAt}
      FROM exact_owner AS owner
      RETURNING id
    )
    SELECT id FROM started_intent
  `);
  const row = rawRows<{ id: number }>(result)[0];
  if (!row) {
    throw new ActiveRunOwnerError(
      `Cannot start ticket label mutation without the exact ${input.requiredOwnerState} owner.`,
    );
  }
  return row.id;
}

async function assertTicketLabelMutationOwner(
  db: Db,
  input: {
    owner: TicketTransitionOwner;
    requiredOwnerState: TicketLabelMutationOwnerState;
  },
): Promise<void> {
  const result = await db.execute(sql`
    WITH exact_owner AS MATERIALIZED (
      ${exactTicketLabelMutationOwner(input.owner, input.requiredOwnerState)}
    )
    SELECT count(*)::integer AS owner_count FROM exact_owner
  `);
  const ownerCount = Number(
    rawRows<{ owner_count: number | string }>(result)[0]?.owner_count ?? 0,
  );
  if (ownerCount !== 1) {
    throw new ActiveRunOwnerError(
      `Cannot confirm ticket label state without the exact ${input.requiredOwnerState} owner.`,
    );
  }
}

function exactTicketLabelMutationOwner(
  owner: TicketTransitionOwner,
  requiredOwnerState: TicketLabelMutationOwnerState,
) {
  return sql`
    SELECT active.subject_key, active.owner_token, active.run_id
    FROM active_runs AS active
    WHERE active.subject_key = ${owner.subjectKey}
      AND active.owner_token = ${owner.ownerToken}
      AND active.state = ${requiredOwnerState}
      AND ${owner.runId === null ? sql`active.run_id IS NULL` : sql`active.run_id = ${owner.runId}`}
      AND active.ticket_provider_calls_in_flight = 0
      AND NOT EXISTS (
        SELECT 1
        FROM ticket_transition_intents AS transition
        WHERE transition.subject_key = active.subject_key
          AND transition.owner_token = active.owner_token
          AND transition.run_id IS NOT DISTINCT FROM active.run_id
          AND transition.provider_started_at IS NOT NULL
          AND transition.provider_finished_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ticket_label_mutation_intents AS label_intent
        WHERE label_intent.subject_key = active.subject_key
          AND label_intent.owner_token = active.owner_token
          AND label_intent.run_id IS NOT DISTINCT FROM active.run_id
          AND label_intent.provider_started_at IS NOT NULL
          AND label_intent.provider_finished_at IS NULL
      )
    FOR UPDATE
  `;
}

async function listUnfinishedTicketLabelMutations(
  db: Db,
  ticketKey: string,
  owner: TicketTransitionOwner,
): Promise<UnfinishedTicketLabelMutation[]> {
  const result = await db.execute(sql`
    SELECT
      id,
      add_labels AS "addLabels",
      remove_labels AS "removeLabels"
    FROM ticket_label_mutation_intents
    WHERE ticket_key = ${ticketKey}
      AND subject_key = ${owner.subjectKey}
      AND owner_token = ${owner.ownerToken}
      AND ${owner.runId === null ? sql`run_id IS NULL` : sql`run_id = ${owner.runId}`}
      AND provider_started_at IS NOT NULL
      AND provider_finished_at IS NULL
    ORDER BY provider_started_at ASC, id ASC
  `);
  return rawRows<{
    id: number;
    addLabels: string[];
    removeLabels: string[];
  }>(result);
}

async function confirmLabelIntentFinished(db: Db, intentId: number): Promise<void> {
  const result = await db.execute(sql`
    UPDATE ticket_label_mutation_intents
    SET provider_finished_at = coalesce(provider_finished_at, now())
    WHERE id = ${intentId}
      AND provider_started_at IS NOT NULL
    RETURNING id
  `);
  if (rawRows<{ id: number }>(result).length === 0) {
    throw new Error("Ticket label provider completion could not be recorded.");
  }
}

async function deleteExpiredTicketLabelMutationIntents(db: Db): Promise<void> {
  await db.execute(sql`
    DELETE FROM ticket_label_mutation_intents AS stale
    WHERE stale.expires_at <= now()
      AND NOT (
        stale.provider_finished_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM active_runs AS active
          WHERE active.subject_key = stale.subject_key
            AND active.owner_token = stale.owner_token
            AND active.run_id IS NOT DISTINCT FROM stale.run_id
        )
      )
  `);
}

function normalizeChanges(changes: TicketLabelChanges): {
  add: string[];
  remove: string[];
} {
  const add = uniqueLabels(changes.add ?? []);
  const remove = uniqueLabels(changes.remove ?? []);
  const overlap = add.find((label) => remove.includes(label));
  if (overlap) {
    throw new Error(`Ticket label ${overlap} cannot be added and removed together.`);
  }
  return { add, remove };
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
}

function textArray(values: string[]) {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

function ticketMatchesLabelChanges(
  ticket: Pick<TicketContent, "labels">,
  changes: { add: string[]; remove: string[] },
): boolean {
  const labels = new Set(ticket.labels);
  return (
    changes.add.every((label) => labels.has(label)) &&
    changes.remove.every((label) => !labels.has(label))
  );
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
