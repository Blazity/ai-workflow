import { IssueTrackerNotFoundError } from "../adapters/issue-tracker/types.js";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
  TicketContent,
} from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import {
  assertActiveRunOwnerState,
  type ActiveRunOwner,
} from "./active-run-owner.js";

export type TicketTransitionOwner = ActiveRunOwner;

/**
 * Move a ticket behind an exact active-owner check. Jira webhook echoes are
 * identified by their actor account id, so this mutation does not need its own
 * database state machine.
 */
export async function moveTicketForRun(input: {
  db: Db;
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
  ticketKey: string;
  target: IssueTrackerMoveTarget;
  owner: TicketTransitionOwner;
  requiredOwnerState?: "reserved" | "bound" | "parked" | "cancelling";
}): Promise<void> {
  const state =
    input.requiredOwnerState ?? (input.owner.runId === null ? "reserved" : "bound");
  await moveTicket({
    issueTracker: input.issueTracker,
    ticketKey: input.ticketKey,
    target: input.target,
    guard: () => assertActiveRunOwnerState(input.db, input.owner, state),
  });
}

/**
 * Withdraw a ticket from the AI column while its exact run still owns the
 * subject. A manual dispatch uses the AI column only as execution state, so
 * releasing that owner while the ticket is still there would let the default
 * pickup path claim it as new work.
 *
 * Conditionally withdraw a ticket from AI while an exact run owner still holds
 * it. The live read happens inside the cancellation before-release fence, so a
 * workflow move to Review/Done is preserved and a move back to AI is safely
 * evicted before the owner is released. An ambiguous move is successful only
 * when a fresh read proves the ticket left AI; otherwise the original error is
 * propagated and cancellation retains the owner.
 */
export async function withdrawTicketFromAiForRun(input: {
  db: Db;
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
  ticketKey: string;
  aiColumn: IssueTrackerMoveTarget;
  target?: IssueTrackerMoveTarget;
  owner: TicketTransitionOwner;
  requiredOwnerState: "bound" | "cancelling";
}): Promise<void> {
  let current: TicketContent;
  try {
    current = await input.issueTracker.fetchTicket(input.ticketKey);
  } catch (error) {
    if (!isIssueTrackerNotFound(error)) throw error;
    // A deleted ticket is already outside AI. Still fence the release against
    // the exact cancelling owner; absence alone must never authorize another
    // run's claim to be released.
    await assertActiveRunOwnerState(
      input.db,
      input.owner,
      input.requiredOwnerState,
    );
    return;
  }
  await assertActiveRunOwnerState(
    input.db,
    input.owner,
    input.requiredOwnerState,
  );
  if (!ticketMatchesMoveTarget(current, input.aiColumn)) return;
  if (!input.target) {
    throw new Error("Cannot withdraw an AI ticket without a safe move target");
  }

  try {
    await input.issueTracker.moveTicket(input.ticketKey, input.target);
  } catch (error) {
    try {
      const afterError = await input.issueTracker.fetchTicket(input.ticketKey);
      if (!ticketMatchesMoveTarget(afterError, input.aiColumn)) return;
    } catch (readError) {
      if (isIssueTrackerNotFound(readError)) {
        await assertActiveRunOwnerState(
          input.db,
          input.owner,
          input.requiredOwnerState,
        );
        return;
      }
      // Preserve the original mutation error.
    }
    throw error;
  }
}

/**
 * The ownerless half of a ticket move: read where the ticket is, skip the write when it
 * is already there, and turn a provider that accepted the transition but lost its
 * response into a success with one live re-read.
 *
 * Extracted because a second caller needs exactly this and must NOT have the owner
 * check: an operator acting through MCP holds no run's owner token, and borrowing one
 * out of active_runs to satisfy the fence would be impersonating somebody else's run.
 * That caller enforces its own rule (refuse while any run owns the ticket) and passes no
 * guard. `guard` runs after the current status is read and before anything is written,
 * in both branches, which is where the fence has always been.
 */
export async function moveTicket(input: {
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
  ticketKey: string;
  target: IssueTrackerMoveTarget;
  guard?: () => Promise<void>;
}): Promise<{ statusBefore: string; alreadyAtTarget: boolean }> {
  const current = await input.issueTracker.fetchTicket(input.ticketKey);
  const statusBefore = current.trackerStatus;
  if (ticketMatchesMoveTarget(current, input.target)) {
    await input.guard?.();
    return { statusBefore, alreadyAtTarget: true };
  }

  await input.guard?.();
  try {
    await input.issueTracker.moveTicket(input.ticketKey, input.target);
  } catch (error) {
    // A provider may accept the transition and lose its response. One live
    // read is enough to turn that ambiguous transport result into success.
    try {
      const afterError = await input.issueTracker.fetchTicket(input.ticketKey);
      if (ticketMatchesMoveTarget(afterError, input.target)) {
        return { statusBefore, alreadyAtTarget: false };
      }
    } catch {
      // Preserve the original mutation error.
    }
    throw error;
  }
  return { statusBefore, alreadyAtTarget: false };
}

function isIssueTrackerNotFound(error: unknown): boolean {
  if (error instanceof IssueTrackerNotFoundError) return true;
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "NOT_FOUND";
}

export function ticketMatchesMoveTarget(
  ticket: Pick<TicketContent, "trackerStatus" | "trackerStatusId">,
  target: IssueTrackerMoveTarget,
): boolean {
  const currentName = ticket.trackerStatus.trim().toLowerCase();
  if (typeof target === "string") return currentName === target.trim().toLowerCase();
  if (target.statusId !== undefined && ticket.trackerStatusId !== undefined) {
    return ticket.trackerStatusId === target.statusId;
  }
  return currentName === target.name.trim().toLowerCase();
}
