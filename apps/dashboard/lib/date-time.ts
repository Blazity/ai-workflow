/**
 * One zone, named, wherever a screen is rendered. A page rendered on the
 * server formats in the server's zone (UTC on Vercel) and a client component in
 * the browser's, so the same test time read two hours apart on the
 * Integrations list and the connection page, with no zone to tell why. UTC
 * with its name is the one both sides agree on, and renders the same text on
 * the server and in the browser.
 */
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/** One date-and-time presentation for operator-facing dashboard screens. */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DATE_TIME_FORMATTER.format(date);
}

/** Compact relative age for run and clarification timestamps. */
export function formatAgeMinutes(minutes: number): string {
  const wholeMinutes = Math.max(0, Math.floor(minutes));
  if (wholeMinutes < MINUTES_PER_HOUR) return `${wholeMinutes}m ago`;
  const hours = Math.floor(wholeMinutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours}h ago`;
  return `${Math.floor(hours / HOURS_PER_DAY)}d ago`;
}

export function isOlderThanHours(
  value: string,
  hours: number,
  nowMs = Date.now(),
): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && nowMs - timestamp > hours * MS_PER_HOUR;
}
