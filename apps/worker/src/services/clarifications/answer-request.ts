/**
 * A dashboard answer to a parked question, from the id in the path to the
 * settled clarification.
 *
 * answer-core next door owns what answering does to the run; this owns what a
 * request to answer means: which question it names, who is answering, and the
 * one refusal that is about the request rather than the run, an id that names
 * no clarification.
 */
import type { ClarificationAnswerResponse } from "@shared/contracts";
import { getDb } from "../../db/client.js";
import {
  getHookClarification,
  type HookClarificationRow,
} from "../../clarifications/hook-store.js";
import { dashboardUserLabel } from "../../pre-pr-checks/store.js";
import { createAdapters } from "../vcs/index.js";
import {
  answerClarificationAndResume,
  type AnswerClarificationOutcome,
} from "./answer-core.js";

export type AnswerClarificationRequestOutcome =
  | Exclude<AnswerClarificationOutcome, { kind: "answered" }>
  | { kind: "unknown_clarification" }
  | { kind: "answered"; clarification: ClarificationAnswerResponse["clarification"]; runId: string };

/**
 * dispatchedRunId is always null here: answering resumes the run that asked,
 * so no second run is ever dispatched by this path.
 */
function serialize(row: HookClarificationRow): ClarificationAnswerResponse["clarification"] {
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

export async function answerClarificationRequest(input: {
  id: string;
  rawAnswer: string;
  actor: { userId: string };
}): Promise<AnswerClarificationRequestOutcome> {
  const db = getDb();
  const row = await getHookClarification(db, input.id);
  if (!row) return { kind: "unknown_clarification" };

  const label = await dashboardUserLabel(db, input.actor.userId);
  const outcome = await answerClarificationAndResume({
    db,
    row,
    rawAnswer: input.rawAnswer,
    actor: { id: input.actor.userId, label },
    issueTracker: createAdapters().issueTracker,
  });

  if (outcome.kind === "answered") {
    return { kind: "answered", clarification: serialize(outcome.row), runId: outcome.row.runId };
  }
  return outcome;
}
