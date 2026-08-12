import { z } from "zod";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    questions: z.array(z.string().trim().min(1)).optional(),
    suggestedAnswers: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

/**
 * human_question: thin mapping to the engine's clarification exit. The block
 * performs no side effects itself; it returns kind "needs_human_input" and the
 * engine routes to clarificationExit, which posts the questions, labels the
 * ticket, moves it back, and notifies. Questions come from the params or, when
 * absent, from the most recent upstream output that carried a questions array.
 */
export const execute: BlockExecuteFn = async (
  block,
  steps,
  _ctx,
  resolvedInputs = {},
  execution,
): Promise<BlockExecutionResult> => {
  const configuredQuestions = Array.isArray(resolvedInputs.questions)
    ? resolvedInputs.questions
    : block.params.questions;
  let questions = Array.isArray(configuredQuestions)
    ? configuredQuestions.filter(
        (q): q is string => typeof q === "string" && q.trim().length > 0,
      )
    : [];
  const context =
    typeof resolvedInputs.context === "string" ? resolvedInputs.context.trim() : "";
  if (context !== "") {
    questions = [
      `Review this support investigation before deciding:\n\n${context}\n\nApprove the proposed code action?`,
    ];
  }

  // Params-provided suggestions win. Upstream suggestions only fill in when the
  // questions themselves fall back to upstream and the params carried none,
  // mirroring how questions fall back.
  const configuredSuggestions = Array.isArray(resolvedInputs.suggestedAnswers)
    ? resolvedInputs.suggestedAnswers
    : block.params.suggestedAnswers;
  let suggestedAnswers = Array.isArray(configuredSuggestions)
    ? configuredSuggestions.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];

  if (questions.length === 0) {
    const entries = Object.values(steps);
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i].output.questions;
      if (Array.isArray(candidate)) {
        const derived = candidate.filter(
          (q): q is string => typeof q === "string" && q.trim().length > 0,
        );
        if (derived.length > 0) {
          questions = derived;
          if (suggestedAnswers.length === 0) {
            const upstream = entries[i].output.suggestedAnswers;
            if (Array.isArray(upstream)) {
              suggestedAnswers = upstream.filter(
                (s): s is string => typeof s === "string" && s.trim().length > 0,
              );
            }
          }
          break;
        }
      }
    }
  }

  if (questions.length === 0) {
    return executionError(
      "human_question has no questions: set the questions param or place it after a block that produces questions",
      { category: "binding" },
    );
  }

  // A resumed clarification carries its answer in the invocation context.
  // Returning it as a normal block output lets a v2 graph branch on approve vs
  // reject, which is useful for webhook-originated cases that have no Jira
  // ticket to park or mutate.
  if (execution?.clarificationAnswer !== undefined) {
    return {
      kind: "next",
      output: {
        status: "answered",
        questions,
        ...(suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
        answer: execution.clarificationAnswer,
      },
    };
  }

  return {
    kind: "needs_human_input",
    output: {
      status: "needs_human_input",
      questions,
      ...(suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
    },
    questions,
    ...(suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
  };
};
