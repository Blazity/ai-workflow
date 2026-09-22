/** Sizes and moments as the briefing and round views print them. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A recorded moment in the viewer's time zone, to the second. An unreadable
 *  value is shown as recorded. */
export function formatMoment(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** A clock time in the viewer's time zone, for "read at 14:05": short enough
 *  to sit in a header, exact enough to tell two people whose view is older. */
export function formatClock(at: Date): string {
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The first characters of a digest, enough to tell two apart on screen. */
export function shortDigest(sha256: string): string {
  return sha256.slice(0, 12);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
