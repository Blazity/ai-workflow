import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SECTION_HEADING_PATTERN = /^## (\d{4}-\d{2}-\d{2})$/u;
const BULLET_PATTERN = /^- /u;

export interface ChangelogEntry {
  /** File name under changelog/unreleased/, used for sort order and reporting. */
  fileName: string;
  /** Raw file content: one or two Markdown bullet lines, no frontmatter. */
  content: string;
}

export interface ChangelogSection {
  date: string;
  bullets: string[];
}

export interface ChangelogDocument {
  /** Everything before the first `## YYYY-MM-DD` heading, title and intro included. */
  intro: string;
  /** Sections in file order, which is newest first once collate() has run. */
  sections: ChangelogSection[];
}

export interface CollateOptions {
  /** Current CHANGELOG.md content. */
  changelog: string;
  /** Pending entries, already sorted by file name. */
  entries: ChangelogEntry[];
  /** The section date the entries fold into, YYYY-MM-DD. */
  date: string;
}

export interface CollateResult {
  /** The rewritten CHANGELOG.md content. Equal to the input when nothing changed. */
  changelog: string;
  /** False when there were no bullets to fold in. */
  changed: boolean;
  /** The bullet lines that were folded in, in the order they were written. */
  bullets: string[];
}

/** The bullet lines of one entry file, trimmed, in file order. */
export function bulletsOf(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => BULLET_PATTERN.test(line));
}

/** Parses CHANGELOG.md into its intro and its dated sections. */
export function parseChangelog(text: string): ChangelogDocument {
  const lines = text.split("\n");
  const firstHeadingIndex = lines.findIndex((line) => SECTION_HEADING_PATTERN.test(line.trim()));

  if (firstHeadingIndex === -1) {
    return { intro: text.replace(/\n+$/u, ""), sections: [] };
  }

  const intro = lines.slice(0, firstHeadingIndex).join("\n").replace(/\n+$/u, "");
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;

  for (const line of lines.slice(firstHeadingIndex)) {
    const trimmed = line.trim();
    const heading = SECTION_HEADING_PATTERN.exec(trimmed);
    if (heading) {
      current = { date: heading[1], bullets: [] };
      sections.push(current);
      continue;
    }
    if (current && BULLET_PATTERN.test(trimmed)) {
      current.bullets.push(trimmed);
    }
  }

  return { intro, sections };
}

/** Renders a parsed document back to CHANGELOG.md text, one trailing newline. */
export function renderChangelog(document: ChangelogDocument): string {
  const parts = [document.intro];
  for (const section of document.sections) {
    parts.push("", `## ${section.date}`, "", ...section.bullets);
  }
  return `${parts.join("\n")}\n`;
}

/**
 * Folds every pending entry into CHANGELOG.md under a `## <date>` section,
 * inserted at the top of the sections, merging into an existing section for
 * the same date instead of creating a second one. Pure: it takes the current
 * file content and returns the next one, so the caller owns every filesystem
 * effect (reading the entry files, writing the result, deleting the files).
 */
export function collate({ changelog, entries, date }: CollateOptions): CollateResult {
  const bullets = entries.flatMap((entry) => bulletsOf(entry.content));

  if (bullets.length === 0) {
    return { changelog, changed: false, bullets: [] };
  }

  const document = parseChangelog(changelog);
  const existing = document.sections.find((section) => section.date === date);

  if (existing) {
    existing.bullets.push(...bullets);
  } else {
    document.sections.unshift({ bullets, date });
  }

  return { bullets, changed: true, changelog: renderChangelog(document) };
}

export interface RunOptions {
  /** Repository root; changelog/unreleased/ and CHANGELOG.md live under it. */
  root: string;
  /** The section date, YYYY-MM-DD. */
  date: string;
  /** Preview only: report what would change without touching the filesystem. */
  dryRun: boolean;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Reads the pending entries and CHANGELOG.md, and applies (or previews) the collation. */
export async function run({ date, dryRun, root }: RunOptions): Promise<string> {
  const unreleasedDir = resolve(root, "changelog/unreleased");
  const changelogPath = resolve(root, "CHANGELOG.md");

  const fileNames = existsSync(unreleasedDir)
    ? (await readdir(unreleasedDir)).filter((name) => name.endsWith(".md")).sort()
    : [];

  if (fileNames.length === 0) {
    return "changelog: no pending entries, nothing to do";
  }

  const entries: ChangelogEntry[] = await Promise.all(
    fileNames.map(async (fileName) => ({
      content: await readFile(resolve(unreleasedDir, fileName), "utf8"),
      fileName,
    })),
  );

  const changelog = await readFile(changelogPath, "utf8");
  const result = collate({ changelog, date, entries });

  if (!result.changed) {
    return "changelog: no pending entries, nothing to do";
  }

  const noun = entries.length === 1 ? "entry" : "entries";
  const lines = [
    `changelog: folding ${entries.length} ${noun} into ${date}`,
    ...fileNames.map((fileName) => `  - ${fileName}`),
  ];

  if (dryRun) {
    lines.push("changelog: dry run, no files were written");
    return lines.join("\n");
  }

  await mkdir(unreleasedDir, { recursive: true });
  await writeFile(changelogPath, result.changelog);
  for (const fileName of fileNames) {
    await rm(resolve(unreleasedDir, fileName));
  }
  lines.push(
    `changelog: wrote CHANGELOG.md and removed ${entries.length} file(s) from changelog/unreleased/`,
  );
  return lines.join("\n");
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const root = resolve(argValue(argv, "--root") ?? resolve(import.meta.dirname, "../.."));
  const date = argValue(argv, "--date") ?? todayUtc();
  const dryRun = argv.includes("--dry-run");
  const output = await run({ date, dryRun, root });
  console.log(output);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
