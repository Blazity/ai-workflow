import { utf8Bytes } from "./content.js";

/**
 * Org-scoped routing memory: one document per organisation, a plain bullet list
 * mapping a ticket label to the repository humans resolved that label to. An
 * entry means "tickets carrying this label in this organisation were resolved to
 * this repository by a human", and nothing stronger: it is only ever consulted
 * where deterministic repository selection already declined.
 *
 * Same layout as repo-memory.ts, one line per entry behind a version marker.
 * Reached only from a Node-runtime step, never from the workflow isolate, so the
 * isolate's no-Node-builtins rule does not apply here; byte measurement still goes
 * through utf8Bytes rather than Buffer, because that is what content.js offers and
 * there is no reason to introduce a second way of counting.
 *
 * Each entry carries the identifiers of the tickets that produced it, capped at
 * MAX_ROUTING_TICKETS, because one human answer is an observation and not yet
 * evidence. Labels at a real client are frequently generic ("bug", "P2",
 * "sprint-42"), so a single answer binds those labels as readily as a meaningful
 * one, and acting on it would route an unrelated ticket that merely shares a
 * label. Requiring two DISTINCT tickets to agree is the same rule org fact
 * promotion already applies to facts, moved to testimony: independent
 * corroboration before anything crosses a boundary. The identifiers, rather than a
 * bare counter, are what make "distinct" checkable at all, and two is all that has
 * to be stored because nothing above the threshold changes a decision.
 */
export const REPO_ROUTING_DOC_PATH = "routing";

/** Version tag for the format, so a later reader can change the layout without
 * having to guess which version wrote a stored document. Parsing is line-based
 * and does not depend on it. */
const REPO_ROUTING_MARKER = "<!-- blazebot:repo-routing v1 -->";

const BULLET_PREFIX = "- ";

/**
 * Between the label and the repository. The label is human-authored and may
 * contain this sequence, so parse splits on the LAST occurrence rather than the
 * first: the repository half can never contain it, so that split round-trips a
 * label that does.
 */
const SEPARATOR = " -> ";

/**
 * A label longer than this is a description, not a label, and one oversized
 * label would push every other entry out of the document on merge. Characters,
 * not bytes, exactly like MAX_ITEM_CHARS in the facts and lessons path.
 */
export const MAX_ROUTING_LABEL_CHARS = 100;

/**
 * The repository half, checked on the way in AND on the way out. Same character
 * class and same "no empty segment" rule as the catalog's own path validation,
 * with at least one slash required, so a stored line can never carry a path
 * shaped like "..", a bare name, or anything that would not parse back as the
 * entry that was written. A label can never be read as a repository either,
 * because a label that matched this pattern would still be on the label side of
 * the last separator.
 */
const REPOSITORY_PATTERN = /^(github|gitlab):([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)$/;

/**
 * Corroborating ticket identifiers, anchored at the end of the line. Kept to a
 * shape that can hold neither a space nor a closing parenthesis, so the repository
 * half in front of it stays unambiguous, and the whole suffix is dropped rather
 * than half-read when it does not match.
 */
const TICKETS_SUFFIX = /^(\S+) \(tickets: ([^)]*)\)$/;

/** Ticket identifiers are tracker keys such as "AIW-140". Anything outside this
 *  shape, or longer than this, is not one, and is dropped rather than stored as
 *  something a later reader would count as corroboration. */
const TICKET_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

/** Per entry. Two distinct tickets are what makes an entry eligible, and nothing
 *  above the threshold changes any decision, so nothing above it is kept. */
export const MAX_ROUTING_TICKETS = 2;

/** Distinct tickets that must agree before an entry may select a repository. */
export const MIN_ROUTING_CONFIRMATIONS = 2;

export interface RepoRoutingEntry {
  /** Ticket label, single-lined, trimmed and length-capped. Matched case
   *  insensitively, because trackers are not consistent about label case. */
  label: string;
  provider: "github" | "gitlab";
  repoPath: string;
  /**
   * Distinct tickets whose human answer produced this exact label-to-repository
   * pair, newest last, at most MAX_ROUTING_TICKETS. Empty for an entry stored
   * before corroboration was recorded, which therefore reads as uncorroborated and
   * cannot select until a human confirms it again: the safe direction, and the
   * feature has never run with the flag on.
   */
  tickets: string[];
}

/** Whether an entry may select a repository, as opposed to merely be stored so a
 *  later ticket can corroborate it. */
export function isRepoRoutingEntryEligible(entry: RepoRoutingEntry): boolean {
  return entry.tickets.length >= MIN_ROUTING_CONFIRMATIONS;
}

/**
 * One line per entry, so a newline in a label would forge extra bullets and lose
 * the rest of the document on the way back. Labels are single-lined and capped
 * before they are rendered instead, and the repository half is validated, so
 * every line this writes parses back to the entry it came from.
 */
export function renderRepoRoutingDocument(input: {
  owner: string;
  entries: readonly RepoRoutingEntry[];
}): string {
  const head = `# Repo routing: ${singleLine(input.owner)}\n${REPO_ROUTING_MARKER}\n`;
  if (input.entries.length === 0) return head;
  const bullets = input.entries
    .map((entry) => {
      const tickets = normalizeRoutingTickets(entry.tickets);
      const suffix = tickets.length === 0 ? "" : ` (tickets: ${tickets.join(", ")})`;
      return `${BULLET_PREFIX}${normalizeRoutingLabel(entry.label)}${SEPARATOR}${entry.provider}:${entry.repoPath}${suffix}`;
    })
    .join("\n");
  return `${head}\n${bullets}\n`;
}

/** Anything that does not parse back as a whole entry is skipped rather than
 * repaired: a half-read routing entry could name the wrong repository, and
 * skipping one only costs a question. */
export function parseRepoRoutingDocument(raw: string): RepoRoutingEntry[] {
  const entries: RepoRoutingEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith(BULLET_PREFIX)) continue;
    const body = line.slice(BULLET_PREFIX.length);
    const separator = body.lastIndexOf(SEPARATOR);
    // 0 would be an entry with no label at all, which addresses nothing.
    if (separator <= 0) continue;
    const label = normalizeRoutingLabel(body.slice(0, separator));
    if (label.length === 0) continue;
    // The ticket suffix comes off first, so the repository half it follows is what
    // the anchored repository pattern sees.
    const tail = body.slice(separator + SEPARATOR.length).trim();
    const suffix = TICKETS_SUFFIX.exec(tail);
    const repository = routableRepository(suffix ? suffix[1]! : tail);
    if (!repository) continue;
    entries.push({
      label,
      ...repository,
      tickets: normalizeRoutingTickets((suffix?.[2] ?? "").split(",")),
    });
  }
  return entries;
}

/**
 * Oldest answer first, so cap pressure evicts whatever no human has reasserted
 * for longest. A candidate meeting the stored entry for its label does one of two
 * things, and the difference is the whole point of the corroboration rule:
 *
 * - Same repository: it CONFIRMS. The ticket identifier joins the stored ones and
 *   the entry moves to the back, so two distinct tickets agreeing is what lifts an
 *   entry to eligible. The stored label spelling is kept, exactly as the facts
 *   merge keeps the spelling that was stored first.
 * - Different repository: it CORRECTS, replacing the entry outright and starting
 *   the ticket list over. The newest human answer contradicts the stored one, so
 *   keeping the old corroboration would let a superseded answer keep selecting.
 *   Resetting means the correction has to earn eligibility again, which fails
 *   toward asking.
 *
 * `dropped` counts only entries lost to the caps, so merging the same input twice
 * reports zero, as long as the candidates alone fit. The call site bounds
 * candidates per run far below the document cap, so that case does not arise.
 */
export function mergeRepoRoutingEntries(input: {
  existing: readonly RepoRoutingEntry[];
  candidates: readonly RepoRoutingEntry[];
  maxEntries: number;
  maxBytes: number;
  owner: string;
}): { entries: RepoRoutingEntry[]; dropped: number } {
  // First candidate for a label wins, so a run that somehow offers one label
  // twice is still deterministic.
  const candidates = new Map<string, RepoRoutingEntry>();
  for (const candidate of input.candidates) {
    const label = normalizeRoutingLabel(candidate.label);
    const key = repoRoutingLabelKey(label);
    if (key.length === 0 || candidates.has(key)) continue;
    if (!isRoutableRepository(candidate)) continue;
    candidates.set(key, {
      label,
      provider: candidate.provider,
      repoPath: candidate.repoPath,
      tickets: normalizeRoutingTickets(candidate.tickets),
    });
  }

  const kept: RepoRoutingEntry[] = [];
  const merged: RepoRoutingEntry[] = [];
  const storedKeys = new Set<string>();
  for (const entry of input.existing) {
    const label = normalizeRoutingLabel(entry.label);
    const key = repoRoutingLabelKey(label);
    if (key.length === 0 || storedKeys.has(key)) continue;
    // A stored entry is re-validated on the way through: a document written by an
    // older format, or hand-edited, must not be rewritten into something this
    // parser would read differently.
    if (!isRoutableRepository(entry)) continue;
    storedKeys.add(key);
    const candidate = candidates.get(key);
    if (!candidate) {
      kept.push({
        label,
        provider: entry.provider,
        repoPath: entry.repoPath,
        tickets: normalizeRoutingTickets(entry.tickets),
      });
      continue;
    }
    candidates.delete(key);
    const sameTarget =
      candidate.provider === entry.provider &&
      candidate.repoPath.toLowerCase() === entry.repoPath.toLowerCase();
    merged.push(
      sameTarget
        ? {
            label,
            provider: entry.provider,
            repoPath: entry.repoPath,
            tickets: normalizeRoutingTickets([...entry.tickets, ...candidate.tickets]),
          }
        : candidate,
    );
  }

  const entries = [...kept, ...merged, ...candidates.values()];
  let dropped = 0;
  // Whole entries only, oldest first. A truncated routing entry could name a
  // different repository than the one the human chose, which is the one failure
  // this feature may never have.
  while (
    entries.length > 0 &&
    (entries.length > input.maxEntries ||
      utf8Bytes(renderRepoRoutingDocument({ owner: input.owner, entries })) > input.maxBytes)
  ) {
    entries.shift();
    dropped += 1;
  }
  return { entries, dropped };
}

/**
 * Every stored entry whose label the ticket carries, in stored order. Deliberately
 * NOT reduced to one entry per label: two documents can hold the same label
 * against different repositories, and collapsing that here would hide the
 * disagreement from the caller whose job is to refuse to guess. Exact duplicates
 * are collapsed, because the same answer stored twice is not a disagreement.
 */
export function repoRoutingMatches(
  entries: readonly RepoRoutingEntry[],
  labels: readonly string[],
): RepoRoutingEntry[] {
  const wanted = new Set<string>();
  for (const label of labels) {
    const key = repoRoutingLabelKey(label);
    if (key.length > 0) wanted.add(key);
  }
  if (wanted.size === 0) return [];
  const matches: RepoRoutingEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = repoRoutingLabelKey(entry.label);
    if (!wanted.has(key)) continue;
    const identity = `${key}\0${entry.provider}\0${entry.repoPath.toLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    matches.push(entry);
  }
  return matches;
}

/** Comparison only. The stored spelling keeps whichever case the tracker used. */
export function repoRoutingLabelKey(label: string): string {
  return normalizeRoutingLabel(label).toLowerCase();
}

/**
 * Ticket identifiers as they are stored: uppercased, deduplicated, anything that
 * is not a tracker key dropped, and the OLDEST dropped once the cap is reached, so
 * the newest corroboration is always the one kept. Uppercase because
 * ticketSubjectKey already treats tracker keys that way, so "aiw-1" and "AIW-1"
 * must not read as two tickets agreeing.
 */
export function normalizeRoutingTickets(tickets: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const ticket of tickets) {
    const key = ticket.trim().toUpperCase();
    if (!TICKET_PATTERN.test(key) || normalized.includes(key)) continue;
    normalized.push(key);
  }
  return normalized.slice(Math.max(0, normalized.length - MAX_ROUTING_TICKETS));
}

/** One entry stays on one line, and stays inside the length cap, whichever side
 * of the store it arrived from. */
export function normalizeRoutingLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_ROUTING_LABEL_CHARS).trim();
}

function isRoutableRepository(
  entry: Pick<RepoRoutingEntry, "provider" | "repoPath">,
): boolean {
  const repository = routableRepository(`${entry.provider}:${entry.repoPath}`);
  // Identity, not merely validity: an entry whose stored spelling differs from
  // what parse would hand back is not the entry that would be read again.
  return repository?.repoPath === entry.repoPath;
}

/**
 * The single gate every repository half passes, on the way in and on the way out.
 * `.` and `..` are legal characters inside a segment but never a whole one, which
 * the character class alone cannot express and which the catalog's own path
 * validation also refuses, so a stored entry can never name something the catalog
 * would have rejected.
 */
function routableRepository(
  value: string,
): Pick<RepoRoutingEntry, "provider" | "repoPath"> | null {
  const match = REPOSITORY_PATTERN.exec(value);
  if (!match) return null;
  const repoPath = match[2]!;
  if (repoPath.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return { provider: match[1] as RepoRoutingEntry["provider"], repoPath };
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}
