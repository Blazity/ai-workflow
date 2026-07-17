import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import type { ClarificationAnswerResponse } from "@shared/contracts";
import { env } from "../../../../../../env.js";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { createStepAdapters } from "../../../../../lib/step-adapters.js";
import { IssueTrackerNotFoundError } from "../../../../../adapters/issue-tracker/types.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import { dispatchClarificationAnswered } from "../../../../../clarifications/dispatch.js";
import {
  ClarificationStoreError,
  getClarification,
  serializeClarification,
  setDispatchedRunId,
  supersedeClarification,
  supersedePendingForTicket,
  type ClarificationRow,
} from "../../../../../clarifications/store.js";
import { resolveAwaitingRun } from "../../../../../lib/telemetry/run-telemetry.js";

const MAX_ANSWER_LENGTH = 10_000;

/** Maps a clarification store write failure (409) to its HTTP error, then defers
 *  the rest (401/403 DashboardAuthError, etc.) to the shared toHttpError. */
function toClarificationHttpError(error: unknown): never {
  if (error instanceof ClarificationStoreError) {
    throw createError({ statusCode: error.statusCode, statusMessage: error.message });
  }
  toHttpError(error);
}

export default defineEventHandler(async (event): Promise<ClarificationAnswerResponse | undefined> => {
  try {
    // Membership only, no role gate: answering a clarification is a user
    // decision, so every org member may answer.
    const actor = await requireDashboardActor(event);
    const id = getRouterParam(event, "id");
    if (!id) throw createError({ statusCode: 404, statusMessage: "Unknown clarification" });

    const body = await readBody(event).catch(() => null);
    const rawAnswer = typeof body?.answer === "string" ? body.answer : "";
    const answer = rawAnswer.trim();
    if (!answer || answer.length > MAX_ANSWER_LENGTH) {
      throw createError({ statusCode: 400, statusMessage: "invalid_answer" });
    }

    const db = getDb();
    const row = await getClarification(db, id);
    if (!row) throw createError({ statusCode: 404, statusMessage: "Unknown clarification" });
    // A dispatch that failed after the answer CAS leaves the row answered with
    // no dispatched run. Such a row is retryable: the answer stands, only the
    // run start is redone, so the CAS is replaced by a verify on retry.
    const isDispatchRetry = row.status === "answered" && row.dispatchedRunId === null;
    if (row.status !== "pending" && !isDispatchRetry) {
      throw createError({ statusCode: 409, statusMessage: "already_answered" });
    }

    const label = await dashboardUserLabel(db, actor.userId);
    const answerer = isDispatchRetry
      ? { id: row.answeredById ?? actor.userId, label: row.answeredByLabel ?? label }
      : { id: actor.userId, label };
    const adapters = createStepAdapters();

    // Cheap existence check before reserving anything: a deleted ticket can
    // never resume, so supersede the pending row and tell the caller it is gone.
    try {
      await adapters.issueTracker.fetchTicket(row.ticketKey);
    } catch (err) {
      if (err instanceof IssueTrackerNotFoundError) {
        await supersedePendingForTicket(db, row.ticketKey).catch(() => {});
        // Also supersede THIS row by id: on the retry path it is already
        // "answered" (not pending), so the ticket-wide pending supersede above
        // misses it and the dashboard would re-render the retry form forever on
        // a deleted ticket. The store guards this on an undispatched row.
        await supersedeClarification(db, row.id).catch(() => {});
        // A deleted ticket can never be re-picked, so the asking run would stay
        // "awaiting" forever. Flip it off awaiting on the way out.
        await resolveAwaitingRun(db, row.runId).catch(() => {});
        throw createError({ statusCode: 410, statusMessage: "ticket_gone" });
      }
      throw err;
    }

    const result = await dispatchClarificationAnswered({
      db,
      runRegistry: adapters.runRegistry,
      issueTracker: adapters.issueTracker,
      clarification: row,
      answer,
      actor: answerer,
      maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      isRetry: isDispatchRetry,
    });

    if (result.status === "conflict") {
      throw createError({ statusCode: 409, statusMessage: "already_answered" });
    }

    // Ordered best-effort writes after a started run: record the resume run on
    // the clarification, then flip the parked asking run awaiting -> success.
    await setDispatchedRunId(db, id, result.runId).catch(() => {});
    await resolveAwaitingRun(db, row.runId).catch(() => {});

    // Best-effort read-back for the response body: the resume run is already
    // started, so a read hiccup must not turn the response into an error. The
    // fallback serializes what this handler knows to be true (answered, with
    // this answer, actor, and run id) instead of the stale pending row.
    const final = await getClarification(db, id).catch(() => null);
    const fallback: ClarificationRow = {
      ...row,
      status: "answered",
      answer,
      answeredById: answerer.id,
      answeredByLabel: answerer.label,
      answeredAt: row.answeredAt ?? new Date(),
      dispatchedRunId: result.runId,
    };
    return { clarification: serializeClarification(final ?? fallback), runId: result.runId };
  } catch (error) {
    toClarificationHttpError(error);
  }
});
