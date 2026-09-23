import { AREAS, type Area } from "./areas.ts";

/**
 * One release, in the shape both readers get: CHANGELOG.md renders it without
 * pull requests or people (the tone rule in changelog/README.md), the GitHub
 * Release renders the same text with each bullet's pull request and author.
 * CHANGELOG.md is the stored form: the release job parses the section back
 * rather than asking the model a second time, so both readers see one text.
 */

interface AreaNotes {
  area: Area;
  /** One plain sentence about the area, written by the model or the fallback. */
  summary: string;
  /** Bullet texts without the leading "- ". */
  bullets: string[];
}

export interface ShortVersionParagraph {
  area: Area;
  text: string;
}

export interface ReleaseNotes {
  version: string;
  /** Collation date, YYYY-MM-DD. */
  date: string;
  /** Empty when the model was unavailable; the section is then left out. */
  shortVersion: ShortVersionParagraph[];
  areas: AreaNotes[];
}

export interface Attribution {
  pullRequest: number;
  author?: string;
}

export const SECTION_HEADING_PATTERN = /^## (v\d{4}\.\d{2}\.\d+) \((\d{4}-\d{2}-\d{2})\)$/u;
const AREA_HEADING_PATTERN = /^### (.+)$/u;
const SHORT_VERSION_PATTERN = /^\*\*([^*]+):\*\* (.+)$/u;
const SUMMARY_PATTERN = /^_(.+)_$/u;

/** Groups bullets by area, in the order AREAS lists them, keeping entry order inside an area. */
export function groupByArea(bullets: ReadonlyArray<{ area: Area; text: string }>): Array<{ area: Area; bullets: string[] }> {
  return AREAS.map((area) => ({
    area,
    bullets: bullets.filter((bullet) => bullet.area === area).map((bullet) => bullet.text),
  })).filter((group) => group.bullets.length > 0);
}

/** The CHANGELOG.md section: no pull request numbers, no people. */
export function renderChangelogSection(notes: ReleaseNotes): string {
  const parts = [`## ${notes.version} (${notes.date})`];
  for (const paragraph of notes.shortVersion) {
    parts.push("", `**${paragraph.area}:** ${paragraph.text}`);
  }
  for (const area of notes.areas) {
    parts.push("", `### ${area.area}`, "", `_${area.summary}_`, "", ...area.bullets.map((bullet) => `- ${bullet}`));
  }
  return parts.join("\n");
}

function isArea(value: string): value is Area {
  return (AREAS as readonly string[]).includes(value);
}

/** Reads back a section renderChangelogSection wrote. `lines` starts at the `## v...` heading. */
export function parseChangelogSection(lines: readonly string[]): ReleaseNotes | undefined {
  const heading = SECTION_HEADING_PATTERN.exec(lines[0]?.trim() ?? "");
  if (!heading) return undefined;
  const notes: ReleaseNotes = { areas: [], date: heading[2], shortVersion: [], version: heading[1] };
  let current: AreaNotes | undefined;

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const areaHeading = AREA_HEADING_PATTERN.exec(line);
    if (areaHeading) {
      const name = areaHeading[1];
      current = { area: isArea(name) ? name : "Other", bullets: [], summary: "" };
      notes.areas.push(current);
      continue;
    }
    if (!current) {
      const paragraph = SHORT_VERSION_PATTERN.exec(line);
      if (paragraph && isArea(paragraph[1])) notes.shortVersion.push({ area: paragraph[1], text: paragraph[2] });
      continue;
    }
    if (line.startsWith("- ")) {
      current.bullets.push(line.slice(2));
      continue;
    }
    const summary = SUMMARY_PATTERN.exec(line);
    if (summary && !current.summary) current.summary = summary[1];
  }
  return notes;
}

function withAttribution(text: string, repository: string, attribution: Attribution | undefined): string {
  if (!attribution) return text;
  const pull = `[#${attribution.pullRequest}](https://github.com/${repository}/pull/${attribution.pullRequest})`;
  const author = attribution.author
    ? ` by [@${attribution.author}](https://github.com/${attribution.author})`
    : "";
  return `${text} (in ${pull}${author})`;
}

/**
 * The GitHub Release body, in the shape of Orca's releases: a plain opening,
 * the short version, a rule, then per area an italic summary and bullets that
 * name their pull request and author. `attributions` is keyed by bullet text.
 */
export function renderReleaseBody(
  notes: ReleaseNotes,
  options: { repository: string; previousVersion?: string; attributions: ReadonlyMap<string, Attribution> },
): string {
  const since = options.previousVersion ? ` since ${options.previousVersion}` : "";
  const parts = [`What reached AI Workflow users${since}, collected on ${notes.date}.`];

  if (notes.shortVersion.length > 0) {
    parts.push("", "## The short version");
    for (const paragraph of notes.shortVersion) parts.push("", `**${paragraph.area}:** ${paragraph.text}`);
  }
  parts.push("", "---");

  for (const area of notes.areas) {
    parts.push("", `### ${area.area}`, "", `*${area.summary}*`, "");
    for (const bullet of area.bullets) {
      parts.push(`* ${withAttribution(bullet, options.repository, options.attributions.get(bullet))}`);
    }
  }

  const full = options.previousVersion
    ? `https://github.com/${options.repository}/compare/${options.previousVersion}...${notes.version}`
    : `https://github.com/${options.repository}/commits/${notes.version}`;
  parts.push("", `**Full Changelog**: ${full}`);
  return `${parts.join("\n")}\n`;
}
