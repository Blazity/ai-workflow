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
 * Per-item provenance, anchored at the very end of a bullet line and with an id
 * shape that can hold neither a space nor "-->". Item text that merely mentions
 * "<!--" somewhere else keeps it; text that happens to end in exactly this shape
 * is read as provenance, the one ambiguity the format accepts. The trailing
 * group is an optional CR, so a document stored with CRLF endings can have its
 * comments stripped without its line endings being rewritten.
 *
 * The optional " pin" is the eviction mark, carried inside this one comment
 * rather than as a marker of its own precisely because this comment is the one
 * thing a writer always appends AFTER the item's text. See `RepoMemoryItem.pinned`.
 */
const PROVENANCE_SUFFIX = / <!-- run:([A-Za-z0-9_-]+)( pin)? -->(\r?)$/;

/**
 * The same suffix, but every one of a trailing run of them. Item text that ends
 * in a provenance-shaped comment gets a second one appended at render, and the
 * pair is self-sustaining because parse hands the inner one back as text. Strip
 * takes the whole run so no marker can ride out to a prompt behind another;
 * parse keeps the single-match pattern above, where the last marker is the one
 * this format wrote.
 */
const PROVENANCE_SUFFIX_RUN = /(?: <!-- run:[A-Za-z0-9_-]+(?: pin)? -->)+(\r?)$/;

/** The same id shape, checked before writing. An id outside it is stored as no
 * provenance at all rather than as a comment that would not parse back, or one
 * carrying "-->" that would break out into text a reader treats as content. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface RepoMemoryItem {
  text: string;
  /** Run that most recently asserted this item. Null for a legacy item stored
   *  before provenance existed. */
  runId: string | null;
  /**
   * Set by a writer that derived this item from the repository itself rather
   * than from a model, which today is the deterministic package.json seed. Such
   * an item leaves the eviction path while any model-authored entry is still
   * there to give up, because it is the only kind of entry a later run cannot
   * re-derive from prose.
   *
   * Absent, never false, when the item is not marked: a stored document is
   * parsed all over this codebase and compared with `toEqual`, so an extra
   * property on every unmarked item would be a needless break.
   *
   * A model cannot claim the mark. It reaches this format as candidate text
   * only, the merge stamps what it inserts and never reads a mark out of the
   * text, and render appends its provenance comment AFTER that text, so parse,
   * which honours the last anchored comment on the line, reads render's own
   * unmarked one. The residue is an item stamped with a run id this format
   * cannot write back (see RUN_ID_PATTERN): render then emits no comment at all
   * and a text ending in a marker-shaped comment is read as one, mark included.
   * That is the same ambiguity provenance already accepts, and it needs a
   * workflow run id outside [A-Za-z0-9_-], which would have disabled provenance
   * for the whole document anyway.
   */
  pinned?: true;
}

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
  items: readonly RepoMemoryItem[];
}): string {
  const head = `# Repo ${input.kind}: ${singleLine(input.subject)}\n${REPO_MEMORY_MARKER}\n`;
  if (input.items.length === 0) return head;
  const bullets = input.items
    .map(
      (item) =>
        `${BULLET_PREFIX}${singleLine(item.text)}${provenanceSuffix(item.runId, item.pinned)}`,
    )
    .join("\n");
  return `${head}\n${bullets}\n`;
}

/** Item text is returned verbatim, without trimming, so render and parse
 * round-trip text that carries its own spacing. A document written before
 * provenance existed parses to items with a null runId and re-renders byte for
 * byte. */
export function parseRepoMemoryDocument(raw: string): RepoMemoryItem[] {
  const items: RepoMemoryItem[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith(BULLET_PREFIX)) continue;
    const body = line.slice(BULLET_PREFIX.length);
    const match = PROVENANCE_SUFFIX.exec(body);
    const text = match ? body.slice(0, match.index) : body;
    if (text.trim().length === 0) continue;
    // The key is set only when the mark is there, so an unmarked item parses
    // back to exactly the two properties it always had.
    items.push({
      text,
      runId: match ? match[1] : null,
      ...(match?.[2] === undefined ? {} : { pinned: true as const }),
    });
  }
  return items;
}

/**
 * Provenance is bookkeeping, not memory, so it must never reach the agent: this
 * is what the read path calls before a stored document is injected into a
 * prompt. Only the anchored run of suffixes goes, and "$1" puts the optional CR
 * back, so everything else stays byte for byte what the store holds.
 */
export function stripRepoMemoryProvenance(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line.startsWith(BULLET_PREFIX) ? line.replace(PROVENANCE_SUFFIX_RUN, "$1") : line,
    )
    .join("\n");
}

/**
 * Least recently confirmed first. A candidate that repeats a stored item does
 * not duplicate it and does not rewrite its spelling, but it does move it to the
 * back and re-stamp it with the confirming run, so cap pressure evicts whatever
 * no run has reasserted for longest instead of whatever was inserted first.
 * `dropped` counts only items lost to the caps and `removed` only items deleted
 * as contradicted, so merging the same input twice reports zero for both, as
 * long as the candidates alone fit the caps. A candidate list that on its own
 * exceeds them re-offers next round whatever this round evicted, so successive
 * merges alternate instead of settling. The call site bounds new entries per run
 * far below the document caps, so that case does not arise.
 */
export function mergeRepoMemoryItems(input: {
  existing: readonly RepoMemoryItem[];
  candidates: readonly string[];
  /** Entries this run observed to be false. Matching items are removed. */
  contradicted: readonly string[];
  /** Run asserting the candidates, recorded as each surviving item's provenance. */
  runId: string;
  maxItems: number;
  maxBytes: number;
  subject: string;
  kind: RepoMemoryDocKind;
}): { items: RepoMemoryItem[]; dropped: number; removed: number } {
  // Contradictions come from the same model in the same shape as candidates, so
  // they get the same hygiene before their comparison keys are taken.
  const contradicted = new Set<string>();
  for (const entry of splitCandidates(input.contradicted)) {
    const key = repoMemoryComparisonKey(entry);
    if (key.length > 0) contradicted.add(key);
  }

  // A run that both asserts and contradicts an entry has taught us nothing, so
  // that entry is stored nowhere: dropped from the candidates here, and deleted
  // from the stored items below.
  const candidateKeys = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of splitCandidates(input.candidates)) {
    const key = repoMemoryComparisonKey(candidate);
    if (key.length === 0 || contradicted.has(key) || candidateKeys.has(key)) continue;
    candidateKeys.add(key);
    candidates.push(candidate);
  }

  const unconfirmed: RepoMemoryItem[] = [];
  const confirmed: RepoMemoryItem[] = [];
  const storedKeys = new Set<string>();
  let removed = 0;
  for (const item of input.existing) {
    const key = repoMemoryComparisonKey(item.text);
    if (key.length === 0 || storedKeys.has(key)) continue;
    storedKeys.add(key);
    if (contradicted.has(key)) {
      removed += 1;
      continue;
    }
    // Confirmed items keep their order relative to each other, so merging the
    // same candidates again is a no-op rather than another reshuffle. The mark
    // rides along: it records where the item came from, and a run restating a
    // seeded fact confirms it rather than reauthoring it, so dropping the mark
    // here would let one restatement unprotect it for good.
    if (candidateKeys.has(key)) {
      confirmed.push({
        text: item.text,
        runId: input.runId,
        ...(item.pinned === true ? { pinned: true as const } : {}),
      });
    } else unconfirmed.push(item);
  }

  const items = [...unconfirmed, ...confirmed];
  for (const candidate of candidates) {
    // Already in the list as the confirmed item it matched, under the spelling
    // that was stored first.
    if (storedKeys.has(repoMemoryComparisonKey(candidate))) continue;
    items.push({ text: candidate, runId: input.runId });
  }

  let dropped = 0;
  // Least recently confirmed first, and always whole items: a truncated fact is
  // worse than a missing one. An item too large to ever fit leaves the list
  // empty. The budget is measured on the rendered document, provenance comments
  // included, because those are bytes the store has to hold.
  //
  // Marked items are ranked last. The order above is least recently confirmed
  // first only while confirmation happens, and the distill's system prompt
  // forbids the model repeating a stored entry in any wording, so nothing is
  // ever confirmed and the order degenerates to insertion order: the seed's
  // deterministically derived facts, which are always the first thing a
  // repository stores, were therefore the first thing evicted. A run reproduces
  // model prose; nothing reproduces the seed once its run is over.
  while (
    items.length > 0 &&
    (items.length > input.maxItems ||
      utf8Bytes(renderRepoMemoryDocument({ subject: input.subject, kind: input.kind, items })) >
        input.maxBytes)
  ) {
    // Ranked last, not exempt. The caps are what the store can physically hold,
    // so once only marked items are left they are evicted from the head like
    // anything else: a document over the cap cannot be written at all, and a
    // seeded fact nobody can store is worth no more than a model-authored one.
    const evictable = items.findIndex((item) => item.pinned !== true);
    items.splice(evictable === -1 ? 0 : evictable, 1);
    dropped += 1;
  }
  return { items, dropped, removed };
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

function provenanceSuffix(runId: string | null, pinned: true | undefined): string {
  // An item with no writable run id carries no comment, so it carries no mark
  // either: the format has exactly one shape a mark can be written in, and it is
  // one this parser reads back. Every writer stamps a run id, so this only ever
  // costs the mark on an item that has already lost its provenance.
  if (runId === null || !RUN_ID_PATTERN.test(runId)) return "";
  return ` <!-- run:${runId}${pinned === true ? " pin" : ""} -->`;
}

/** Keeps one item on one line. Everything else about the text is preserved. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * Comparison only: the stored text keeps whichever spelling won. Exported so a
 * caller that has to decide whether two items are the same item, such as the
 * org-scope promotion, groups them exactly the way this merge dedups them
 * instead of on a second, drifting definition.
 */
export function repoMemoryComparisonKey(item: string): string {
  // Leading bullet markers are folded because `splitCandidates` strips exactly
  // one before an item is stored, so a stored item can legitimately still carry
  // some. Every marker goes, not one: org promotion feeds an already-stripped
  // stored text back through the merge, so `splitCandidates` runs again and the
  // spelling loses another marker each round. Folding the whole run makes this
  // key a fixed point under any number of those passes, which is the property
  // promotion needs; folding one deep would only match by coincidence at
  // exactly one level of nesting.
  return item
    .trim()
    .replace(/^(?:[-*]\s+)+/, "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim()
    .toLowerCase();
}
