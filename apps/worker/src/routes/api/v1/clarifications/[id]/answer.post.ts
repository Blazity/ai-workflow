import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import type { ClarificationAnswerResponse } from "@shared/contracts";
import { getDb } from "../../../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { createStepAdapters } from "../../../../../lib/step-adapters.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import {
  answerClarificationAndResume,
  MAX_ANSWER_LENGTH,
} from "../../../../../clarifications/answer-core.js";
import {
  getHookClarification,
  type HookClarificationRow,
} from "../../../../../clarifications/hook-store.js";

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

    const label = await dashboardUserLabel(db, actor.userId);
    const adapters = createStepAdapters();

    const outcome = await answerClarificationAndResume({
      db,
      row,
      rawAnswer,
      actor: { id: actor.userId, label },
      issueTracker: adapters.issueTracker,
    });

    switch (outcome.kind) {
      case "invalid_answer":
        throw createError({ statusCode: 400, statusMessage: "invalid_answer" });
      case "conflict":
        throw createError({ statusCode: 409, statusMessage: "already_answered" });
      case "ticket_gone":
        throw createError({ statusCode: 410, statusMessage: "ticket_gone" });
      case "resume_failed_retryable":
        throw createError({
          statusCode: 503,
          statusMessage: "clarification_resume_failed",
          cause: outcome.error,
        });
      case "answered":
        return {
          clarification: serialize(outcome.row),
          runId: outcome.row.runId,
        };
    }
  } catch (error) {
    toHttpError(error);
  }
});
