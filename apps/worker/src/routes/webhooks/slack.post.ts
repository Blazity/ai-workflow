import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { handleSlackSlashCommand } from "../../services/slack/index.js";
import { TriggerHttpError } from "../../services/triggers/index.js";

/**
 * Slack slash command webhook.
 *
 * Configure in api.slack.com → Slash Commands:
 *   Command:     /ai-workflow
 *   Request URL: https://<your-domain>/webhooks/slack
 *
 * Auth: HMAC-SHA256 over `v0:${timestamp}:${rawBody}` (Slack signs every
 * request when a Signing Secret is configured for the app).
 *
 * The 3s ack budget is critical: Slack drops requests that don't respond in
 * time, so this route only captures the raw bytes and the two signed headers
 * and hands them to the service, which verifies, parses, schedules the real
 * work and returns the acknowledgement. Results are POSTed back to
 * `response_url`.
 */
export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    return await handleSlackSlashCommand({
      rawBody,
      signature: getHeader(event, "x-slack-signature"),
      timestamp: getHeader(event, "x-slack-request-timestamp"),
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
