import { WORKSPACE_ROOT_DIR } from "../sandbox/repo-workspace.js";

/**
 * Output-side scrub for agent-authored prose on its way into a customer-visible
 * artifact: PR/MR bodies, review summaries and inline review comments, PR and
 * ticket comments.
 *
 * A prompt rule already forbids mentioning platform-managed paths and it is
 * demonstrably not enough: the same prompt mandates overwriting the session
 * memory document, so the agent reports what it was told to do, in different
 * wording every run. Removal therefore happens here, after generation, where it
 * is deterministic.
 *
 * Pure string work on purpose. This module is imported from workflow scope, so
 * it imports no Node builtin and performs no IO.
 */

/**
 * Mirrors MEMORY_DIR in workflows/memory-steps.ts. Duplicated rather than
 * imported so a lib module never depends on a workflow step module.
 */
const MEMORY_DIR = "ai-workflow/memory";
/**
 * The directory older runs wrote to. A document under it must be scrubbed just
 * like one under the new directory, so both are marked (see MARKERS below).
 */
const LEGACY_MEMORY_DIR = "blazebot/memory";

/**
 * Published in place of text that could not be scrubbed, and in place of text
 * that scrubbing emptied. One constant serves both because the reader needs the
 * same thing in both cases: a short honest note instead of a blank section or a
 * leak.
 */
export const SCRUB_PLACEHOLDER = "_No publishable content is available here._";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every marker is a shape that has no legitimate use in a customer-facing
 * artifact.
 *
 * A bare mention of the memory directory is deliberately NOT a marker: in a
 * repository that implements the directory, "changed how blazebot/memory is
 * excluded" is ordinary vocabulary, and no regex separates it from the agent's
 * own bookkeeping without guessing. Naming a document *under* the directory is
 * the marker instead. Not because such a filename can only come from the agent
 * having just written it, which is false exactly where it would matter: this
 * module's own fixtures name one, a changelog line can name a file under
 * blazebot/memory, and a quoted diff header names one twice. The reason is that
 * the two error directions fall on different populations. A false positive can
 * only occur in this repository, the only one whose source implements the
 * directory, where the deleted sentence is visible to the people who wrote it
 * and costs a review comment. A false negative lands in a customer artifact,
 * where nobody can see what was removed or ask for it back.
 *
 * The WORKSPACE_ROOT_DIR marker below is a second marker of that same shape and
 * the same asymmetry, and it over-fires here more often than the "the platform
 * blocks" phrase does, because this repository hard-codes /vercel/sandbox in
 * both source and prose. Two markers pay this cost in this repository, not one.
 */
const MARKERS: readonly RegExp[] = [
  // A document inside the platform memory directory, e.g. ai-workflow/memory/AWP-32.md.
  new RegExp(`${escapeRegExp(MEMORY_DIR)}/\\S`, "i"),
  // The same shape under the legacy directory, e.g. blazebot/memory/AWP-32.md.
  // Two markers, one per directory, rather than an alternation: clearer, and each
  // keeps the "bare mention is not a marker, only a doc under the dir fires"
  // semantics through its own /\S suffix.
  new RegExp(`${escapeRegExp(LEGACY_MEMORY_DIR)}/\\S`, "i"),
  // An absolute path inside the ephemeral sandbox. It leaks the internal
  // repository layout and means nothing to a reader of the artifact.
  new RegExp(escapeRegExp(WORKSPACE_ROOT_DIR), "i"),
  // The bookkeeping named by its subject rather than by its path. Every
  // measured leak named the memory document, but not every one named a path:
  // "Session memory has been updated for this task.", "The memory document was
  // overwritten in the workspace." Keying on the path alone catches the wording
  // we happened to observe and misses the next rewording. The cost is that a
  // pull request in this repository describing the memory feature loses those
  // sentences, which is the same repository-only cost as the discriminator
  // above.
  /\b(?:session|task)\s+memory\b/i,
  /\bmemory\s+(?:file|document|note|entry)s?\b/i,
  // "no push or PR creation was attempted", "no pull request was opened".
  /\bno\s+(?:push|pr|mr|pull request|merge request)\b[^.;!?]{0,40}\b(?:was|were)\s+(?:attempted|made|created|opened|performed|issued|pushed)\b/i,
  // "I did not push or open a PR because ...".
  /\b(?:did|do|does|will|would|have|has|had)\s+not\b[^.;!?]{0,40}\b(?:push(?:ed)?|open(?:ed)?|creat(?:e|ed)|publish(?:ed)?|rais(?:e|ed))\b[^.;!?]{0,40}\b(?:pr|mr|pull request|merge request)\b/i,
  /\b(?:didn't|don't|doesn't|won't|haven't|hasn't)\b[^.;!?]{0,40}\b(?:push(?:ed)?|open(?:ed)?|creat(?:e|ed)|publish(?:ed)?|rais(?:e|ed))\b[^.;!?]{0,40}\b(?:pr|mr|pull request|merge request)\b/i,
  // A denial of publication that is not anchored on the noun "PR", because the
  // agent does not need that noun to make the claim: "I did not publish
  // anything from the workspace." Any such denial is false by construction in
  // the artifact it is printed in, which was published.
  /\b(?:no|did not|didn't)\b[^.;!?]{0,40}\bpublish(?:e[ds]|ing)?\b/i,
  // The same claim with publication scoped to the run instead of negated:
  // "Publishing was out of scope for this run.", "I stopped short of publishing
  // anything from this run." The run exists only inside the platform, so a
  // sentence that scopes publication to it is reporting platform behaviour.
  /\bpublish(?:e[ds]|ing)?\b[^.;!?]{0,40}\b(?:this|the)\s+run\b/i,
  // "Per the workflow's Do Not Publish rule, ...".
  /\bdo not publish\b/i,
  // "the platform blocks committing files under ...", "this sandbox workflow
  // forbids publish actions". The subject is pinned to the platform or the
  // sandbox so that "the workflow prevents duplicate PR creation", a normal
  // description of a change, is left alone. A summary in this repository could
  // still say "the sandbox forbids committing X" about the code under change;
  // that false positive costs one deleted sentence, exactly what the false
  // negative would leak, and the leak is the one we measured.
  /\b(?:the|this)\s+(?:platform|sandbox)\b[^.;!?]{0,60}\b(?:blocks?|forbids?|prohibits?|prevents?|disallows?|does not allow)\b[^.;!?]{0,40}\b(?:commit\w*|push\w*|publish\w*|pr|mr|pull request|merge request)\b/i,
];

function hasMarker(text: string): boolean {
  return MARKERS.some((marker) => marker.test(text));
}

const TERMINATORS = new Set([".", ";", "!", "?"]);
const CLOSERS = new Set(["`", ")", "]", '"', "'", "*", "_"]);

/**
 * Dots that do not end a sentence. Splitting on one leaves a survivor like
 * "Ran the suite, e.g." in front of a removed sentence, which reads as a
 * truncation defect in a customer artifact.
 */
const ABBREVIATIONS = new Set(["e.g", "i.e", "vs", "no"]);

function endsAbbreviation(text: string, dotIndex: number): boolean {
  let start = dotIndex;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1]!)) start--;
  const token = text.slice(start, dotIndex).toLowerCase();
  if (token.length === 0) return false;
  // A single letter is an initial, as in "Reviewed by J. Smith".
  return ABBREVIATIONS.has(token) || /^[a-z]$/.test(token);
}

/**
 * Split text into sentence-shaped chunks, terminator and trailing spaces
 * included so that rejoining the survivors reproduces the original spacing. A
 * terminator only ends a chunk when whitespace or the text end follows it, so a
 * file extension or a version number inside a path never splits a sentence.
 */
function splitSentences(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (!TERMINATORS.has(text[index]!)) continue;
    if (text[index] === "." && endsAbbreviation(text, index)) continue;
    let end = index + 1;
    while (
      end < text.length &&
      (TERMINATORS.has(text[end]!) || CLOSERS.has(text[end]!))
    ) {
      end++;
    }
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
    chunks.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

const FENCE_LINE = /^\s{0,3}(?:```|~~~)/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
/** Lines that open a markdown block instead of continuing the previous one. */
const BLOCK_START_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\|)/;
const LEADING_LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s*/;

/**
 * A survivor worth publishing holds at least two letters once its list marker is
 * stripped. Without this, the enumerator of a removed list item survives alone,
 * because "2." is a terminator followed by a space and therefore a sentence
 * boundary, and the customer artifact gets a line reading "2.".
 */
function hasPublishableText(chunk: string): boolean {
  const letters = chunk.replace(LEADING_LIST_MARKER, "").match(/\p{L}/gu);
  return (letters?.length ?? 0) >= 2;
}

/**
 * The unit of matching is the paragraph and the unit of removal is the sentence.
 *
 * The paragraph, because agent prose arrives hard-wrapped: pr-external-resources
 * builds "- ${feedback}" out of review feedback that routinely contains
 * newlines, and every marker spans several words. Matching one line at a time
 * lets a single wrapped newline fall inside a marker's window, which publishes
 * the sentence this module exists to delete and leaves orphan fragments of the
 * lines around it.
 *
 * The sentence, because blanking the token would leave "updated session memory
 * at [removed]", which still tells the reader the agent did platform
 * bookkeeping, and it cannot touch the worst case at all: "no push or PR
 * creation was attempted" has no token to blank, only a false claim to delete.
 */
function scrubBlocks(text: string): string {
  const kept: string[] = [];
  let paragraph: string[] = [];
  // The delimiter of the fenced block currently open, null outside one.
  let fence: string | null = null;

  const flush = (): void => {
    if (paragraph.length === 0) return;
    const lines = paragraph;
    paragraph = [];
    // Newlines become spaces, so a marker and a sentence boundary read the same
    // whether the agent wrapped its prose or not.
    const joined = lines
      .map((line, index) => (index === 0 ? line.trimEnd() : line.trim()))
      .join(" ");
    if (!hasMarker(joined)) {
      // Byte-identical passthrough for the common case: the wrapping the agent
      // chose survives whenever nothing had to be removed.
      kept.push(...lines);
      return;
    }
    const survivors = splitSentences(joined).filter(
      (chunk) => !hasMarker(chunk) && hasPublishableText(chunk),
    );
    const rebuilt = survivors.join("").trimEnd();
    // Drop the paragraph outright rather than keep a blank line: a blanked
    // bullet would split the surrounding markdown list in two.
    if (rebuilt.trim() === "") return;
    kept.push(rebuilt);
  };

  for (const line of text.split("\n")) {
    if (fence !== null) {
      // Fenced content passes through untouched, delimiters included. A
      // quotation is not the agent's own report, and removing one line inside a
      // fence can delete a delimiter and leave its partner behind, which
      // renders everything after it as code in the customer's artifact.
      kept.push(line);
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (FENCE_LINE.test(line)) {
      flush();
      kept.push(line);
      fence = line.trimStart().slice(0, 3);
      continue;
    }
    if (line.trim() === "") {
      flush();
      kept.push(line);
      continue;
    }
    if (HEADING_LINE.test(line)) {
      // A heading is a one-line block: it must not absorb the paragraph under
      // it, or removing that paragraph would remove the heading with it.
      flush();
      paragraph.push(line);
      flush();
      continue;
    }
    if (BLOCK_START_LINE.test(line)) flush();
    paragraph.push(line);
  }
  flush();
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The text with its trailing blank lines removed when its last non-blank line is
 * a heading, null otherwise. A body whose final section the scrub emptied ends
 * on a title with nothing under it, and the default PR template always keeps its
 * ticket line, so the emptied-whole-text check never sees that case.
 */
function bodyEndingOnHeading(text: string): string | null {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const last = lines[lines.length - 1];
  if (last === undefined || !HEADING_LINE.test(last)) return null;
  return lines.join("\n");
}

/**
 * Total by construction: it returns a string for every input, so no publication
 * boundary can be blocked by it. On failure it publishes the placeholder rather
 * than the input, because the input is presumed unsafe. If the scrub could not
 * run there is no evidence the text is clean, and emitting it would defeat the
 * control; blocking the run instead would trade a cosmetic defect for a lost
 * run, which is the worse of the two.
 */
export function scrubForPublication(text: string): string {
  try {
    if (!hasMarker(text)) return text;
    const scrubbed = scrubBlocks(text);
    if (scrubbed.trim() === "") return SCRUB_PLACEHOLDER;
    if (scrubbed !== text) {
      const untilHeading = bodyEndingOnHeading(scrubbed);
      if (untilHeading !== null) return `${untilHeading}\n${SCRUB_PLACEHOLDER}`;
    }
    return scrubbed;
  } catch {
    return SCRUB_PLACEHOLDER;
  }
}
