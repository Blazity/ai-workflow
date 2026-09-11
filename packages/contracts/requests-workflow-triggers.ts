/**
 * Runtime request schemas for the trigger surfaces of a workflow definition:
 * webhook secrets, schedule previews and operator-initiated dispatch.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";
import { objectOrEmpty } from "./request-parsing";
import type { SchedulePreviewRequest } from "./api";
import { integerField } from "./request-fields";

/**
 * POST .../triggers/:nodeId/webhook/rotate.
 *
 * `force` is unknown rather than a boolean because the handler compared it to
 * `true` and ignored everything else: making a non-boolean a 400 here would
 * refuse a request that used to rotate normally.
 */
export const webhookRotateSecretRequestSchema = objectOrEmpty(
  z.object({
    force: z.unknown(),
  }),
);
export type WebhookRotateSecretRequest = z.infer<
  typeof webhookRotateSecretRequestSchema
>;

/**
 * POST .../triggers/:nodeId/webhook/set-secret.
 *
 * Unknown for the same reason: a non-string became the empty string, which the
 * store then refused with its own message about what a secret must look like.
 */
export const webhookSetSecretBodySchema = objectOrEmpty(
  z.object({
    secret: z.unknown(),
  }),
);
export type WebhookSetSecretBody = z.infer<typeof webhookSetSecretBodySchema>;

/**
 * POST .../triggers/:nodeId/webhook/test-delivery.
 *
 * The payload may be any JSON value including null, so what is required is the
 * key itself, not a value that survives a type check.
 */
export const webhookTestDeliveryRequestSchema = z.custom<{ payload: unknown }>(
  (value) =>
    Boolean(value) && typeof value === "object" && "payload" in (value as object),
  { message: "payload is required" },
);
export type WebhookTestDeliveryBody = z.infer<
  typeof webhookTestDeliveryRequestSchema
>;

/** Only the shape is checked: is a number a number, is an array an array.
 *  Whether a value is allowed (a step that divides the hour, a weekday 0-6, an
 *  hour 0-23) is the worker's compileSchedulePreset's job, on purpose, so there
 *  is exactly one place that decides it. */
function checkPreset(value: unknown, ctx: z.RefinementCtx): void {
  const invalid = () =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid schedule preset" });
  if (!value || typeof value !== "object") return invalid();
  const preset = value as Record<string, unknown>;
  switch (preset.kind) {
    case "every-n-minutes":
      if (typeof preset.minutes !== "number") invalid();
      return;
    case "every-n-hours":
      if (typeof preset.hours !== "number") invalid();
      return;
    case "daily":
      if (typeof preset.hour !== "number" || typeof preset.minute !== "number") invalid();
      return;
    case "weekly":
      if (typeof preset.hour !== "number" || typeof preset.minute !== "number") {
        return invalid();
      }
      if (
        !Array.isArray(preset.weekdays) ||
        !preset.weekdays.every((day) => typeof day === "number")
      ) {
        invalid();
      }
      return;
    default:
      return invalid();
  }
}

/**
 * POST .../triggers/:nodeId/schedule/preview.
 *
 * The checks run in the order the handler ran them, and the first failure is
 * what the caller sees: the body must be an object, then it must carry a
 * timezone, and only then does the source decide which of the remaining fields
 * matters. A timezone is demanded even for a preset that will not keep it,
 * exactly as before.
 */
export const schedulePreviewRequestSchema = z
  .custom<SchedulePreviewRequest>(
    (value) => Boolean(value) && typeof value === "object",
    { message: "Invalid preview request" },
  )
  .superRefine((value, ctx) => {
    const body = value as unknown as Record<string, unknown>;
    if (typeof body.timezone !== "string" || body.timezone.trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "timezone is required" });
      return;
    }
    if (body.source === "cron") {
      if (typeof body.cron !== "string" || body.cron.trim() === "") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cron is required" });
      }
      return;
    }
    if (body.source === "preset") {
      checkPreset(body.preset, ctx);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'source must be "cron" or "preset"',
    });
  });

/**
 * The identifier a dispatch input carries. It repeats the union's sentence
 * because a failed length check leaves the option merely dirty, and a union
 * reports a dirty option's own issues rather than its own.
 */
function dispatchIdentifier() {
  return z
    .string({
      required_error: "Invalid dispatch input",
      invalid_type_error: "Invalid dispatch input",
    })
    .trim()
    .min(1, "Invalid dispatch input");
}

/**
 * The body of POST .../triggers/:nodeId/manual-dispatch/preflight, and the
 * `input` field of a dispatch.
 *
 * Whatever is wrong (not an object, an unknown kind, a key that does not match
 * the kind, an empty identifier) the handler answered with one sentence, so the
 * two shapes are a union whose every failure carries that sentence. The
 * identifiers are trimmed here because the handler trimmed them before the
 * lookup ran, and a stored ticket key never has surrounding spaces.
 */
export const manualDispatchInputSchema = z.union(
  [
    z.object({ kind: z.literal("ticket"), ticketKey: dispatchIdentifier() }),
    z.object({ kind: z.literal("pull_request"), url: dispatchIdentifier() }),
  ],
  { errorMap: () => ({ message: "Invalid dispatch input" }) },
);
export type ManualDispatchInputBody = z.infer<typeof manualDispatchInputSchema>;

/**
 * POST .../triggers/:nodeId/manual-dispatch.
 *
 * The request id is a version 1 to 8 UUID, checked case insensitively, because
 * it is the idempotency key the dashboard generates and the store compares. The
 * envelope and the input answer with different sentences, which is what the two
 * hand-written checks did, and the envelope is checked first.
 */
export const manualDispatchRequestSchema = z.object(
  {
    requestId: z
      .string({
        required_error: "Invalid dispatch request",
        invalid_type_error: "Invalid dispatch request",
      })
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        "Invalid dispatch request",
      ),
    expectedDeployedVersion: integerField("Invalid dispatch request", 1),
    input: manualDispatchInputSchema,
  },
  {
    required_error: "Invalid dispatch request",
    invalid_type_error: "Invalid dispatch request",
  },
);
export type ManualDispatchRequestBody = z.infer<typeof manualDispatchRequestSchema>;
