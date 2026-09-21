/**
 * Read-only keyword search over the recent history of named channels, for a
 * research path.
 *
 * Moved from `apps/worker/src/adapters/messaging/slack-search.ts`. What
 * changed: every request goes through `ctx.http` rather than a bare `fetch`,
 * and the result speaks the capability's vocabulary instead of Slack's.
 *
 * The channel list IS the scope: nothing here enumerates conversations, so a
 * channel nobody named cannot be read even when the bot can see it. One
 * failing channel never fails the search; it is reported in `skipped` with its
 * reason and the rest still contribute.
 */
import type {
  MessageRetrievalFailure,
  MessageSearchMatch,
  MessageSearchOutcome,
  MessageSearchQuery,
  MessageSearchSkip,
} from "@integrations/sdk";
import type { SlackApi, SlackCall } from "./api";

const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 3;

/**
 * Slack errors that mean "this token may not see this", as opposed to "Slack
 * is unwell". `not_in_channel` is the one every operator hits: the bot was
 * never invited to a channel somebody put in the configuration.
 */
const PERMISSION_ERRORS = new Set([
  "not_in_channel",
  "channel_not_found",
  "missing_scope",
  "no_permission",
  "restricted_action",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
]);

interface SlackHistoryMessage {
  readonly ts?: unknown;
  readonly text?: unknown;
  readonly user?: unknown;
}

function computeOldest(now: Date, lookbackDays: number): string {
  return ((now.getTime() - lookbackDays * 86_400_000) / 1000).toFixed(6);
}

function matchMessages<T extends { readonly text?: unknown }>(
  messages: readonly T[],
  keywords: readonly string[],
): T[] {
  const needles = keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword !== "");
  if (needles.length === 0) return [];
  return messages.filter((message) => {
    const text = (typeof message.text === "string" ? message.text : "").toLowerCase();
    return needles.some((needle) => text.includes(needle));
  });
}

export async function searchSlackChannels(
  api: SlackApi,
  query: MessageSearchQuery,
  now: Date = new Date(),
): Promise<MessageSearchOutcome> {
  const oldest = computeOldest(now, query.lookbackDays);
  const hits: { channel: string; ts: string; text: string; author: string }[] = [];
  const skipped: MessageSearchSkip[] = [];
  const skip = (channel: string, reason: MessageRetrievalFailure) => {
    if (!skipped.some((entry) => entry.channel === channel)) skipped.push({ channel, reason });
  };

  for (const channel of query.channels) {
    const history = await fetchChannelHistory(api, channel, oldest);
    if (!history.ok) {
      skip(channel, history.reason);
      continue;
    }
    for (const message of matchMessages(history.messages, query.keywords)) {
      hits.push({
        channel,
        ts: String(message.ts),
        text: typeof message.text === "string" ? message.text : "",
        author: typeof message.user === "string" ? message.user : "",
      });
    }
  }

  // Links only for the hits that survive the cut: one extra call each, and
  // maxResults bounds them.
  const matches: MessageSearchMatch[] = [];
  for (const hit of hits.slice(0, query.maxResults)) {
    const link = await api.call<{ permalink?: unknown }>("chat.getPermalink", {
      channel: hit.channel,
      message_ts: hit.ts,
    });
    if (!link.ok || typeof link.body.permalink !== "string" || link.body.permalink === "") {
      skip(hit.channel, link.ok ? "unavailable" : classify(link));
      continue;
    }
    const seconds = Number(hit.ts);
    matches.push({
      channel: hit.channel,
      author: hit.author,
      text: hit.text,
      url: link.body.permalink,
      postedAt: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : "",
      id: hit.ts,
    });
  }
  return { ok: true, matches, skipped };
}

async function fetchChannelHistory(
  api: SlackApi,
  channel: string,
  oldest: string,
): Promise<
  | { readonly ok: true; readonly messages: SlackHistoryMessage[] }
  | { readonly ok: false; readonly reason: MessageRetrievalFailure }
> {
  const messages: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const data = await api.call<{
      messages?: unknown;
      has_more?: unknown;
      response_metadata?: { next_cursor?: unknown };
    }>("conversations.history", {
      channel,
      oldest,
      limit: String(HISTORY_PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    });
    if (!data.ok) return { ok: false, reason: classify(data) };
    const page_messages = Array.isArray(data.body.messages) ? data.body.messages : [];
    for (const message of page_messages as SlackHistoryMessage[]) {
      if (typeof message?.ts === "string") messages.push(message);
    }
    const next = data.body.response_metadata?.next_cursor;
    if (data.body.has_more !== true || typeof next !== "string" || next === "") break;
    cursor = next;
  }
  return { ok: true, messages };
}

/** Slack's own word for the refusal, read as something a person can act on. */
function classify(call: SlackCall<unknown>): MessageRetrievalFailure {
  if (call.ok) return "unavailable";
  if (call.error === null) {
    return call.cause === "Slack did not answer in time" ? "timeout" : "unavailable";
  }
  return PERMISSION_ERRORS.has(call.error) ? "permission" : "unavailable";
}
