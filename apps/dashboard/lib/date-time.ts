const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** One date-and-time presentation for operator-facing dashboard screens. */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DATE_TIME_FORMATTER.format(date);
}

export function isOlderThanHours(
  value: string,
  hours: number,
  nowMs = Date.now(),
): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && nowMs - timestamp > hours * 60 * 60 * 1000;
}
