import { existsSync } from "node:fs";
import { appendFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assignArea } from "./areas.ts";
import {
  listTags,
  pullRequestAuthors,
  traceEntries,
  UNRELEASED_DIR,
  type CommandRunner,
  type EntryOrigin,
} from "./history.ts";
import {
  groupByArea,
  renderChangelogSection,
  renderReleaseBody,
  SECTION_HEADING_PATTERN,
  type Attribution,
  type ReleaseNotes,
} from "./notes.ts";
import { anthropicClient, readToneRule, summarize, type ModelClient } from "./summaries.ts";
import { nextVersion, previousVersion } from "./version.ts";

/**
 * The daily collation: folds every pending file in changelog/unreleased/ into
 * one new release section at the top of CHANGELOG.md, headed by the next
 * version, and deletes the files. The GitHub Release for that version is cut
 * after the section reaches main (scripts/changelog/publish.ts).
 */

const ANY_SECTION_PATTERN = /^## \S/u;
const BULLET_PATTERN = /^- /u;

export const DEFAULT_REPOSITORY = "Blazity/ai-workflow";

export interface ChangelogEntry {
  /** File name under changelog/unreleased/, used for sort order and reporting. */
  fileName: string;
  /** Raw file content: one or two Markdown bullet lines, no frontmatter. */
  content: string;
}

export interface ChangelogSection {
  /** The `## ...` line: a release (`## v2026.09.1 (2026-09-23)`) or an older dated section. */
  heading: string;
  /** The lines under the heading, blank lines at either end trimmed. */
  lines: string[];
}

export interface ChangelogDocument {
  /** Everything before the first `## ` heading, title and intro included. */
  intro: string;
  /** Sections in file order, newest first. */
  sections: ChangelogSection[];
}

/** The bullet lines of one entry file, trimmed, in file order. */
export function bulletsOf(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => BULLET_PATTERN.test(line));
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

/** Parses CHANGELOG.md into its intro and its sections, keeping each section's text as written. */
export function parseChangelog(text: string): ChangelogDocument {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => ANY_SECTION_PATTERN.test(line));
  if (first === -1) return { intro: text.replace(/\n+$/u, ""), sections: [] };

  const sections: ChangelogSection[] = [];
  for (const line of lines.slice(first)) {
    if (ANY_SECTION_PATTERN.test(line)) sections.push({ heading: line.trim(), lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  return {
    intro: lines.slice(0, first).join("\n").replace(/\n+$/u, ""),
    sections: sections.map((section) => ({ heading: section.heading, lines: trimBlank(section.lines) })),
  };
}

/** Renders a parsed document back to CHANGELOG.md text, one trailing newline. */
export function renderChangelog(document: ChangelogDocument): string {
  const parts = [document.intro];
  for (const section of document.sections) {
    parts.push("", section.heading);
    if (section.lines.length > 0) parts.push("", ...section.lines);
  }
  return `${parts.join("\n")}\n`;
}

/** Every version a CHANGELOG.md heading already claims, tagged or not. */
export function versionsInChangelog(text: string): string[] {
  return parseChangelog(text)
    .sections.map((section) => SECTION_HEADING_PATTERN.exec(section.heading)?.[1])
    .filter((version): version is string => Boolean(version));
}

/** Inserts the release section above every existing section. Pure. */
export function insertRelease(changelog: string, notes: ReleaseNotes): string {
  const document = parseChangelog(changelog);
  const [heading, ...lines] = renderChangelogSection(notes).split("\n");
  document.sections.unshift({ heading, lines: trimBlank(lines) });
  return renderChangelog(document);
}

export interface PlannedBullet {
  text: string;
  area: ReturnType<typeof assignArea>;
  fileName: string;
  pullRequest?: number;
}

/** Each entry's bullets with the area and pull request its origin gives them. Pure. */
export function planBullets(entries: readonly ChangelogEntry[], origins: readonly EntryOrigin[]): PlannedBullet[] {
  const byFile = new Map(origins.map((origin) => [origin.fileName, origin]));
  return entries.flatMap((entry) => {
    const origin = byFile.get(entry.fileName);
    const area = assignArea({
      commitPaths: origin?.commitPaths,
      commitSubject: origin?.commitSubject,
      pullRequestPaths: origin?.pullRequestPaths,
    });
    return bulletsOf(entry.content).map((line) => ({
      area,
      fileName: entry.fileName,
      pullRequest: origin?.pullRequest,
      text: line.slice(2).trim(),
    }));
  });
}

/** Bullet text to pull request and author, for the GitHub Release body. */
export function attributionsOf(
  bullets: readonly PlannedBullet[],
  authors: ReadonlyMap<number, string>,
): Map<string, Attribution> {
  const attributions = new Map<string, Attribution>();
  for (const bullet of bullets) {
    if (bullet.pullRequest === undefined) continue;
    attributions.set(bullet.text, { author: authors.get(bullet.pullRequest), pullRequest: bullet.pullRequest });
  }
  return attributions;
}

/** Everything a collation reads from git, the network and the model; injectable for tests. */
export interface CollateDeps {
  trace: (fileNames: readonly string[]) => Promise<EntryOrigin[]>;
  tags: () => Promise<string[]>;
  authors: (numbers: number[]) => Promise<Map<number, string>>;
  model: ModelClient;
  log: (message: string) => void;
}

export interface RunOptions {
  /** Repository root; changelog/unreleased/ and CHANGELOG.md live under it. */
  root: string;
  /** The collation date, YYYY-MM-DD; the version's year and month come from it. */
  date: string;
  /** Preview only: print the section and the release body without touching anything. */
  dryRun: boolean;
  repository?: string;
}

export interface RunResult {
  output: string;
  /** The version the collation wrote, when it wrote one. */
  version?: string;
}

export async function readPendingEntries(root: string): Promise<ChangelogEntry[]> {
  const dir = resolve(root, UNRELEASED_DIR);
  if (!existsSync(dir)) return [];
  const fileNames = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(
    fileNames.map(async (fileName) => ({ content: await readFile(resolve(dir, fileName), "utf8"), fileName })),
  );
}

export async function run(options: RunOptions, deps: CollateDeps): Promise<RunResult> {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const entries = await readPendingEntries(options.root);
  if (entries.every((entry) => bulletsOf(entry.content).length === 0)) {
    return { output: "changelog: no pending entries, nothing to release" };
  }

  const bullets = planBullets(entries, await deps.trace(entries.map((entry) => entry.fileName)));
  const groups = groupByArea(bullets);
  const summaries = await summarize({
    groups,
    log: deps.log,
    model: deps.model,
    toneRule: await readToneRule(options.root),
  });

  const changelogPath = resolve(options.root, "CHANGELOG.md");
  const changelog = await readFile(changelogPath, "utf8");
  const tags = await deps.tags();
  const version = nextVersion(options.date, [...tags, ...versionsInChangelog(changelog)]);
  const notes: ReleaseNotes = {
    areas: groups.map((group) => ({
      area: group.area,
      bullets: group.bullets,
      summary: summaries.areaSummaries.get(group.area) ?? "",
    })),
    date: options.date,
    shortVersion: summaries.shortVersion,
    version,
  };

  const noun = entries.length === 1 ? "entry" : "entries";
  const lines = [
    `changelog: releasing ${version} from ${entries.length} ${noun} (prose by ${summaries.generatedBy})`,
    ...[...new Map(bullets.map((bullet) => [bullet.fileName, bullet])).values()].map(
      (bullet) => `  - ${bullet.fileName} -> ${bullet.area}${bullet.pullRequest ? ` (#${bullet.pullRequest})` : ""}`,
    ),
  ];

  if (options.dryRun) {
    const pulls = bullets.flatMap((bullet) => (bullet.pullRequest === undefined ? [] : [bullet.pullRequest]));
    const body = renderReleaseBody(notes, {
      attributions: attributionsOf(bullets, await deps.authors(pulls)),
      previousVersion: previousVersion(version, tags),
      repository,
    });
    lines.push(
      "",
      "===== CHANGELOG.md section =====",
      renderChangelogSection(notes),
      "",
      "===== GitHub Release body =====",
      body,
      "changelog: dry run, nothing was written, tagged or released",
    );
    return { output: lines.join("\n"), version };
  }

  await writeFile(changelogPath, insertRelease(changelog, notes));
  for (const entry of entries) await rm(resolve(options.root, UNRELEASED_DIR, entry.fileName));
  lines.push(`changelog: wrote ${version} into CHANGELOG.md and removed ${entries.length} file(s) from ${UNRELEASED_DIR}/`);
  return { output: lines.join("\n"), version };
}

export function gitDeps(root: string, repository: string, runner?: CommandRunner): CollateDeps {
  const log = (message: string) => console.error(message);
  return {
    authors: (numbers) => pullRequestAuthors({ log, numbers, repository, root, run: runner }),
    log,
    model: anthropicClient(process.env.ANTHROPIC_API_KEY),
    tags: () => listTags(root, runner),
    trace: (fileNames) => traceEntries({ fileNames, ref: "HEAD", root, run: runner }),
  };
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const root = resolve(argValue(argv, "--root") ?? resolve(import.meta.dirname, "../.."));
  const date = argValue(argv, "--date") ?? new Date().toISOString().slice(0, 10);
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const result = await run({ date, dryRun: argv.includes("--dry-run"), repository, root }, gitDeps(root, repository));
  console.log(result.output);
  if (result.version && process.env.GITHUB_OUTPUT && !argv.includes("--dry-run")) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
