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
import {
  getConnectedHookClarification,
  type HookClarificationRow,
} from "../../db/repositories/clarification-hooks.js";
import { getConnectedDashboardUserLabel } from "../../db/repositories/auth.js";
import { createAdapters, issueTrackerIfConnected } from "../../engine/support/adapters.js";
import {
  answerConnectedClarificationAndResume,
  type AnswerClarificationOutcome,
} from "./answer-core.js";
import { loadSettingsSnapshot } from "../settings/index.js";

export type AnswerClarificationRequestOutcome =
  | Exclude<AnswerClarificationOutcome, { kind: "answered" }>
  | { kind: "unknown_clarification" }
  /** The question was asked on a ticket and no tracker is usable to answer it
   *  on. Nothing was recorded; the question is still pending. `retryable`
   *  when the settings could not be read, rather than nothing being there. */
  | { kind: "issue_tracker_unavailable"; message: string; retryable: boolean }
  | {
      kind: "answered";
      clarification: ClarificationAnswerResponse["clarification"];
      runId: string;
      /** What the answer did to the repository record, carried straight through
       *  so the dashboard shows the same words every other channel does. */
      recordOutcome?: string;
    };

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
  const row = await getConnectedHookClarification(input.id);
  if (!row) return { kind: "unknown_clarification" };

  // A question asked on a ticket is answered on it, so without a usable
  // tracker it is refused before anything is recorded. Reading the throwing
  // getter here answered every dashboard answer on a deployment with no
  // tracker with a server error, a question with no ticket included.
  const adapters = await createAdapters();
  const tracker = adapters.issueTrackerResolution;
  if (row.ticketKey && !tracker.ok) {
    return {
      kind: "issue_tracker_unavailable",
      message: tracker.unreadable
        ? "This deployment's integration settings could not be read, so the ticket this question was asked on could not be reached and nothing was recorded. Try again shortly."
        : tracker.reason,
      retryable: tracker.unreadable,
    };
  }
  const issueTracker = issueTrackerIfConnected(adapters);

  const label = await getConnectedDashboardUserLabel(input.actor.userId);
  const settings = await loadSettingsSnapshot();
  const outcome = await answerConnectedClarificationAndResume({
    row,
    rawAnswer: input.rawAnswer,
    actor: { id: input.actor.userId, label },
    surface: { kind: "dashboard" },
    ...(issueTracker ? { issueTracker } : {}),
    aiColumn: settings.COLUMN_AI,
    cancelSettings: settings,
  });

  if (outcome.kind === "answered") {
    return {
      kind: "answered",
      clarification: serialize(outcome.row),
      runId: outcome.row.runId,
      ...(outcome.recordOutcome ? { recordOutcome: outcome.recordOutcome } : {}),
    };
  }
  return outcome;
}
