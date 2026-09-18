import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import {
  clarificationAnswerRequestSchema,
  clarificationAnswerText,
  parseRequestBody,
  type ClarificationAnswerResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import {
  answerClarificationRequest,
} from "../../../../../services/clarifications/answer-request.js";

export default defineEventHandler(async (event): Promise<ClarificationAnswerResponse | undefined> => {
  try {
    // Membership only, no role gate: answering a clarification is a user
    // decision, so every org member may answer.
    const actor = await requireDashboardActor(event);
    const id = getRouterParam(event, "id");
    if (!id) throw createError({ statusCode: 404, statusMessage: "Unknown clarification" });

    const parsed = parseRequestBody(
      clarificationAnswerRequestSchema,
      (await readBody(event).catch(() => null)) ?? {},
    );
    if (!parsed.ok) {
      throw createError({ statusCode: 400, statusMessage: parsed.message });
    }

    const outcome = await answerClarificationRequest({
      id,
      rawAnswer: clarificationAnswerText(parsed.value),
      actor: { userId: actor.userId },
    });

    switch (outcome.kind) {
      case "unknown_clarification":
        throw createError({ statusCode: 404, statusMessage: "Unknown clarification" });
      case "invalid_answer":
        throw createError({ statusCode: 400, statusMessage: "invalid_answer" });
      case "conflict":
        throw createError({ statusCode: 409, statusMessage: "already_answered" });
      case "resume_terminal":
        throw createError({
          statusCode: 409,
          statusMessage:
            "This clarification was answered, but the run could not be resumed and was stopped. Start a new run for this ticket to retry.",
        });
      case "answer_unclear":
        // 422 rather than 400: the request was perfectly well formed and the
        // words may be too, we simply could not tell what they decided. Nothing
        // was recorded, the question is still pending and the run is still
        // parked, so the same box takes another answer.
        //
        // The core's own sentence goes back verbatim. It names what we read and
        // the one reply that ends the exchange, and it is the same sentence the
        // ticket carries, so a person who reads both meets one story.
        throw createError({
          statusCode: 422,
          statusMessage: outcome.confirm,
        });
      case "ticket_gone":
        throw createError({ statusCode: 410, statusMessage: "ticket_gone" });
      case "ticket_transition_failed":
        // Nothing was committed: the question is still pending, so the same
        // answer can simply be submitted again once Jira recovers.
        throw createError({
          statusCode: 503,
          statusMessage: "clarification_transition_failed",
          cause: outcome.error,
        });
      case "resume_failed_retryable":
        throw createError({
          statusCode: 503,
          statusMessage: "clarification_resume_failed",
          cause: outcome.error,
        });
      case "resume_exhausted":
        throw createError({
          statusCode: 503,
          statusMessage: "clarification_resume_exhausted",
          cause: outcome.error,
        });
      case "answered":
        return {
          clarification: outcome.clarification,
          runId: outcome.runId,
          // Present only when the answer recorded no repository decision. The
          // person answering here may never open the ticket the same sentence
          // is posted to, and without it they are told nothing but "answered"
          // and then asked the same question on the next run.
          ...(outcome.recordOutcome ? { recordOutcome: outcome.recordOutcome } : {}),
        };
    }
  } catch (error) {
    toHttpError(error);
  }
});
