import { utf8Bytes } from "./content.js";

/**
 * Repository-scoped agent memory: two documents per repo, both plain bullet
 * lists. Reachable from workflow scope, so no Node builtins at module scope,
 * byte measurement goes through utf8Bytes.
 */
export type RepoMemoryDocKind = "facts" | "lessons";

export const REPO_MEMORY_DOC_PATHS: readonly RepoMemoryDocKind[] = ["facts", "lessons"];

/** Version tag for the format, so a later reader can change the layout without
 * having to guess which version wrote a stored document. Parsing is line-based
 * and does not depend on it. */
const REPO_MEMORY_MARKER = "<!-- blazebot:repo-memory v1 -->";

const BULLET_PREFIX = "- ";

/**
 * One line per item, so a newline inside an item or the subject would forge
 * extra bullets and lose the rest of the text on the way back. Line breaks are
 * collapsed to spaces here instead: the round trip is exact for newline-free
 * items, and lossy input degrades to one readable bullet rather than to silent
 * data loss.
 */
export function renderRepoMemoryDocument(input: {
  subject: string;
  kind: RepoMemoryDocKind;
  items: readonly string[];
}): string {
  const head = `# Repo ${input.kind}: ${singleLine(input.subject)}\n${REPO_MEMORY_MARKER}\n`;
  if (input.items.length === 0) return head;
  const bullets = input.items.map((item) => `${BULLET_PREFIX}${singleLine(item)}`).join("\n");
  return `${head}\n${bullets}\n`;
}

/** Items are returned verbatim, without trimming, so render and parse round-trip
 * text that carries its own spacing. */
export function parseRepoMemoryDocument(raw: string): string[] {
  const items: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith(BULLET_PREFIX)) continue;
    const item = line.slice(BULLET_PREFIX.length);
    if (item.trim().length === 0) continue;
    items.push(item);
  }
  return items;
}

/**
 * Existing items keep their position and their original spelling; candidates
 * that say the same thing are dropped rather than rewriting what is already
 * stored. `dropped` counts only items lost to the caps, so a repeated merge of
 * candidates that already fit reports zero.
 */
export function mergeRepoMemoryItems(input: {
  existing: readonly string[];
  candidates: readonly string[];
  maxItems: number;
  maxBytes: number;
  subject: string;
  kind: RepoMemoryDocKind;
}): { items: string[]; dropped: number } {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of [...input.existing, ...splitCandidates(input.candidates)]) {
    const key = comparisonKey(item);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  let dropped = 0;
  // Oldest first, and always whole items: a truncated fact is worse than a
  // missing one. An item too large to ever fit leaves the list empty.
  while (
    items.length > 0 &&
    (items.length > input.maxItems ||
      utf8Bytes(renderRepoMemoryDocument({ subject: input.subject, kind: input.kind, items })) >
        input.maxBytes)
  ) {
    items.shift();
    dropped += 1;
  }
  return { items, dropped };
}

/** A candidate may arrive from a model as a multi-line bullet list, so every
 * line becomes its own item. */
function splitCandidates(candidates: readonly string[]): string[] {
  const items: string[] = [];
  for (const candidate of candidates) {
    for (const line of candidate.split(/\r?\n/)) {
      const item = line.replace(/^\s*[-*]\s+/, "").trim();
      if (item.length > 0) items.push(item);
    }
  }
  return items;
}

/** Keeps one item on one line. Everything else about the text is preserved. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/** Comparison only: the stored text keeps whichever spelling won. */
function comparisonKey(item: string): string {
  return item.trim().replace(/\s+/g, " ").replace(/\.$/, "").trim().toLowerCase();
}
