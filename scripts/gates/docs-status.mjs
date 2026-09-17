#!/usr/bin/env node
/**
 * Docs-status gate.
 *
 * Why: documentation rots silently. A file that is linked and read is trusted,
 * so a stale document is worse than a missing one. This gate makes currency a
 * property the repository can check: every document declares its own status and
 * the date someone last verified it, and a document claiming to be current has
 * to be both fresh and findable. The taxonomy and the reasoning are
 * docs/adr/ADR-005-documentation-taxonomy.md.
 *
 * What it checks, for every Markdown document under DOCS_ROOT outside
 * SKIPPED_DOC_DIRS, under apps/<app>/docs/, for each apps/<app>/AGENTS.md, for
 * PACKAGES_AGENTS, and for each file in ROOT_DOCUMENTS:
 *   1. the first two lines are `Status: <value>` and `Last-verified: YYYY-MM-DD`;
 *   2. `Status:` is `current`, `draft`, or `superseded-by <path>` naming a file
 *      that exists;
 *   3. a `current` document was verified within the last MAX_AGE_DAYS days;
 *   4. a `current` document is reachable within MAX_HOPS Markdown link hops
 *      from one of ENTRY_POINTS (docs/index.md is the usual first hop).
 *
 * The lists and limits are named here, not copied: the constants below are the
 * only place they are written. A copy in this comment is a second list to keep
 * in step, and it already fell out of step once, naming three root documents
 * while ROOT_DOCUMENTS held four.
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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";

const gate = {
    DOCS_ROOT: "docs",
    EMPTY_COUNT: 0,
    ENTRY_HOP: 0,
    ENTRY_POINTS: ["README.md", "AGENTS.md"],
    EXIT_FAILURE: 1,
    HEADER_LINE_COUNT: 2,
    HOP_STEP: 1,
    LEADING_SLASH_LENGTH: 1,
    MAX_AGE_DAYS: 90,
    MAX_HOPS: 2,
    MIN_AGE_DAYS: 0,
    MS_PER_DAY: 86_400_000,
    PACKAGES_AGENTS: "packages/AGENTS.md",
    ROOT_DOCUMENTS: ["README.md", "AGENTS.md", "SETUP.md", "CONTEXT.md"],
    SKIPPED_DOC_DIRS: ["docs/archive", "docs/research"],
    TODAY: (() => {
      const evaluatedAt = new Date();
      return new Date(
        Date.UTC(evaluatedAt.getUTCFullYear(), evaluatedAt.getUTCMonth(), evaluatedAt.getUTCDate()),
      );
    })(),
    ageInDays(isoDate) {
      const parsedDate = new Date(`${isoDate}T00:00:00Z`);
      return Math.floor((gate.TODAY.getTime() - parsedDate.getTime()) / gate.MS_PER_DAY);
    },
    appDocuments() {
      const appsDir = nodePath.join(gate.repoRoot, "apps"),
        docs = [];
      if (existsSync(appsDir)) {
        for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            docs.push(...gate.listMarkdown(`apps/${entry.name}/docs`));
            /*
             * Per-app agent instructions live beside the app, not under docs/, and
             * they are read on every session in that directory. Unchecked, they are
             * the easiest documents in the repository to leave stale.
             */
            const appAgents = `apps/${entry.name}/AGENTS.md`;
            if (existsSync(nodePath.join(gate.repoRoot, appAgents))) {
              docs.push(appAgents);
            }
          }
        }
      }
      return docs;
    },
    checkedDocuments() {
      const docs = gate.docsTreeDocuments();
      docs.push(...gate.appDocuments(), ...gate.rootDocuments());
      if (existsSync(nodePath.join(gate.repoRoot, gate.PACKAGES_AGENTS))) docs.push(gate.PACKAGES_AGENTS);
      return [...new Set(docs)].toSorted();
    },
    collectFailures(path, reachableMap) {
      const header = gate.parseHeader(path);
      if (header.skipped) {
        return [];
      }
      return gate.headerFailures(path, header, reachableMap);
    },
    currentFailures(path, header, reachableMap) {
      const age = gate.ageInDays(header.verified),
        found = [];
      if (age > gate.MAX_AGE_DAYS) {
        found.push(
          `${path}: Status is current but Last-verified ${header.verified} is ${age} days old (limit ${gate.MAX_AGE_DAYS}). Re-verify and restamp it, mark it superseded-by, or archive it.`,
        );
      }
      if (!reachableMap.has(path)) {
        found.push(
          `${path}: Status is current but nothing reaches it within ${gate.MAX_HOPS} link hops from ${gate.ENTRY_POINTS.join(" or ")}. Link it from docs/index.md.`,
        );
      }
      return found;
    },
    dateFailures(path, header, reachableMap) {
      const age = gate.ageInDays(header.verified);
      if (Number.isNaN(age)) {
        return [`${path}: Last-verified "${header.verified}" is not a real date`];
      }
      return gate.statusFailures(path, header, reachableMap);
    },
    /** Everything under docs/ the gate is responsible for, archives aside. */
    docsTreeDocuments() {
      return gate.listMarkdown(gate.DOCS_ROOT).filter(
        (path) => !gate.SKIPPED_DOC_DIRS.some((dir) => path.startsWith(`${dir}/`)),
      );
    },
    expandFrontier(seen, frontier, hop) {
      const next = [];
      for (const path of frontier) {
        const absolute = nodePath.join(gate.repoRoot, path);
        if (existsSync(absolute) && statSync(absolute).isFile()) {
          for (const target of gate.markdownLinks(path, readFileSync(absolute, "utf8"))) {
            if (!seen.has(target)) {
              seen.set(target, hop);
              next.push(target);
            }
          }
        }
      }
      return next;
    },
    /** How many of the checked documents were skipped for having frontmatter. */
    frontmatterSkipped(paths) {
      return paths.filter((path) => gate.parseHeader(path).skipped).length;
    },
    hasFrontmatter(text) {
      return text.startsWith("---\n") || text.startsWith("---\r\n");
    },
    headerFailures(path, header, reachableMap) {
      const formatFailure = gate.headerFormatFailure(path, header);
      if (formatFailure.length > gate.EMPTY_COUNT) {
        return formatFailure;
      }
      return gate.dateFailures(path, header, reachableMap);
    },
    headerFormatFailure(path, header) {
      if (!header.hasStatus) {
        return [`${path}: first line must be "Status: current|draft|superseded-by <path>"`];
      }
      if (!header.hasVerified) {
        return [`${path}: second line must be "Last-verified: YYYY-MM-DD"`];
      }
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(header.verified)) {
        return [`${path}: Last-verified "${header.verified}" is not YYYY-MM-DD`];
      }
      return [];
    },
    linkTarget(fromPath, withoutAnchor) {
      if (withoutAnchor.startsWith("/")) {
        return withoutAnchor.slice(gate.LEADING_SLASH_LENGTH);
      }
      return nodePath.posix.normalize(
        nodePath.posix.join(nodePath.posix.dirname(fromPath), withoutAnchor),
      );
    },
    listMarkdown(relativeDir) {
      const absoluteDir = nodePath.join(gate.repoRoot, relativeDir),
        found = [];
      if (existsSync(absoluteDir)) {
        for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
          const childRelative = nodePath.posix.join(relativeDir, entry.name);
          if (entry.isDirectory()) {
            found.push(...gate.listMarkdown(childRelative));
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            found.push(childRelative);
          }
        }
      }
      return found;
    },
    /** Markdown links to local .md files, with anchors and titles removed. */
    markdownLinks(fromPath, text) {
      const targets = new Set();
      for (const match of text.matchAll(/\]\((?<url>[^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
        const { url: raw } = match.groups;
        if (!/^[a-z]+:/iu.test(raw) && !raw.startsWith("#")) {
          const [withoutAnchor] = raw.split("#");
          if (withoutAnchor.endsWith(".md")) {
            targets.add(gate.linkTarget(fromPath, withoutAnchor));
          }
        }
      }
      return [...targets];
    },
    /** The anchors that are not on disk, so the refusal can name them. */
    missingAnchors() {
      return gate.requiredAnchors().filter(
        (path) => !existsSync(nodePath.join(gate.repoRoot, path)),
      );
    },
    parseHeader(path) {
      const text = readFileSync(nodePath.join(gate.repoRoot, path), "utf8");
      if (gate.hasFrontmatter(text)) {
        return { skipped: true };
      }
      return gate.parsedHeaderFields(text);
    },
    parsedHeaderFields(text) {
      const [statusLine = "", verifiedLine = ""] = text.split("\n", gate.HEADER_LINE_COUNT),
        hasStatus = statusLine.startsWith("Status: "),
        hasVerified = verifiedLine.startsWith("Last-verified: ");
      let status = "",
        verified = "";
      if (hasStatus) {
        status = statusLine.slice("Status: ".length).trim();
      }
      if (hasVerified) {
        verified = verifiedLine.slice("Last-verified: ".length).trim();
      }
      return { hasStatus, hasVerified, skipped: false, status, text, verified };
    },
    reachableWithinHops() {
      const seen = new Map();
      let frontier = [];
      for (const entry of gate.ENTRY_POINTS) {
        if (existsSync(nodePath.join(gate.repoRoot, entry))) {
          seen.set(entry, gate.ENTRY_HOP);
          frontier.push(entry);
        }
      }
      for (let hop = gate.HOP_STEP; hop <= gate.MAX_HOPS; hop += gate.HOP_STEP) {
        frontier = gate.expandFrontier(seen, frontier, hop);
      }
      return seen;
    },
    repoRoot: nodePath.resolve(import.meta.dirname, "..", ".."),
    /*
     * The paths the checked set is computed from, built from the constants that
     * already name them rather than written out a second time. Each one used to
     * be dropped with existsSync, so a renamed document left the set silently
     * and the gate reported a clean run over what remained.
     */
    requiredAnchors() {
      return [...gate.ROOT_DOCUMENTS, gate.PACKAGES_AGENTS, gate.DOCS_ROOT];
    },
    rootDocuments() {
      const docs = [];
      for (const path of gate.ROOT_DOCUMENTS) {
        if (existsSync(nodePath.join(gate.repoRoot, path))) {
          docs.push(path);
        }
      }
      return docs;
    },
    statusFailures(path, header, reachableMap) {
      const age = gate.ageInDays(header.verified),
        found = [];
      if (age < gate.MIN_AGE_DAYS) {
        found.push(`${path}: Last-verified "${header.verified}" is in the future`);
      }
      if (header.status === "current") {
        found.push(...gate.currentFailures(path, header, reachableMap));
      } else if (header.status === "draft") {
        // A draft carries no currency or reachability claim.
      } else if (header.status.startsWith("superseded-by ")) {
        found.push(...gate.supersededFailures(path, header));
      } else {
        found.push(
          `${path}: Status "${header.status}" is not one of current, draft, superseded-by <path>`,
        );
      }
      return found;
    },
    supersededFailures(path, header) {
      const target = header.status.slice("superseded-by ".length).trim();
      if (!target) {
        return [`${path}: superseded-by needs the path of the document that replaced it`];
      }
      if (!existsSync(nodePath.join(gate.repoRoot, target))) {
        return [`${path}: superseded-by "${target}" does not exist`];
      }
      return [];
    },
  },
  { console: nodeConsole, process: nodeProcess } = globalThis,
  missing = gate.missingAnchors();

if (missing.length > gate.EMPTY_COUNT) {
  nodeConsole.error(
    `docs-status: the set of checked documents is computed from paths that are missing: ${missing.join(", ")}. Documentation currency is unproven until each is restored or the gate is pointed at where it moved.`,
  );
  nodeProcess.exit(gate.EXIT_FAILURE);
}

if (gate.docsTreeDocuments().length === gate.EMPTY_COUNT) {
  nodeConsole.error(
    `docs-status: 0 Markdown documents were found under ${gate.DOCS_ROOT}/, so documentation currency is unproven. The gate had nothing to look at there.`,
  );
  nodeProcess.exit(gate.EXIT_FAILURE);
}

const hopMap = gate.reachableWithinHops(),
  checked = gate.checkedDocuments(),
  problems = checked.flatMap((path) => gate.collectFailures(path, hopMap));

if (problems.length > gate.EMPTY_COUNT) {
  nodeConsole.error(`docs-status: ${problems.length} problem(s)`);
  for (const problem of problems) {
    nodeConsole.error(`  ${problem}`);
  }
  nodeProcess.exit(gate.EXIT_FAILURE);
}

nodeConsole.log(
  `docs-status: ${checked.length} document(s) checked, ${gate.frontmatterSkipped(checked)} skipped for frontmatter; every checked document has a valid, current, reachable header`,
);
