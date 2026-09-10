import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { TriggerHttpError, handleGitHubWebhook } from "../../services/triggers/index.js";

/**
 * GitHub webhook ingress.
 *
 * The transport adapter: the raw bytes the signature covers, the three headers
 * that identify a delivery, and the translation of a refusal into an HTTP
 * status. Which deliveries mean something, and what they mean, is
 * `services/triggers`. Signature verification runs inside the service on these
 * exact bytes, before anything parses them.
 */
export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    return await handleGitHubWebhook({
      rawBody,
      signatureHeader: getHeader(event, "x-hub-signature-256"),
      eventName: getHeader(event, "x-github-event") ?? "",
      deliveryId: getHeader(event, "x-github-delivery")?.trim() ?? "",
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
