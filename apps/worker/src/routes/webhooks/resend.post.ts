import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { Webhook } from "svix";
import { env } from "../../../env.js";
import { getDb } from "../../db/client.js";
import {
  applyInviteEmailDeliveryEvent,
  type ResendEmailDeliveryEvent,
} from "../../lib/email/invite-delivery.js";
import { observeProviderWebhook } from "../../system-health/provider-webhook-observation.js";

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    observeProviderWebhook("email", "rejected", "secret_not_configured");
    throw createError({
      statusCode: 500,
      statusMessage: "Resend webhook secret is not configured",
    });
  }

  let payload: unknown;
  try {
    payload = new Webhook(secret).verify(rawBody, {
      "svix-id": getHeader(event, "svix-id") ?? "",
      "svix-signature": getHeader(event, "svix-signature") ?? "",
      "svix-timestamp": getHeader(event, "svix-timestamp") ?? "",
    });
  } catch {
    observeProviderWebhook("email", "rejected", "invalid_signature");
    throw createError({ statusCode: 401, statusMessage: "Invalid webhook signature" });
  }
  try {
    await applyInviteEmailDeliveryEvent(getDb(), asResendEvent(payload, rawBody));
    observeProviderWebhook("email", "accepted", "request_succeeded");
    return { status: "ok" };
  } catch (error) {
    observeProviderWebhook("email", "rejected", "handler_failed");
    throw error;
  }
});

function asResendEvent(
  payload: unknown,
  rawBody: string,
): ResendEmailDeliveryEvent {
  if (payload && typeof payload === "object") {
    return payload as ResendEmailDeliveryEvent;
  }
  return JSON.parse(rawBody) as ResendEmailDeliveryEvent;
}
