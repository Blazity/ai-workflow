import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { dispatchCapacityQueue } from "../db/schema.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import { logger } from "../lib/logger.js";

/** Jira calls made per poll tick. Caps CONFIRMED comments, never row creation. */
export const AT_CAPACITY_COMMENT_BOUND = 10;

/** Hard cap on a single at-capacity comment POST. Must stay well under the
 *  claim lease so an aborted call cannot outlive its claim and let an
 *  overlapping tick re-post. */
export const COMMENT_POST_TIMEOUT_MS = 30_000;

/**
 * Claim lease: how long an unconfirmed attempted_at blocks a re-attempt. It must
 * comfortably exceed COMMENT_POST_TIMEOUT_MS (a POST is aborted at that bound, so
 * a claim can never be held longer) yet be short enough that a genuinely failed
 * send is retried on a later tick. The poll cadence is one minute.
 */
export const CLAIM_LEASE_MS = 120_000;

export interface QueuedTicket {
  ticketKey: string;
  /** ISO-8601 first-seen timestamp — how long the ticket has been waiting. */
  queuedAt: string;
}

/** Insert a suppressing row for a refused ticket. No-op if one already exists. */
export async function ensureQueued(db: Db, ticketKey: string): Promise<void> {
  await db
    .insert(dispatchCapacityQueue)
    .values({ ticketKey })
    .onConflictDoNothing();
}

/** Drop queue rows for tickets whose episode ended (they dispatched). */
export async function deleteQueued(
  db: Db,
  ticketKeys: readonly string[],
): Promise<number> {
  if (ticketKeys.length === 0) return 0;
  const deleted = await db
    .delete(dispatchCapacityQueue)
    .where(inArray(dispatchCapacityQueue.ticketKey, [...ticketKeys]))
    .returning({ ticketKey: dispatchCapacityQueue.ticketKey });
  return deleted.length;
}

/**
 * Delete queue rows for tickets no longer in the AI column. The poll's JQL only
 * returns tickets currently in the column, so a queued ticket absent from a
 * NON-EMPTY listing was moved out by a human without starting — its episode is
 * over. An EMPTY listing is treated as UNKNOWN (index lag is indistinguishable
 * from a genuinely empty column), so the caller must skip this entirely rather
 * than delete the whole queue and re-comment everything next tick.
 */
export async function reconcileQueue(
  db: Db,
  currentTicketKeys: readonly string[],
): Promise<number> {
  if (currentTicketKeys.length === 0) return 0;
  const deleted = await db
    .delete(dispatchCapacityQueue)
    .where(notInArray(dispatchCapacityQueue.ticketKey, [...currentTicketKeys]))
    .returning({ ticketKey: dispatchCapacityQueue.ticketKey });
  return deleted.length;
}

/**
 * Currently-queued tickets that have never had a confirmed comment, oldest
 * first, capped at `limit` to bound the Jira calls this tick.
 */
export async function listUnconfirmedForComment(
  db: Db,
  ticketKeys: readonly string[],
  limit: number,
): Promise<string[]> {
  if (ticketKeys.length === 0) return [];
  const rows = await db
    .select({ ticketKey: dispatchCapacityQueue.ticketKey })
    .from(dispatchCapacityQueue)
    .where(
      and(
        isNull(dispatchCapacityQueue.confirmedAt),
        inArray(dispatchCapacityQueue.ticketKey, [...ticketKeys]),
      ),
    )
    .orderBy(asc(dispatchCapacityQueue.queuedAt))
    .limit(limit);
  return rows.map((r) => r.ticketKey);
}

/**
 * Atomically claim a ticket for a comment by stamping attempted_at, but only
 * when it is still unconfirmed and its prior attempt (if any) is older than the
 * lease. Two overlapping ticks serialize on the row: the loser re-evaluates the
 * WHERE against the winner's fresh attempted_at and claims nothing. Returns true
 * when this caller won the claim and must send the comment.
 */
export async function claimForComment(
  db: Db,
  ticketKey: string,
  leaseMs: number,
): Promise<boolean> {
  const claimed = await db
    .update(dispatchCapacityQueue)
    .set({ attemptedAt: sql`now()` })
    .where(
      and(
        eq(dispatchCapacityQueue.ticketKey, ticketKey),
        isNull(dispatchCapacityQueue.confirmedAt),
        or(
          isNull(dispatchCapacityQueue.attemptedAt),
          lt(
            dispatchCapacityQueue.attemptedAt,
            sql`now() - (${leaseMs} * interval '1 millisecond')`,
          ),
        ),
      ),
    )
    .returning({ ticketKey: dispatchCapacityQueue.ticketKey });
  return claimed.length > 0;
}

/** Record that a comment landed, permanently suppressing further ones. */
export async function markConfirmed(db: Db, ticketKey: string): Promise<void> {
  await db
    .update(dispatchCapacityQueue)
    .set({ confirmedAt: sql`now()` })
    .where(eq(dispatchCapacityQueue.ticketKey, ticketKey));
}

/** Every queued ticket, oldest first, for the dashboard "waiting" panel. */
export async function listQueued(db: Db): Promise<QueuedTicket[]> {
  const rows = await db
    .select({
      ticketKey: dispatchCapacityQueue.ticketKey,
      queuedAt: dispatchCapacityQueue.queuedAt,
    })
    .from(dispatchCapacityQueue)
    .orderBy(asc(dispatchCapacityQueue.queuedAt));
  return rows.map((r) => ({
    ticketKey: r.ticketKey,
    queuedAt: r.queuedAt.toISOString(),
  }));
}

/** The at-capacity comment body posted to the ticket. Deliberately makes no
 *  promise that the ticket WILL start (capacity is checked before the
 *  eligibility guards, so a ticket may still be refused for another reason) and
 *  carries no exact in-use count (which could contradict "every slot"). */
export function atCapacityComment(): string {
  return (
    "This ticket is waiting for a free workflow execution slot: every slot is " +
    "currently in use. It will be retried automatically on the next dispatch cycle."
  );
}

export interface ReconcileAtCapacityQueueInput {
  db: Db;
  issueTracker: Pick<IssueTrackerAdapter, "postComment">;
  /** Tickets refused with reason `at_capacity` this tick. */
  atCapacityKeys: readonly string[];
  /** Tickets that dispatched this tick — their episode ended, drop their rows. */
  startedKeys: readonly string[];
  /** Every ticket currently in the AI column. Empty = UNKNOWN listing → the
   *  reconcile-delete is skipped (never delete the whole queue). */
  currentTicketKeys: readonly string[];
  /** Max CONFIRMED comments this tick. */
  bound?: number;
  claimLeaseMs?: number;
}

export interface ReconcileAtCapacityQueueResult {
  queued: number;
  commented: number;
}

/**
 * Per-tick at-capacity commenter. Guarantees at-least-once, effectively-once
 * commenting per episode: it drops rows for tickets that dispatched, ensures a
 * suppressing row for each refused ticket, reconciles away rows for tickets a
 * human moved out of the column, then sends at most `bound` comments — claiming
 * each via the attempted_at lease and only marking confirmed_at after the Jira
 * call actually succeeds, so a failed send is retried rather than suppressed.
 *
 * (The one residual gap: if the Jira POST lands but the markConfirmed write is
 * lost, a later tick re-posts once. Jira-side idempotency is out of scope.)
 */
export async function reconcileAtCapacityQueue(
  input: ReconcileAtCapacityQueueInput,
): Promise<ReconcileAtCapacityQueueResult> {
  const bound = input.bound ?? AT_CAPACITY_COMMENT_BOUND;
  const leaseMs = input.claimLeaseMs ?? CLAIM_LEASE_MS;

  // A dispatched ticket is no longer waiting: its episode ended the moment it
  // started, even though it stays in the AI column for the whole run.
  await deleteQueued(input.db, input.startedKeys);

  for (const ticketKey of input.atCapacityKeys) {
    await ensureQueued(input.db, ticketKey);
  }

  // Skip on an empty/unknown listing: deleting the whole queue there would
  // re-comment everything on the next tick.
  if (input.currentTicketKeys.length > 0) {
    await reconcileQueue(input.db, input.currentTicketKeys);
  }

  const pending = await listUnconfirmedForComment(
    input.db,
    input.currentTicketKeys,
    bound,
  );

  let commented = 0;
  for (const ticketKey of pending) {
    if (!(await claimForComment(input.db, ticketKey, leaseMs))) continue;
    try {
      await input.issueTracker.postComment(ticketKey, atCapacityComment(), {
        signal: AbortSignal.timeout(COMMENT_POST_TIMEOUT_MS),
      });
      await markConfirmed(input.db, ticketKey);
      commented++;
    } catch (error) {
      // Leave confirmed_at NULL so a later tick retries. The lease on
      // attempted_at keeps the retry from firing before it expires.
      logger.warn(
        { ticketKey, error: (error as Error).message },
        "at_capacity_comment_failed",
      );
    }
  }

  return { queued: input.atCapacityKeys.length, commented };
}
