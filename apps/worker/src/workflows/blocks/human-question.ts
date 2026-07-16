import { z } from "zod";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

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
export const execute: BlockExecuteFn = async (block, steps, _ctx): Promise<BlockExecutionResult> => {
  let questions = Array.isArray(block.params.questions)
    ? block.params.questions.filter(
        (q): q is string => typeof q === "string" && q.trim().length > 0,
      )
    : [];

  // Params-provided suggestions win. Upstream suggestions only fill in when the
  // questions themselves fall back to upstream and the params carried none,
  // mirroring how questions fall back.
  let suggestedAnswers = Array.isArray(block.params.suggestedAnswers)
    ? block.params.suggestedAnswers.filter(
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
    return {
      kind: "failed",
      output: { status: "failed" },
      reason:
        "human_question has no questions: set the questions param or place it after a block that produces questions",
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
