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
import { TriggerHttpError } from "../triggers/index.js";
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
 * The signed payload, narrowed to the fields the ledger reads.
 *
 * A payload the schema rejects becomes an empty event rather than a refusal,
 * which is what a signed but unrecognized shape has always produced here: the
 * ledger maps an event it does not recognize to "not handled" and the sender
 * still gets its 200. Answering an error instead would make Resend retry a
 * message we will never understand.
 */
function consumableEvent(payload: unknown): ResendEmailDeliveryEvent {
  const parsed = resendWebhookEventSchema.safeParse(payload);
  return parsed.success ? (parsed.data satisfies ResendWebhookEvent) : {};
}
