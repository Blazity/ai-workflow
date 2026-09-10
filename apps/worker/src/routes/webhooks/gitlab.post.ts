import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { TriggerHttpError, handleGitLabWebhook } from "../../services/triggers/index.js";

/**
 * GitLab webhook ingress.
 *
 * The transport adapter: the raw bytes, the headers a delivery is identified
 * by, and the translation of a refusal into an HTTP status. Which deliveries
 * mean something, and what they mean, is `services/triggers`. The token check
 * runs inside the service before anything parses the body.
 */
export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    return await handleGitLabWebhook({
      rawBody,
      tokenHeader: getHeader(event, "x-gitlab-token"),
      eventName: getHeader(event, "x-gitlab-event"),
      messageId: getHeader(event, "webhook-id"),
      idempotencyKey: getHeader(event, "idempotency-key"),
      eventUuid: getHeader(event, "x-gitlab-event-uuid"),
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
