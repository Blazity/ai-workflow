const SLACK_API_BASE = "https://slack.com/api";
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 3;

export interface SlackSearchMatch {
  channel: string;
  ts: string;
  text: string;
  permalink: string;
}

export interface SlackSearchResult {
  matches: SlackSearchMatch[];
  skippedChannels: string[];
}

export interface SlackSearchOptions {
  token: string;
  channels: string[];
  keywords: string[];
  lookbackDays: number;
  maxResults: number;
  now: Date;
}

interface SlackHistoryMessage {
  ts: string;
  text?: string;
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

export async function searchSlackChannels(
  options: SlackSearchOptions,
): Promise<SlackSearchResult> {
  const oldest = computeOldest(options.now, options.lookbackDays);
  const matches: SlackSearchMatch[] = [];
  const skippedChannels: string[] = [];

  for (const channel of options.channels) {
    const messages = await fetchChannelHistory(
      options.token,
      channel,
      oldest,
    ).catch(() => null);
    if (!messages) {
      skippedChannels.push(channel);
      continue;
    }
    for (const message of matchMessages(messages, options.keywords)) {
      matches.push({
        channel,
        ts: message.ts,
        text: message.text ?? "",
        permalink: "",
      });
    }
  }

  const top = matches.slice(0, options.maxResults);
  for (const match of top) {
    match.permalink = await fetchPermalink(
      options.token,
      match.channel,
      match.ts,
    ).catch(() => "");
  }
  return { matches: top, skippedChannels };
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
  });
  if (!res.ok) {
    throw new Error(
      `Slack API error: ${res.status} ${res.statusText} on ${method}`,
    );
  }
  const data = await res.json();
  if (!data?.ok) {
    throw new Error(
      `Slack API error: ${data?.error ?? "unknown_error"} on ${method}`,
    );
  }
  return data;
}
