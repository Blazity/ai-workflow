#!/usr/bin/env node
/**
 * docs-status gate.
 *
 * Why: documentation rots silently. A file that is linked and read is trusted,
 * so a stale document is worse than a missing one. This gate makes currency a
 * property the repository can check: every document declares its own status and
 * the date someone last verified it, and a document claiming to be current has
 * to be both fresh and findable. The taxonomy and the reasoning are
 * docs/adr/ADR-005-documentation-taxonomy.md.
 *
 * What it checks, for every Markdown document under docs/ (except docs/archive/
 * and docs/research/), under apps/<app>/docs/, for each apps/<app>/AGENTS.md,
 * and for README.md, AGENTS.md and SETUP.md at the repository root:
 *   1. the first two lines are `Status: <value>` and `Last-verified: YYYY-MM-DD`;
 *   2. `Status:` is `current`, `draft`, or `superseded-by <path>` naming a file
 *      that exists;
 *   3. a `current` document was verified within the last 90 days;
 *   4. a `current` document is reachable within two Markdown link hops from
 *      README.md or AGENTS.md (docs/index.md is the usual first hop).
 *
 * Files that begin with YAML frontmatter are skipped: a release note or a
 * SKILL.md is a published artifact with its own required first lines and its
 * own consumer, not a repository document.
 *
 * Exit: 1 when any check above fails, printing one line per failure with the
 * file path; 0 when every checked document passes.
 *
 * Usage: node scripts/gates/docs-status.mjs   (from the repository root)
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_AGE_DAYS = 90;
const MAX_HOPS = 2;
const ROOT_DOCUMENTS = ["README.md", "AGENTS.md", "SETUP.md", "CONTEXT.md"];
const ENTRY_POINTS = ["README.md", "AGENTS.md"];
const SKIPPED_DOC_DIRS = ["docs/archive", "docs/research"];
const now = new Date();
const TODAY = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
);

function toRepoPath(absolutePath) {
  return relative(repoRoot, absolutePath).split("\\").join("/");
}

function listMarkdown(relativeDir) {
  const absoluteDir = join(repoRoot, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  const found = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const childRelative = posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listMarkdown(childRelative));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(childRelative);
    }
  }
  return found;
}

function checkedDocuments() {
  const docs = listMarkdown("docs").filter(
    (path) => !SKIPPED_DOC_DIRS.some((dir) => path.startsWith(`${dir}/`)),
  );
  const appsDir = join(repoRoot, "apps");
  if (existsSync(appsDir)) {
    for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      docs.push(...listMarkdown(`apps/${entry.name}/docs`));
      // Per-app agent instructions live beside the app, not under docs/, and
      // they are read on every session in that directory. Unchecked, they are
      // the easiest documents in the repository to leave stale.
      const appAgents = `apps/${entry.name}/AGENTS.md`;
      if (existsSync(join(repoRoot, appAgents))) docs.push(appAgents);
    }
  }
  for (const path of ROOT_DOCUMENTS) {
    if (existsSync(join(repoRoot, path))) docs.push(path);
  }
  return [...new Set(docs)].sort();
}

function hasFrontmatter(text) {
  return text.startsWith("---\n") || text.startsWith("---\r\n");
}

function parseHeader(path) {
  const text = readFileSync(join(repoRoot, path), "utf8");
  if (hasFrontmatter(text)) return { skipped: true };
  const [statusLine = "", verifiedLine = ""] = text.split("\n", 2);
  const status = statusLine.startsWith("Status: ")
    ? statusLine.slice("Status: ".length).trim()
    : null;
  const verified = verifiedLine.startsWith("Last-verified: ")
    ? verifiedLine.slice("Last-verified: ".length).trim()
    : null;
  return { skipped: false, text, status, verified };
}

function ageInDays(isoDate) {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  return Math.floor((TODAY.getTime() - parsed.getTime()) / 86_400_000);
}

/** Markdown links to local .md files, with anchors and titles removed. */
function markdownLinks(fromPath, text) {
  const targets = new Set();
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1];
    if (/^[a-z]+:/i.test(raw) || raw.startsWith("#")) continue;
    const withoutAnchor = raw.split("#")[0];
    if (!withoutAnchor.endsWith(".md")) continue;
    const target = withoutAnchor.startsWith("/")
      ? withoutAnchor.slice(1)
      : posix.normalize(posix.join(posix.dirname(fromPath), withoutAnchor));
    targets.add(target);
  }
  return [...targets];
}

function reachableWithinHops() {
  const seen = new Map();
  let frontier = [];
  for (const entry of ENTRY_POINTS) {
    if (existsSync(join(repoRoot, entry))) {
      seen.set(entry, 0);
      frontier.push(entry);
    }
  }
  for (let hop = 1; hop <= MAX_HOPS; hop += 1) {
    const next = [];
    for (const path of frontier) {
      const absolute = join(repoRoot, path);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
      for (const target of markdownLinks(path, readFileSync(absolute, "utf8"))) {
        if (seen.has(target)) continue;
        seen.set(target, hop);
        next.push(target);
      }
    }
    frontier = next;
  }
  return seen;
}

const failures = [];
const reachable = reachableWithinHops();

for (const path of checkedDocuments()) {
  const header = parseHeader(path);
  if (header.skipped) continue;

  if (header.status === null) {
    failures.push(`${path}: first line must be "Status: current|draft|superseded-by <path>"`);
    continue;
  }
  if (header.verified === null) {
    failures.push(`${path}: second line must be "Last-verified: YYYY-MM-DD"`);
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(header.verified)) {
    failures.push(`${path}: Last-verified "${header.verified}" is not YYYY-MM-DD`);
    continue;
  }
  const age = ageInDays(header.verified);
  if (Number.isNaN(age)) {
    failures.push(`${path}: Last-verified "${header.verified}" is not a real date`);
    continue;
  }
  if (age < 0) {
    failures.push(`${path}: Last-verified "${header.verified}" is in the future`);
  }

  if (header.status === "current") {
    if (age > MAX_AGE_DAYS) {
      failures.push(
        `${path}: Status is current but Last-verified ${header.verified} is ${age} days old (limit ${MAX_AGE_DAYS}). Re-verify and restamp it, mark it superseded-by, or archive it.`,
      );
    }
    const hops = reachable.get(path);
    if (hops === undefined) {
      failures.push(
        `${path}: Status is current but nothing reaches it within ${MAX_HOPS} link hops from ${ENTRY_POINTS.join(" or ")}. Link it from docs/index.md.`,
      );
    }
  } else if (header.status === "draft") {
    // A draft carries no currency or reachability claim.
  } else if (header.status.startsWith("superseded-by ")) {
    const target = header.status.slice("superseded-by ".length).trim();
    if (!target) {
      failures.push(`${path}: superseded-by needs the path of the document that replaced it`);
    } else if (!existsSync(join(repoRoot, target))) {
      failures.push(`${path}: superseded-by "${target}" does not exist`);
    }
  } else {
    failures.push(
      `${path}: Status "${header.status}" is not one of current, draft, superseded-by <path>`,
    );
  }
}

if (failures.length > 0) {
  console.error(`docs-status: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("docs-status: every checked document has a valid, current, reachable header");
