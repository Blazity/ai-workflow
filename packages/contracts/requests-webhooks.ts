/**
 * Runtime request schemas for the webhooks HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";

/**
 * A Resend delivery event, narrowed to the fields the invite delivery ledger
 * reads and no further.
 *
 * Everything is optional and unknown keys pass through because Resend adds
 * fields to these payloads without warning, and a webhook we already
 * authenticated by signature must not start failing because the provider grew a
 * field. The schema's job is to say what we consume, not to police the sender.
 */
export const resendWebhookEventSchema = z
  .object({
    type: z.string().optional(),
    data: z
      .object({
        email_id: z.string().optional(),
        tags: z.record(z.string(), z.string().optional()).optional(),
        bounce: z
          .object({
            message: z.string().optional(),
            type: z.string().optional(),
            subType: z.string().optional(),
          })
          .passthrough()
          .optional(),
        failed: z
          .object({ reason: z.string().optional() })
          .passthrough()
          .optional(),
        suppressed: z
          .object({
            message: z.string().optional(),
            type: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ResendWebhookEvent = z.infer<typeof resendWebhookEventSchema>;
