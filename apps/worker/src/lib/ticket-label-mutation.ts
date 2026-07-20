import type { IssueTrackerAdapter, TicketContent } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { assertActiveRunOwnerState } from "./active-run-owner.js";
import type { TicketTransitionOwner } from "./ticket-transition.js";

export interface TicketLabelChanges {
  add?: string[];
  remove?: string[];
}

/** Apply an idempotent label delta after proving the exact owner and phase. */
export async function updateTicketLabelsForRun(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  owner: TicketTransitionOwner;
  requiredOwnerState: "reserved" | "bound" | "parked" | "cancelling";
  changes: TicketLabelChanges;
}): Promise<void> {
  if (typeof input.issueTracker.updateLabels !== "function") {
    throw new Error("Issue tracker does not support label mutations.");
  }
  const changes = normalizeChanges(input.changes);
  if (changes.add.length === 0 && changes.remove.length === 0) return;

  const current = await input.issueTracker.fetchTicket(input.ticketKey);
  if (ticketMatchesLabelChanges(current, changes)) {
    await assertActiveRunOwnerState(input.db, input.owner, input.requiredOwnerState);
    return;
  }

  await assertActiveRunOwnerState(input.db, input.owner, input.requiredOwnerState);
  try {
    await input.issueTracker.updateLabels(input.ticketKey, {
      ...(changes.add.length ? { add: changes.add } : {}),
      ...(changes.remove.length ? { remove: changes.remove } : {}),
    });
  } catch (error) {
    try {
      const afterError = await input.issueTracker.fetchTicket(input.ticketKey);
      if (ticketMatchesLabelChanges(afterError, changes)) return;
    } catch {
      // Preserve the original mutation error.
    }
    throw error;
  }
}

function normalizeChanges(changes: TicketLabelChanges): {
  add: string[];
  remove: string[];
} {
  const add = uniqueLabels(changes.add ?? []);
  const remove = uniqueLabels(changes.remove ?? []);
  const overlap = add.find((label) => remove.includes(label));
  if (overlap) throw new Error(`Ticket label ${overlap} cannot be added and removed together.`);
  return { add, remove };
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
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
