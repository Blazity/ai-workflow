/**
 * Runtime request schemas for the runs HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";
import { objectOrEmpty } from "./request-parsing";

/**
 * The longest answer a parked clarification accepts, and the only declaration of
 * it. The worker's answer path and the MCP tool catalogue both read it from
 * here, so the number a client is told and the number it is judged by cannot
 * drift apart.
 */
export const MAX_CLARIFICATION_ANSWER_LENGTH = 10_000;

/**
 * The body of an answer to a parked clarification.
 *
 * The handler read `answer` without demanding a string, treated anything else
 * as absent, and judged the trimmed text while forwarding the untrimmed one, so
 * that is what this parses to: the original string, refused as `invalid_answer`
 * when it trims to nothing or is longer than an answer can be.
 */
export const clarificationAnswerRequestSchema = objectOrEmpty(
  z
    .object({ answer: z.unknown() })
    .refine(
      (body) => {
        const trimmed = clarificationAnswerText(body).trim();
        return trimmed.length > 0 && trimmed.length <= MAX_CLARIFICATION_ANSWER_LENGTH;
      },
      { message: "invalid_answer" },
    ),
);
export type ClarificationAnswerRequest = z.infer<typeof clarificationAnswerRequestSchema>;

/** The answer text a parsed body carries: anything that is not a string was
 *  never an answer, which is what the handler treated it as. */
export function clarificationAnswerText(body: { answer?: unknown }): string {
  return typeof body.answer === "string" ? body.answer : "";
}
