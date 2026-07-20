import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import type { ClarificationAnswerResponse } from "@shared/contracts";
import { getHookByToken, resumeHook } from "workflow/api";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { createStepAdapters } from "../../../../../lib/step-adapters.js";
import { IssueTrackerNotFoundError } from "../../../../../adapters/issue-tracker/types.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import {
  supersedeClarification,
  supersedePendingForTicket,
} from "../../../../../clarifications/store.js";
import {
  answerHookClarification,
  getHookClarification,
  type HookClarificationRow,
} from "../../../../../clarifications/hook-store.js";
import { resolveAwaitingRun } from "../../../../../lib/telemetry/run-telemetry.js";

const MAX_ANSWER_LENGTH = 10_000;

function serialize(row: HookClarificationRow) {
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    runId: row.runId,
    blockId: row.blockId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers,
    status: row.status,
    askedAt: row.askedAt.toISOString(),
    answer: row.answer,
    answeredById: row.answeredById,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    dispatchedRunId: null,
  };
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
    const row = await getHookClarification(db, id);
    if (!row) throw createError({ statusCode: 404, statusMessage: "Unknown clarification" });
    const isResumeRetry = row.status === "answered" && row.answer === answer;
    if (row.status !== "pending" && !isResumeRetry) {
      throw createError({ statusCode: 409, statusMessage: "already_answered" });
    }

    const label = await dashboardUserLabel(db, actor.userId);
    const answerer = isResumeRetry
      ? { id: row.answeredById ?? actor.userId, label: row.answeredByLabel ?? label }
      : { id: actor.userId, label };
    const adapters = createStepAdapters();

    // Ticketless scope:any continuations have no Jira lifecycle. Ticket-backed
    // checkpoints still fail early when their ticket has been deleted.
    if (row.ticketKey) {
      try {
        await adapters.issueTracker.fetchTicket(row.ticketKey);
      } catch (err) {
        if (!(err instanceof IssueTrackerNotFoundError)) throw err;
        await supersedePendingForTicket(db, row.ticketKey).catch(() => {});
        await supersedeClarification(db, row.id).catch(() => {});
        await resolveAwaitingRun(db, row.runId).catch(() => {});
        throw createError({ statusCode: 410, statusMessage: "ticket_gone" });
      }
    }

    const answered = isResumeRetry
      ? row
      : await answerHookClarification(db, row.id, answer, answerer);
    if (!answered) {
      throw createError({ statusCode: 409, statusMessage: "already_answered" });
    }

    try {
      await resumeHook(answered.hookToken, {
        answer,
        answeredById: answerer.id,
        answeredByLabel: answerer.label,
        answeredAt: answered.answeredAt?.toISOString() ?? new Date().toISOString(),
      });
    } catch (error) {
      // If the hook still exists, the resume definitely did not commit and the
      // same answer can be retried. A missing hook means the resume won but the
      // HTTP response was lost (or another identical retry already won).
      const hookStillExists = await getHookByToken(answered.hookToken)
        .then(() => true)
        .catch(() => false);
      if (hookStillExists) {
        throw createError({
          statusCode: 503,
          statusMessage: "clarification_resume_failed",
          cause: error,
        });
      }
    }

    return {
      clarification: serialize(answered),
      runId: answered.runId,
    };
  } catch (error) {
    toHttpError(error);
  }
});
