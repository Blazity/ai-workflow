import { createError, defineEventHandler, getRouterParam } from "h3";
import type { ApprovalDecisionResponse } from "@shared/contracts";
import { env } from "../../../../../../env.js";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor } from "../../../../../lib/auth/request-context.js";
import { canApproveWorkflowPlans } from "../../../../../lib/auth/roles.js";
import { createStepAdapters } from "../../../../../lib/step-adapters.js";
import { IssueTrackerNotFoundError } from "../../../../../adapters/issue-tracker/types.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import { dispatchPlanApproved } from "../../../../../approvals/dispatch.js";
import {
  decideApproval,
  getApproval,
  rejectUndispatchableApproval,
  serializeApproval,
} from "../../../../../approvals/store.js";
import { toApprovalHttpError } from "../../approvals.get.js";

export default defineEventHandler(async (event): Promise<ApprovalDecisionResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    if (!canApproveWorkflowPlans(actor.role)) {
      throw createError({ statusCode: 403, statusMessage: "Forbidden" });
    }
    const id = getRouterParam(event, "id");
    if (!id) throw createError({ statusCode: 404, statusMessage: "Unknown approval" });

    const db = getDb();
    const row = await getApproval(db, id);
    if (!row) throw createError({ statusCode: 404, statusMessage: "Unknown approval" });
    // A dispatch that failed after the approve CAS leaves the row approved with
    // no dispatched run. Such a row is retryable: the decision stands, only the
    // run start is redone, so the CAS is replaced by a verify on retry.
    const isDispatchRetry = row.status === "approved" && row.dispatchedRunId === null;
    if (row.status !== "pending" && !isDispatchRetry) {
      throw createError({ statusCode: 409, statusMessage: "already_decided" });
    }

    const label = await dashboardUserLabel(db, actor.userId);
    const decider = { id: actor.userId, label };
    const approver = isDispatchRetry
      ? { id: row.decidedById ?? actor.userId, label: row.decidedByLabel ?? label }
      : decider;
    const adapters = createStepAdapters();

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
        if (!isDispatchRetry) await rejectUndispatchableApproval(db, id);
        throw createError({ statusCode: 410, statusMessage: "ticket_gone" });
      }
      throw err;
    }

    // Safe ordering: dispatch claims the ticket first, then runs the CAS approve
    // via onClaimed, then starts the run. A lost CAS throws inside onClaimed,
    // which releases the claim, so an already-decided plan never starts a run.
    // On a dispatch retry the row is already approved; instead of the CAS,
    // onClaimed re-verifies it is still approved-without-run under the claim,
    // so a concurrently dispatched run can never be doubled.
    const result = await dispatchPlanApproved({
      db,
      runRegistry: adapters.runRegistry,
      issueTracker: adapters.issueTracker,
      approval: row,
      actor: approver,
      maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      onClaimed: isDispatchRetry
        ? async () => {
            const fresh = await getApproval(db, id);
            if (!fresh || fresh.status !== "approved" || fresh.dispatchedRunId !== null) {
              throw createError({ statusCode: 409, statusMessage: "already_decided" });
            }
          }
        : async () => {
            await decideApproval(db, { id, decision: "approved", actor: decider });
          },
    });

    if (result.status === "definition_gone") {
      // A pending request that cannot resolve its version never completed the
      // approve CAS and may be retired. An already-approved plan is final and
      // remains protected for operator repair/recovery.
      if (!isDispatchRetry) await rejectUndispatchableApproval(db, id);
      throw createError({ statusCode: 410, statusMessage: "definition_gone" });
    }
    if (result.status === "run_in_flight") {
      throw createError({ statusCode: 409, statusMessage: "run_in_flight" });
    }

    await adapters.issueTracker
      .postComment(row.ticketKey, `Plan approved by ${approver.label}, implementation started.`)
      .catch(() => {});

    const final = await getApproval(db, id);
    return { approval: serializeApproval(final ?? row), runId: result.runId };
  } catch (error) {
    toApprovalHttpError(error);
  }
});
