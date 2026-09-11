/**
 * The Resend delivery webhook, from verified bytes to a ledger update.
 *
 * The route above this reads the raw body and the Svix headers and maps what
 * comes back to HTTP; everything else is decided here, in this order and no
 * other: the secret has to exist, the signature has to hold over the exact
 * bytes Resend sent, and only then is anything parsed. Verifying a payload we
 * had already parsed would authenticate a re-serialization rather than the
 * message.
 */
import { Webhook } from "svix";

import { resendWebhookEventSchema, type ResendWebhookEvent } from "@shared/contracts";

import { getDb } from "../../db/client.js";
import { resendWebhookSecret } from "../settings/index.js";
import { observeProviderWebhook } from "../system/index.js";
import { TriggerHttpError } from "../../infra/trigger-http-error.js";
import {
  applyInviteEmailDeliveryEvent,
  type ResendEmailDeliveryEvent,
} from "./invite-delivery.js";

export interface ResendWebhookRequest {
  /** The exact bytes Resend posted, as UTF-8. */
  rawBody: string;
  /** The Svix signature triple, each absent when the sender sent none. */
  svixId: string | undefined;
  svixSignature: string | undefined;
  svixTimestamp: string | undefined;
}

export async function handleResendWebhook(
  request: ResendWebhookRequest,
): Promise<{ status: "ok" }> {
  const secret = resendWebhookSecret();
  if (!secret) {
    observeProviderWebhook("email", "rejected", "secret_not_configured");
    throw new TriggerHttpError(500, "Resend webhook secret is not configured");
  }

  let payload: unknown;
  try {
    payload = new Webhook(secret).verify(request.rawBody, {
      "svix-id": request.svixId ?? "",
      "svix-signature": request.svixSignature ?? "",
      "svix-timestamp": request.svixTimestamp ?? "",
    });
  } catch {
    observeProviderWebhook("email", "rejected", "invalid_signature");
    throw new TriggerHttpError(401, "Invalid webhook signature");
  }

  try {
    await applyInviteEmailDeliveryEvent(getDb(), consumableEvent(payload));
    observeProviderWebhook("email", "accepted", "request_succeeded");
    return { status: "ok" };
  } catch (error) {
    observeProviderWebhook("email", "rejected", "handler_failed");
    throw error;
  }
}

/**
 * The signed payload, checked against the shared schema before the ledger reads
 * it.
 *
 * The check is new. The handler this replaced cast the verified payload to the
 * ledger's event type without looking at it, which is the audited gap this
 * closes: `type`, `data` and the Resend id are now known to be what the mapper
 * reads them as.
 *
 * The check stops at that envelope, and everything inside `data` is forwarded
 * exactly as it arrived, because the mapper tolerates an odd leaf and returns
 * "not handled" rather than throwing. A shape the envelope check rejects (a
 * body that is not an object, a numeric event name, a non-string email id)
 * becomes an empty event instead of a refusal: the ledger answers "not handled"
 * and the sender still gets its 200, because an error would make Resend retry a
 * message we will never understand. That substitution is new too, and it is the
 * only case where a signed payload no longer reaches the mapper whole.
 */
function consumableEvent(payload: unknown): ResendEmailDeliveryEvent {
  const parsed = resendWebhookEventSchema.safeParse(payload);
  if (!parsed.success) return {};
  // The verified event, with every leaf the schema left unknown still on it: the
  // cast is what the ledger's own reading of those leaves rests on, exactly as
  // it did before this file existed.
  const verified: ResendWebhookEvent = parsed.data;
  return verified as ResendEmailDeliveryEvent;
}
