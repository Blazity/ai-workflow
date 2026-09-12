import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
// Cluster modules, not the barrel: the barrel also re-exports the polling
// pass and the other providers' handlers, and this route needs neither.
import { handleGitLabWebhook } from "../../services/triggers/gitlab/handle-gitlab-webhook.js";
import { getRequestSettingsSnapshot } from "../../services/settings/index.js";
import { getRequestRepositoryCatalogSnapshot } from "../../services/repository-catalog/index.js";
import { TriggerHttpError } from "../../services/triggers/trigger-http-error.js";

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
      // Not awaited here: the service checks the token first and only the
      // verified path pays for the load.
      loadSettings: () => getRequestSettingsSnapshot(event),
      // Same thunk, same reason: the catalog is read only once the
      // token has been checked.
      loadRepositoryCatalog: () => getRequestRepositoryCatalogSnapshot(event),
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
