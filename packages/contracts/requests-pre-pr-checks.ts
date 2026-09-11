/**
 * Runtime request schemas for the pre-pr-checks HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";

/**
 * The save envelope, and only the envelope.
 *
 * `config` stays unknown here on purpose. It is validated further down by
 * repoScriptsConfigSchema, whose refusal message names the offending path, and
 * what is finally stored is the raw submitted value rather than the normalized
 * one, so a second schema over the same bytes would either duplicate that
 * message or quietly change what gets persisted.
 *
 * `baseVersion` stays unknown for a blunter reason: the handler acted on it
 * only when it was a number and ignored every other value in silence,
 * including a numeric string. Typing it here would start refusing bodies that
 * used to save.
 */
export const prePrCheckSaveRequestSchema = z
  .object(
    {
      config: z.unknown(),
      baseVersion: z.unknown(),
    },
    // What a body that is not an object answers. The handler read `.config` off
    // whatever arrived, found nothing, and refused for the missing config.
    { message: "Invalid config: config is required." },
  )
  .passthrough();
export type PrePrCheckSaveRequestEnvelope = z.infer<
  typeof prePrCheckSaveRequestSchema
>;

/** Restoring a stored version. Non-integers and non-numbers refuse alike. */
export const prePrCheckRestoreRequestSchema = z.object(
  {
    version: z
      .number({ message: "Invalid version" })
      .int({ message: "Invalid version" }),
  },
  { message: "Invalid version" },
);
export type PrePrCheckRestoreRequest = z.infer<
  typeof prePrCheckRestoreRequestSchema
>;
