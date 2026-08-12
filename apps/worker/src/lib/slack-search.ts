const SLACK_API_BASE = "https://slack.com/api";
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 3;

/** Per-request budget. Bounds one channel at 3 pages x this, so a hung Slack
 *  cannot eat the block's whole timeout and lose the Jira evidence with it. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Why a retrieval provider produced nothing, coarse enough to act on and to
 * report to a human: a channel the bot was never invited to is a configuration
 * mistake somebody must fix, a timeout or an outage is worth retrying, and both
 * are different from "searched, found nothing". Shared vocabulary for the Slack
 * and Jira sides of the investigate block.
 */
export type RetrievalFailureReason = "permission" | "timeout" | "unavailable";

export interface SlackSearchMatch {
  channel: string;
  ts: string;
  text: string;
  permalink: string;
  /** Slack user id of the author, empty for messages posted without one. */
  author: string;
}

/** A channel that was configured but contributed nothing, and why. */
export interface SlackChannelSkip {
  channel: string;
  reason: RetrievalFailureReason;
}

export interface SlackSearchResult {
  matches: SlackSearchMatch[];
  skipped: SlackChannelSkip[];
}

export interface SlackSearchOptions {
  /** Bot token, supplied by the caller from its own env wiring — this module
   *  never reads process env itself. */
  token: string;
  channels: string[];
  keywords: string[];
  lookbackDays: number;
  maxResults: number;
  /** Clock injection: the lookback window is computed from this value so tests
   *  stay deterministic. */
  now: Date;
}

interface SlackHistoryMessage {
  ts: string;
  text?: string;
  user?: string;
}

/** Slack API errors that mean "this token may not see this", as opposed to
 *  "Slack is unwell". not_in_channel is the one every operator hits: the bot was
 *  never invited to a channel somebody put in the config. */
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

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly reason: RetrievalFailureReason,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

/** Anything that is not a classified Slack answer: an aborted request is a
 *  timeout, everything else (DNS, TLS, a socket dying mid-body) is an outage. */
export function classifySlackFailure(error: unknown): RetrievalFailureReason {
  if (error instanceof SlackApiError) return error.reason;
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable";
}

export function computeOldest(now: Date, lookbackDays: number): string {
  return ((now.getTime() - lookbackDays * 86_400_000) / 1000).toFixed(6);
}

export function matchMessages<T extends { text?: string }>(
  messages: T[],
  keywords: string[],
): T[] {
  const needles = keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword !== "");
  if (needles.length === 0) return [];
  return messages.filter((message) => {
    const text = (message.text ?? "").toLowerCase();
    return needles.some((needle) => text.includes(needle));
  });
}

/**
 * Keyword search over the recent history of the configured channels.
 *
 * The channel list IS the scope: this module never enumerates conversations, so
 * a channel nobody configured cannot be read even if the bot can see it.
 *
 * One failing channel never fails the search — it is reported in `skipped` with
 * its reason and the remaining channels still contribute.
 */
export async function searchSlackChannels(
  options: SlackSearchOptions,
): Promise<SlackSearchResult> {
  const oldest = computeOldest(options.now, options.lookbackDays);
  const matches: SlackSearchMatch[] = [];
  const skipped: SlackChannelSkip[] = [];

  for (const channel of options.channels) {
    let messages: SlackHistoryMessage[];
    try {
      messages = await fetchChannelHistory(options.token, channel, oldest);
    } catch (error) {
      skipped.push({ channel, reason: classifySlackFailure(error) });
      continue;
    }
    for (const message of matchMessages(messages, options.keywords)) {
      matches.push({
        channel,
        ts: message.ts,
        text: message.text ?? "",
        permalink: "",
        author: message.user ?? "",
      });
    }
  }

  // Permalinks only for the hits that survive the cut: one extra call each, and
  // maxResults bounds them.
  const top = matches.slice(0, options.maxResults);
  for (const match of top) {
    match.permalink = await fetchPermalink(
      options.token,
      match.channel,
      match.ts,
    ).catch(() => "");
  }
  return { matches: top, skipped };
}

async function fetchChannelHistory(
  token: string,
  channel: string,
  oldest: string,
): Promise<SlackHistoryMessage[]> {
  const messages: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const data = await slackApi(token, "conversations.history", {
      channel,
      oldest,
      limit: String(HISTORY_PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    });
    const pageMessages = Array.isArray(data?.messages) ? data.messages : [];
    for (const message of pageMessages) {
      if (typeof message?.ts === "string") messages.push(message);
    }
    const nextCursor = data?.response_metadata?.next_cursor;
    if (!data?.has_more || typeof nextCursor !== "string" || nextCursor === "") {
      break;
    }
    cursor = nextCursor;
  }
  return messages;
}

async function fetchPermalink(
  token: string,
  channel: string,
  ts: string,
): Promise<string> {
  const data = await slackApi(token, "chat.getPermalink", {
    channel,
    message_ts: ts,
  });
  return typeof data?.permalink === "string" ? data.permalink : "";
}

async function slackApi(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<any> {
  const url = `${SLACK_API_BASE}/${method}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new SlackApiError(
      `Slack API error: ${res.status} ${res.statusText} on ${method}`,
      res.status === 401 || res.status === 403 ? "permission" : "unavailable",
    );
  }
  const data = await res.json();
  if (!data?.ok) {
    const code = typeof data?.error === "string" ? data.error : "unknown_error";
    throw new SlackApiError(
      `Slack API error: ${code} on ${method}`,
      PERMISSION_ERRORS.has(code) ? "permission" : "unavailable",
    );
  }
  return data;
}
