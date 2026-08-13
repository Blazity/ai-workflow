import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { dispatchCapacityNotices } from "../db/schema.js";
import { logger } from "./logger.js";

/**
 * Comments posted per pass. A full pool with a long AI column would otherwise
 * mean one Jira call per queued ticket in a single minute, which is how a
 * courtesy comment turns into a rate limit incident. The rest wait for the next
 * tick; their rows already hold the queue.
 */
const MAX_NOTICES_PER_PASS = 3;

export interface QueuedDispatchRow {
  subjectKey: string;
  ticketKey: string;
  queuedSince: Date;
  notifiedAt: Date | null;
}

/**
 * Bring the queue ledger in line with what this tick actually saw.
 *
 * `liveTicketKeys` are the tickets still waiting after the dispatch pass: the AI
 * column snapshot minus whatever just started. Everything else loses its row, so
 * a ticket that queues again later counts as a fresh entry and gets told again,
 * and a ticket somebody pulled out of the column stops being advertised as queued.
 *
 * Insert-only for the refused ones, so `queued_since` keeps naming the first
 * refusal and a ticket that already has a row is never re-notified.
 *
 * `occupiedSubjectKeys` is what keeps the ledger honest, and it is not optional.
 * A refusal of `at_capacity` does not mean "this ticket is waiting for a slot":
 * reserveSubjectWithinCapacity checks the pool before it tries to claim
 * (src/lib/dispatch.ts:341), so a ticket whose run is already in flight is
 * refused for capacity too, and its own claim is part of the pool it is blamed on.
 * Observed on production 2026-08-13: AWP-76 was told it was queued 45 seconds
 * after its run started and 4 minutes before that run opened a pull request.
 * A subject that holds a claim is running or parked, never queued.
 */
export async function syncCapacityNotices(
  db: Db,
  input: {
    refused: { subjectKey: string; ticketKey: string }[];
    liveTicketKeys: string[];
    occupiedSubjectKeys: ReadonlySet<string>;
  },
): Promise<void> {
  await db
    .delete(dispatchCapacityNotices)
    .where(
      input.liveTicketKeys.length > 0
        ? notInArray(dispatchCapacityNotices.ticketKey, input.liveTicketKeys)
        : undefined,
    );
  const queued = input.refused.filter(
    (entry) => !input.occupiedSubjectKeys.has(entry.subjectKey),
  );
  if (queued.length < input.refused.length) {
    logger.info(
      {
        claimed: input.refused
          .filter((entry) => input.occupiedSubjectKeys.has(entry.subjectKey))
          .map((entry) => entry.ticketKey),
      },
      "queue_notice_skipped_already_claimed",
    );
  }
  if (queued.length === 0) return;
  await db
    .insert(dispatchCapacityNotices)
    .values(
      queued.map((entry) => ({
        subjectKey: entry.subjectKey,
        ticketKey: entry.ticketKey,
      })),
    )
    .onConflictDoNothing();
}

/** The queue, oldest wait first. */
export async function listQueuedDispatches(db: Db): Promise<QueuedDispatchRow[]> {
  return db
    .select({
      subjectKey: dispatchCapacityNotices.subjectKey,
      ticketKey: dispatchCapacityNotices.ticketKey,
      queuedSince: dispatchCapacityNotices.queuedSince,
      notifiedAt: dispatchCapacityNotices.notifiedAt,
    })
    .from(dispatchCapacityNotices)
    .orderBy(asc(dispatchCapacityNotices.queuedSince));
}

/**
 * Tell each newly queued ticket why nothing is happening, once.
 *
 * A refusal for capacity is the one refusal a person needs to hear about: it is
 * not an error, it resolves on its own, and without it a full pool looks exactly
 * like a dead cron (the dashboard's "now running" panel does not count parked
 * runs, so it can read zero while every slot is taken). The other refusal reasons
 * are races that resolve within a tick and stay in the log.
 *
 * `notified_at` is stamped before the comment is posted, so a Jira call that
 * fails halfway (or a comment that lands while the response is lost) can never
 * produce a second comment on the same wait. A person who never sees a comment is
 * a much smaller failure than a ticket the bot comments on every minute.
 */
export async function commentOnQueuedTickets(
  db: Db,
  issueTracker: Pick<IssueTrackerAdapter, "postComment">,
  input: { limit: number; occupied: number },
): Promise<number> {
  const pending = await db
    .select({
      subjectKey: dispatchCapacityNotices.subjectKey,
      ticketKey: dispatchCapacityNotices.ticketKey,
    })
    .from(dispatchCapacityNotices)
    .where(isNull(dispatchCapacityNotices.notifiedAt))
    .orderBy(asc(dispatchCapacityNotices.queuedSince))
    .limit(MAX_NOTICES_PER_PASS);

  let posted = 0;
  for (const row of pending) {
    const [claimed] = await db
      .update(dispatchCapacityNotices)
      .set({ notifiedAt: new Date() })
      .where(
        // Re-checked here, not in the read above: two overlapping invocations
        // would otherwise both find the same unnotified row.
        and(
          eq(dispatchCapacityNotices.subjectKey, row.subjectKey),
          isNull(dispatchCapacityNotices.notifiedAt),
        ),
      )
      .returning({ ticketKey: dispatchCapacityNotices.ticketKey });
    if (!claimed) continue;

    try {
      await issueTracker.postComment(
        row.ticketKey,
        formatQueuedComment({ limit: input.limit, occupied: input.occupied }),
      );
      posted++;
    } catch (error) {
      logger.warn(
        { ticketKey: row.ticketKey, error: (error as Error).message },
        "dispatch_capacity_comment_failed",
      );
    }
  }
  return posted;
}

/**
 * Plain text with blank lines between paragraphs, which is what the Jira adapter
 * turns into ADF paragraphs. Wording follows the manual dispatch refusal, so the
 * same situation reads the same way wherever a person meets it.
 */
export function formatQueuedComment(input: {
  limit: number;
  occupied: number;
}): string {
  return [
    `This ticket is queued. All workflow execution slots are currently in use (${input.occupied} of ${input.limit}), so no run has started for it yet.`,
    "It starts automatically as soon as a slot frees up, and nothing is needed from you in the meantime.",
  ].join("\n\n");
}
