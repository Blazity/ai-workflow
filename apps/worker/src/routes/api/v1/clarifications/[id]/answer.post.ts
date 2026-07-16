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
  supersedePendingForTicket,
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

    if (result.status === "at_capacity") {
      throw createError({ statusCode: 409, statusMessage: "at_capacity" });
    }
    if (result.status === "already_claimed") {
      throw createError({ statusCode: 409, statusMessage: "already_claimed" });
    }
    if (result.status === "conflict") {
      throw createError({ statusCode: 409, statusMessage: "already_answered" });
    }

    // Ordered best-effort writes after a started run: record the resume run on
    // the clarification, then flip the parked asking run awaiting -> success.
    await setDispatchedRunId(db, id, result.runId).catch(() => {});
    await resolveAwaitingRun(db, row.runId).catch(() => {});

    const final = await getClarification(db, id);
    return { clarification: serializeClarification(final ?? row), runId: result.runId };
  } catch (error) {
    toClarificationHttpError(error);
  }
});
