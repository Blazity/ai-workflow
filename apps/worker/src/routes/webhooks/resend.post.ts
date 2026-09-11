import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { handleResendWebhook } from "../../services/email/index.js";
// The module that owns the error type, not the barrel: this route dispatches
// nothing through the trigger cluster, it only maps that refusal to a status.
import { TriggerHttpError } from "../../services/triggers/trigger-http-error.js";

/**
 * Resend delivery webhook: what became of an invite email we sent.
 *
 * This file is the transport adapter: raw bytes and the Svix headers in, the
 * service's answer out. Signature verification runs on those exact bytes inside
 * the service, before anything parses them.
 */
export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    return await handleResendWebhook({
      rawBody,
      svixId: getHeader(event, "svix-id"),
      svixSignature: getHeader(event, "svix-signature"),
      svixTimestamp: getHeader(event, "svix-timestamp"),
    });
  } catch (error) {
    if (error instanceof TriggerHttpError) {
      throw createError({
        statusCode: error.statusCode,
        statusMessage: error.statusMessage,
        ...(error.data ? { data: error.data } : {}),
      });
    }
    throw error;
  }
});
