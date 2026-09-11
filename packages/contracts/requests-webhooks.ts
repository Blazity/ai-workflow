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
 * A Resend delivery event, checked down to the envelope the invite delivery
 * ledger reads and no further.
 *
 * Three things are checked because the ledger reads them as strings: the event
 * name, the `data` object that carries the event, and the Resend id inside it.
 * Every other leaf is `unknown` on purpose. Resend shapes those freely (a
 * bounce subType that arrives as a number, tags that arrive as an array, a tag
 * whose value is null), the mapper already reads them defensively and answers
 * "not handled" for what it cannot use, and a delivery we authenticated by
 * signature must never be dropped because a field we do not read changed shape:
 * the sender would never retry it and the invite would sit in `queued` forever.
 *
 * Unknown keys pass through for the same reason, so the object the mapper reads
 * carries everything the sender sent.
 */
export const resendWebhookEventSchema = z
  .object({
    type: z.string().optional(),
    data: z
      .object({
        email_id: z.string().optional(),
        // Named to say what the ledger reads, typed unknown to say the provider
        // decides their shape.
        tags: z.unknown(),
        bounce: z.unknown(),
        failed: z.unknown(),
        suppressed: z.unknown(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ResendWebhookEvent = z.infer<typeof resendWebhookEventSchema>;
