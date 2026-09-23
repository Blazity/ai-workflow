/**
 * A run stopped because a person moved its ticket out of the trigger column.
 *
 * That is not a failure, and every surface has to say so the same way: the
 * recorded reason on the run, runs.diagnose, and the ticket itself. On
 * production run wrun_01M375BB1PC0CG3F8KR0DGEWJ6 (AWP-280, 2026-09-23) the run
 * was stopped within three seconds, and the diagnosis still answered "unknown"
 * and the ticket said nothing at all, because each surface would have had to
 * recognise a sentence written somewhere else. The sentences live here, and the
 * two paths that write them and the diagnosis that reads them all import them.
 *
 * Pure text: no clock, no database, no tracker. The callers bring the moment
 * and the column names.
 */

/** Opening of the reason the ticket webhook records. The rest of the sentence
 *  carries the tracker's column names, which are not ours to trust. */
const WEBHOOK_REASON_PREFIX = "Ticket left the AI column (";

/** The reason the reconciler records when the poll finds the same move. */
export const POLL_LEFT_COLUMN_REASON =
  "Orphaned run cancelled by reconciler: ticket no longer in the AI column";

/** The reason recorded when a tracker webhook reports the move. */
export function webhookLeftColumnReason(input: {
  aiColumn: string;
  movedTo: string | null;
  trackerName: string;
}): string {
  return `${WEBHOOK_REASON_PREFIX}${input.aiColumn} → ${input.movedTo ?? "unknown"}) via ${input.trackerName} webhook`;
}

/** True for a recorded reason that says the ticket left the trigger column,
 *  whichever of the two paths noticed. */
export function isLeftColumnReason(reason: string): boolean {
  return reason.startsWith(WEBHOOK_REASON_PREFIX) || reason.startsWith(POLL_LEFT_COLUMN_REASON);
}

/**
 * Line the stop comment carries verbatim, so a tracker that can search its own
 * comments (findCommentByMarker) recognises one this deployment already posted
 * and does not post a second. Per run: the next run on the ticket that is
 * stopped the same way has its own stop to explain.
 */
export function runStoppedCommentMarker(runId: string): string {
  return `AI workflow run stopped: ${runId}`;
}

/** "2026-09-23 12:56 UTC": the minute is what a person reading the ticket
 *  matches against their own memory of moving it. */
function utcMinute(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The one comment a ticket gets when a person stopped its run by moving it.
 *
 * Short on purpose: the person who moved the ticket knows they did, and a
 * colleague reading the ticket later needs three facts: the run stopped, why,
 * and how to start again. It says the stop was not a failure because the only
 * other comment the run left said it had picked the ticket up.
 */
export function formatRunStoppedComment(input: {
  runId: string;
  aiColumnName: string;
  movedTo: string | null;
  stoppedAt: Date;
}): string {
  // A ticket moved to another project can keep a status of the same name, and
  // "moved from Ai to Ai" would read as nonsense, so that says only "out of".
  const movedTo = input.movedTo?.trim() || null;
  const where =
    movedTo && movedTo.toLowerCase() !== input.aiColumnName.trim().toLowerCase()
      ? `moved from "${input.aiColumnName}" to "${movedTo}"`
      : `moved out of "${input.aiColumnName}"`;
  return [
    `The AI workflow stopped working on this ticket at ${utcMinute(input.stoppedAt)} because the ticket was ${where}. Nothing failed.`,
    `To start again, move the ticket back to "${input.aiColumnName}"; a new run starts from the beginning.`,
    runStoppedCommentMarker(input.runId),
  ].join("\n\n");
}
