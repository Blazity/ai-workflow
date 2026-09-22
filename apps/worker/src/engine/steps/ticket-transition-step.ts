import type { IssueTrackerMoveTarget } from "../../adapters/issue-tracker/types.js";
import { resolveSettingsSnapshot } from "@shared/contracts";
import type { TicketTransitionOwner } from "../support/ticket-transition.js";

/**
 * The move a plain column name means on THIS deployment's board.
 *
 * A run carries its board with it: the column names come from its settings
 * snapshot and the transition ids from the tracker wiring recorded at its
 * start. A run suspended before S12 recorded no wiring at all, so it replays
 * with every transition id absent, and a plain column name is what reaches
 * this step. On a board that localizes its transition names, moving by name
 * finds nothing and the ticket is stranded at the end of an otherwise
 * successful run.
 *
 * So a bare name is completed here, in the worker, where the connection can be
 * read. Three rules keep that from doing harm:
 *
 * - A target that already carries an id is never touched. That id is what its
 *   own run froze, and this deployment does not get to overrule it.
 * - The name must match EXACTLY ONE column. An operator who renames the AI
 *   column to what the review column used to be called makes "AI Review" match
 *   two, and picking the first would hand a finished run the AI transition and
 *   put its ticket back where the poller starts a new run on work that is
 *   already done. Ambiguous means "leave it as a name", which is what every
 *   such run did before this existed.
 * - A read that fails leaves the target alone. The move this completes is
 *   usually the last thing a successful run does, and losing it to a settings
 *   blip is the most expensive moment to fail.
 *
 * Names are compared trimmed and case-insensitively, which is how the
 * reconciler compares the same values (`run-lifecycle/reconcile.ts`).
 */
type BoardSlot = "backlog" | "ai" | "aiReview";

async function moveTargetOnCurrentBoard(
  ticketKey: string,
  target: IssueTrackerMoveTarget,
): Promise<IssueTrackerMoveTarget> {
  if (typeof target !== "string") return target;
  // The two halves of a board, read the way the engine may read them: the
  // columns from the settings rows, the transition ids from the tracker's
  // wiring. This does NOT go through `services/settings`, which the engine may
  // not import (ADR-001), so it composes the same two reads the run-start step
  // composes rather than a second resolution of either.
  const [{ readAllConnectedSettings }, { settingsEnvironment }, tracker, { logger }] =
    await Promise.all([
      import("../../db/repositories/settings.js"),
      import("../../infra/settings-environment.js"),
      import("../support/issue-tracker-runtime.js"),
      import("../../infra/logger.js"),
    ]);
  // Said out loud, both of them. A dropped read means the move goes by name,
  // and on a board that needs the transition the move then fails; without
  // these lines the only visible thing is the failed move, and nobody would
  // connect it to a settings or connection read that was never mentioned.
  const dropped = (which: string) => (error: unknown) => {
    logger.warn(
      { which, ticketKey, err: error instanceof Error ? error.message : String(error) },
      "ticket_move_board_read_unavailable",
    );
    return null;
  };
  const [rows, wiring] = await Promise.all([
    readAllConnectedSettings().catch(dropped("settings")),
    // A deployment with no tracker has no transition id to contribute, and the
    // move by name is what it has always done.
    tracker.issueTrackerWiring().catch(dropped("tracker_wiring")),
  ]);
  if (!rows || !wiring) return target;
  const { snapshot } = resolveSettingsSnapshot(
    new Map(rows.map((row) => [row.key, row.value])),
    settingsEnvironment,
  );
  const wanted = target.trim().toLowerCase();
  const matches: BoardSlot[] = (
    [
      ["backlog", snapshot.COLUMN_BACKLOG],
      ["ai", snapshot.COLUMN_AI],
      ["aiReview", snapshot.COLUMN_AI_REVIEW],
    ] as const
  )
    .filter(([, column]) => column.trim().toLowerCase() === wanted)
    .map(([slot]) => slot);
  if (matches.length !== 1) return target;
  const transitionId =
    matches[0] === "backlog"
      ? wiring.backlogTransitionId
      : matches[0] === "ai"
        ? wiring.aiTransitionId
        : wiring.aiReviewTransitionId;
  return transitionId ? { name: target, transitionId } : target;
}

export async function moveTicketStep(
  ticketKey: string,
  target: IssueTrackerMoveTarget,
  owner: TicketTransitionOwner,
): Promise<void> {
  "use step";
  const { createAdapters } = await import("../../engine/support/adapters.js");
  const { moveConnectedTicketForRun } = await import("../../engine/support/ticket-transition.js");
  await moveConnectedTicketForRun({
    issueTracker: (await createAdapters()).issueTracker,
    ticketKey,
    target: await moveTargetOnCurrentBoard(ticketKey, target),
    owner,
  });
}
