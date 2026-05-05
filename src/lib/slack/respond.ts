import { logger } from "../logger.js";

export interface SlackResponsePayload {
  text: string;
  /**
   * Slack-specific reply target. `ephemeral` is only visible to the invoking
   * user; `in_channel` is visible to everyone in the channel.
   */
  response_type?: "ephemeral" | "in_channel";
  replace_original?: boolean;
}

/**
 * POST a follow-up message to Slack's `response_url` from a slash command.
 *
 * Failures are logged and swallowed: the same philosophy the messaging
 * adapter applies — "notifications never break flows". A slash command that
 * has already been ack'd should not retry the user's request just because
 * Slack momentarily 5xx'd on the follow-up post.
 */
const RESPONSE_URL_TIMEOUT_MS = 5000;

export async function postToResponseUrl(
  responseUrl: string,
  payload: SlackResponsePayload,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESPONSE_URL_TIMEOUT_MS);
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, statusText: res.statusText },
        "slack_response_url_post_failed",
      );
    }
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      "slack_response_url_post_error",
    );
  } finally {
    clearTimeout(timer);
  }
}
