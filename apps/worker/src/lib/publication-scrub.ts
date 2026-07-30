import { WORKSPACE_ROOT_DIR } from "../sandbox/repo-workspace.js";

/**
 * Output-side scrub for agent-authored prose on its way into a customer-visible
 * artifact: PR/MR bodies, review summaries and inline review comments, PR
 * comments.
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
const MEMORY_DIR = "blazebot/memory";

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
 * artifact. A bare mention of the memory directory is deliberately NOT a marker:
 * in a repository that implements the directory, "changed how blazebot/memory is
 * excluded" is ordinary vocabulary, and no regex separates it from the agent's
 * own bookkeeping without guessing. Naming a document *under* the directory is
 * separable, because that filename only exists because the agent just wrote it.
 */
const MARKERS: readonly RegExp[] = [
  // A document inside the platform memory directory, e.g. blazebot/memory/AWP-32.md.
  new RegExp(`${escapeRegExp(MEMORY_DIR)}/\\S`, "i"),
  // An absolute path inside the ephemeral sandbox. It leaks the internal
  // repository layout and means nothing to a reader of the artifact.
  new RegExp(escapeRegExp(WORKSPACE_ROOT_DIR), "i"),
  // "no push or PR creation was attempted", "no pull request was opened".
  /\bno\s+(?:push|pr|mr|pull request|merge request)\b[^.;!?]{0,40}\b(?:was|were)\s+(?:attempted|made|created|opened|performed|issued|pushed)\b/i,
  // "I did not push or open a PR because ...".
  /\b(?:did|do|does|will|would|have|has|had)\s+not\b[^.;!?]{0,40}\b(?:push(?:ed)?|open(?:ed)?|creat(?:e|ed)|publish(?:ed)?|rais(?:e|ed))\b[^.;!?]{0,40}\b(?:pr|mr|pull request|merge request)\b/i,
  /\b(?:didn't|don't|doesn't|won't|haven't|hasn't)\b[^.;!?]{0,40}\b(?:push(?:ed)?|open(?:ed)?|creat(?:e|ed)|publish(?:ed)?|rais(?:e|ed))\b[^.;!?]{0,40}\b(?:pr|mr|pull request|merge request)\b/i,
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
 * Split one line into sentence-shaped chunks, terminator and trailing spaces
 * included so that rejoining the survivors reproduces the original spacing. A
 * terminator only ends a chunk when whitespace or the line end follows it, so a
 * file extension or a version number inside a path never splits a sentence.
 */
function splitSentences(line: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let index = 0; index < line.length; index++) {
    if (!TERMINATORS.has(line[index]!)) continue;
    let end = index + 1;
    while (
      end < line.length &&
      (TERMINATORS.has(line[end]!) || CLOSERS.has(line[end]!))
    ) {
      end++;
    }
    if (end < line.length && !/\s/.test(line[end]!)) continue;
    while (end < line.length && (line[end] === " " || line[end] === "\t")) end++;
    chunks.push(line.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < line.length) chunks.push(line.slice(start));
  return chunks;
}

/**
 * The unit of removal is the sentence, not the token. Blanking the token would
 * leave "updated session memory at [removed]", which still tells the reader the
 * agent did platform bookkeeping, and it cannot touch the worst case at all:
 * "no push or PR creation was attempted" has no token to blank, only a false
 * claim to delete.
 */
function scrubLines(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (!hasMarker(line)) {
      kept.push(line);
      continue;
    }
    const survivors = splitSentences(line).filter((chunk) => !hasMarker(chunk));
    const rebuilt = survivors.join("").trimEnd();
    // Drop the line outright rather than keep a blank one: a blanked bullet
    // would split the surrounding markdown list in two.
    if (rebuilt.trim() === "") continue;
    kept.push(rebuilt);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
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
    const scrubbed = scrubLines(text);
    if (scrubbed.trim() === "") return SCRUB_PLACEHOLDER;
    return scrubbed;
  } catch {
    return SCRUB_PLACEHOLDER;
  }
}
