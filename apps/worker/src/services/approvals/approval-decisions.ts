/**
 * What an operator's decision on a filed plan means.
 *
 * The store below takes a connection and answers about rows; this decides what
 * approving or rejecting one does, in the order that keeps a decision and a run
 * from getting out of step: the ticket must still exist, the claim must protect
 * the compare-and-set, and the run that filed the plan must stop waiting either
 * way. The refusals are returned as outcomes, so the transport chooses the
 * status code and this file never says 409.
 */
import type { ApprovalRequest, SettingsSnapshot } from "@shared/contracts";
import { IssueTrackerNotFoundError } from "../../adapters/issue-tracker/types.js";
import {
  ApprovalStoreError,
  decideConnectedApproval,
  getConnectedApproval,
  listConnectedApprovals,
  rejectConnectedUndispatchableApproval,
  serializeApproval,
} from "../../db/repositories/approvals.js";
import { getConnectedDashboardUserLabel } from "../../db/repositories/auth.js";
import { resolveConnectedAwaitingRun } from "../../db/repositories/runs/telemetry.js";
import { maxConcurrentAgents } from "../settings/index.js";
import { createAdapters } from "../../engine/support/adapters.js";
import { dispatchPlanApproved } from "./dispatch.js";

/**
 * The store's own refusal, re-declared here so the transport can map it to its
 * status code without importing past the service tier.
 */
export { ApprovalStoreError };

/** Everything a decision can answer that is not the decided approval itself. */
export type ApprovalDecisionOutcome =
  | { kind: "unknown_approval" }
  | { kind: "already_decided" }
  | { kind: "ticket_gone" }
  | { kind: "definition_gone" }
  | { kind: "run_in_flight" }
  | { kind: "decided"; approval: ApprovalRequest; runId: string | null };

/**
 * Thrown by the claim-protected gate below and caught at the boundary of this
 * file: losing the compare-and-set is an outcome of the request, not a fault.
 */
class ApprovalAlreadyDecidedError extends Error {}

/** The approvals list: pending only, or every decision ever made. */
export async function listDashboardApprovals(status: "all" | "pending"): Promise<ApprovalRequest[]> {
  return (await listConnectedApprovals({ status })).map(serializeApproval);
}

export async function approveApproval(
  id: string,
  actor: { userId: string },
  settings: SettingsSnapshot,
): Promise<ApprovalDecisionOutcome> {
  const row = await getConnectedApproval(id);
  if (!row) return { kind: "unknown_approval" };
  // A dispatch that failed after the approve CAS leaves the row approved with
  // no dispatched run. Such a row is retryable: the decision stands, only the
  // run start is redone, so the CAS is replaced by a verify on retry.
  const isDispatchRetry = row.status === "approved" && row.dispatchedRunId === null;
  if (row.status !== "pending" && !isDispatchRetry) {
    return { kind: "already_decided" };
  }

  const label = await getConnectedDashboardUserLabel(actor.userId);
  const decider = { id: actor.userId, label };
  const approver = isDispatchRetry
    ? { id: row.decidedById ?? actor.userId, label: row.decidedByLabel ?? label }
    : decider;
  const adapters = createAdapters();

  // Cheap existence check before reserving anything: a deleted ticket can
  // never run, so auto-reject and tell the caller it is gone.
  try {
    await adapters.issueTracker.fetchTicket(row.ticketKey);
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError) {
      // Before the decision wins, a gone ticket makes the request
      // undispatchable. Once approved, however, the human decision is final:
      // retain it as a protected operational failure instead of silently
      // replacing the pinned path with generic ticket discovery.
      if (!isDispatchRetry) await rejectConnectedUndispatchableApproval(id);
      return { kind: "ticket_gone" };
    }
    throw err;
  }

  // Safe ordering: dispatch claims the ticket first, then runs the CAS approve
  // via onClaimed, then starts the run. A lost CAS throws inside onClaimed,
  // which releases the claim, so an already-decided plan never starts a run.
  // On a dispatch retry the row is already approved; instead of the CAS,
  // onClaimed re-verifies it is still approved-without-run under the claim,
  // so a concurrently dispatched run can never be doubled.
  let result;
  try {
    result = await dispatchPlanApproved({
      runRegistry: adapters.runRegistry,
      issueTracker: adapters.issueTracker,
      approval: row,
      actor: approver,
      maxConcurrentAgents: maxConcurrentAgents(settings),
      settings,
      onClaimed: isDispatchRetry
        ? async () => {
            const fresh = await getConnectedApproval(id);
            if (!fresh || fresh.status !== "approved" || fresh.dispatchedRunId !== null) {
              throw new ApprovalAlreadyDecidedError();
            }
          }
        : async () => {
            await decideConnectedApproval({ id, decision: "approved", actor: decider });
          },
    });
  } catch (err) {
    if (err instanceof ApprovalAlreadyDecidedError) return { kind: "already_decided" };
    throw err;
  }

  if (result.status === "definition_gone") {
    // A pending request that cannot resolve its version never completed the
    // approve CAS and may be retired. An already-approved plan is final and
    // remains protected for operator repair/recovery.
    if (!isDispatchRetry) await rejectConnectedUndispatchableApproval(id);
    return { kind: "definition_gone" };
  }
  if (result.status === "run_in_flight") {
    return { kind: "run_in_flight" };
  }

  // The run that filed the plan parked itself as "awaiting" and has already
  // returned, so the decision is the only thing that can end its wait: a new
  // run implements the plan, it never resumes. Same helper and same
  // best-effort handling as the clarification path (clarifications/
  // answer-core.ts), and the helper is a no-op unless the row is awaiting.
  await resolveConnectedAwaitingRun(row.runId).catch(() => {});

  await adapters.issueTracker
    .postComment(row.ticketKey, `Plan approved by ${approver.label}, implementation started.`)
    .catch(() => {});

  const final = await getConnectedApproval(id);
  return { kind: "decided", approval: serializeApproval(final ?? row), runId: result.runId };
}

/** Rejecting decides the row outright: it never dispatches, so it can only
 *  answer about the row it found. */
export async function rejectApproval(
  id: string,
  actor: { userId: string },
): Promise<
  Extract<ApprovalDecisionOutcome, { kind: "unknown_approval" | "already_decided" | "decided" }>
> {
  const row = await getConnectedApproval(id);
  if (!row) return { kind: "unknown_approval" };
  if (row.status !== "pending") return { kind: "already_decided" };

  const label = await getConnectedDashboardUserLabel(actor.userId);
  const decided = await decideConnectedApproval({
    id,
    decision: "rejected",
    actor: { id: actor.userId, label },
  });

  // A rejected plan ends the wait just as an approved one does: the run that
  // filed it parked itself as "awaiting" and has already returned, so nothing
  // else will ever settle it. Same helper and same best-effort handling as
  // the clarification path (clarifications/answer-core.ts).
  await resolveConnectedAwaitingRun(row.runId).catch(() => {});

  const { issueTracker } = createAdapters();
  await issueTracker.postComment(row.ticketKey, `Plan rejected by ${label}.`).catch(() => {});

  return { kind: "decided", approval: serializeApproval(decided), runId: null };
}
