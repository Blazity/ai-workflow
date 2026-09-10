/**
 * Field shapes several request schemas spell the same way.
 *
 * They exist because a handler that answered one sentence for a whole family of
 * failures has to keep answering it here: a message attached to only one of the
 * checks would let a different sentence out for a fractional number than for a
 * missing one.
 */
import { z } from "zod";

/**
 * A whole-number field whose every failure (missing, wrong type, fractional,
 * out of range) answers with one message. The handlers spelled that out as a
 * four-part `typeof`/`Number.isInteger`/comparison chain, so every part carries
 * the same message here.
 */
export function integerField(message: string, minimum: number) {
  return z
    .number({ required_error: message, invalid_type_error: message })
    .int(message)
    .min(minimum, message);
}
