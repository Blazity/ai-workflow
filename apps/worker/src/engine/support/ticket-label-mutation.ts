import type { IssueTrackerAdapter, TicketContent } from "../../adapters/issue-tracker/types.js";

// Label mutation shares the engine's run-ownership guard and transition port.
import type { Db } from "../../db/types.js";
import { assertActiveRunOwnerState } from "../../db/repositories/active-runs.js";
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
    // oxlint-disable-next-line unicorn/prefer-type-error -- Error is the established exported API contract.
    throw new Error("Issue tracker does not support label mutations.");
  }
  const changes = normalizeChanges(input.changes);
  if (changes.add.length === 0 && changes.remove.length === 0) return;

  const current = await input.issueTracker.fetchTicket(input.ticketKey);
  if (ticketMatchesLabelChanges(current, changes)) {
    await assertActiveRunOwnerState(input.owner, input.requiredOwnerState, input.db);
    return;
  }

  await assertActiveRunOwnerState(input.owner, input.requiredOwnerState, input.db);
  try {
    await input.issueTracker.updateLabels(input.ticketKey, {
      ...(changes.add.length > 0 ? { add: changes.add } : {}),
      ...(changes.remove.length > 0 ? { remove: changes.remove } : {}),
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

export async function updateConnectedTicketLabelsForRun(
  input: Omit<Parameters<typeof updateTicketLabelsForRun>[0], "db">,
): Promise<void> {
  if (typeof input.issueTracker.updateLabels !== "function") {
    // oxlint-disable-next-line unicorn/prefer-type-error -- Error is the established exported API contract.
    throw new Error("Issue tracker does not support label mutations.");
  }
  const changes = normalizeChanges(input.changes);
  if (changes.add.length === 0 && changes.remove.length === 0) return;

  const current = await input.issueTracker.fetchTicket(input.ticketKey);
  if (ticketMatchesLabelChanges(current, changes)) {
    await assertActiveRunOwnerState(input.owner, input.requiredOwnerState);
    return;
  }

  await assertActiveRunOwnerState(input.owner, input.requiredOwnerState);
  try {
    await input.issueTracker.updateLabels(input.ticketKey, {
      ...(changes.add.length > 0 ? { add: changes.add } : {}),
      ...(changes.remove.length > 0 ? { remove: changes.remove } : {}),
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
