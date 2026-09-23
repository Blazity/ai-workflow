/**
 * Release versions are vYYYY.MM.N: the year and month of the collation date,
 * and N counting the releases cut in that month, starting at 1. The Arthur
 * tenant named its releases the same way, so one reader sees one scheme.
 */

const VERSION_PATTERN = /^v(\d{4})\.(\d{2})\.([1-9]\d*)$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-\d{2}$/u;

export interface ParsedVersion {
  year: number;
  month: number;
  n: number;
}

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return undefined;
  return { month: Number(match[2]), n: Number(match[3]), year: Number(match[1]) };
}

function formatVersion({ month, n, year }: ParsedVersion): string {
  return `v${year}.${String(month).padStart(2, "0")}.${n}`;
}

/** Orders two versions oldest first; a string that is no version sorts before every version. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);
  return left.year - right.year || left.month - right.month || left.n - right.n;
}

/**
 * The next free version for a collation on `date` (YYYY-MM-DD). `taken` is
 * every name already in use: the repository's tags and the version headings
 * already in CHANGELOG.md, so a version a pending collation wrote but nobody
 * tagged yet is never handed out twice. Anything that is not a version is ignored.
 */
export function nextVersion(date: string, taken: Iterable<string>): string {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new Error(`nextVersion: "${date}" is not a YYYY-MM-DD date`);
  const year = Number(match[1]);
  const month = Number(match[2]);

  let highest = 0;
  for (const name of taken) {
    const parsed = parseVersion(name);
    if (parsed && parsed.year === year && parsed.month === month) {
      highest = Math.max(highest, parsed.n);
    }
  }
  return formatVersion({ month, n: highest + 1, year });
}

/** The newest version in `taken` that is older than `version`, for the compare link. */
export function previousVersion(version: string, taken: Iterable<string>): string | undefined {
  return [...taken]
    .filter((name) => parseVersion(name) && compareVersions(name, version) < 0)
    .sort(compareVersions)
    .at(-1);
}
