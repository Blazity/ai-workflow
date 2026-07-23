export interface ReplayPageQuery {
  limit: number;
  cursor?: string;
}

type ReplayRawQuery = Record<string, string | string[] | undefined>;

function first(value: ReplayRawQuery[string]): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseReplayPageQuery(query: ReplayRawQuery): ReplayPageQuery {
  const rawLimit = first(query.limit);
  const parsed =
    rawLimit === undefined || rawLimit.trim() === ""
      ? Number.NaN
      : Number(rawLimit);
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(200, Math.trunc(parsed))
      : 100;
  const cursor = first(query.cursor);
  return {
    limit,
    ...(cursor ? { cursor } : {}),
  };
}
