import type {
  ReviewLedgerDurableFeedEntry,
  ReviewLedgerDurableState,
  ReviewLedgerRejection,
  ReviewLedgerState,
  ReviewLedgerVerification,
  ReviewThread,
  ReviewThreadDisposition,
  ReviewThreadFeed,
  ReviewThreadTarget,
} from "../adapters/vcs/types.js";
import { isReviewLedgerWorkItem, reviewLedgerMarker } from "../lib/vcs-bot-identity.js";

/**
 * Pure review ledger logic: which unresolved threads are work items, whether
 * the agent's dispositions survive verification, which gate that implies, and
 * what we later write back into each thread. No I/O lives here; file reads are
 * injected so the same rules run in tests, in the ticket path and in the fix
 * loop.
 */

/**
 * Work items are the threads still waiting on us. Delegates to the adapters'
 * own predicate so the prompt, the verifier, the failure note and the feed's
 * work/context split can never disagree about what the agent owes an answer
 * to: that drift is exactly what once made the publish guard demand a
 * disposition for the bot's own run-summary note.
 */
export function selectWorkItems(feed: ReviewThreadFeed): ReviewThread[] {
  return feed.threads.filter((thread) => isReviewLedgerWorkItem(thread));
}

// Inline evidence has to sit near the commented line, so a model cannot point
// at an unrelated sentence elsewhere in the same file and call it a fix.
const EVIDENCE_LINE_WINDOW = 40;

// A quote like "}" or a bare heading exists in almost every file, so it proves
// nothing about the review request. These floors are what turns the quote into
// evidence rather than a token that happens to be present.
const MIN_EVIDENCE_QUOTE_CHARS = 20;
const MIN_EVIDENCE_QUOTE_WORDS = 3;
const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"];

export interface VerifyDispositionsInput {
  workItems: ReviewThread[];
  dispositions: ReviewThreadDisposition[];
  readFile: (filePath: string) => Promise<string | null>;
  /**
   * Aliases the feed carries as context only: threads awaiting a human and third
   * party bots' threads. The prompt shows them, so a model that answers one is
   * confused, not wrong about a thread that does not exist, and the run must not
   * die over it.
   */
  contextAliases?: readonly string[];
}

/** The one rejection a missing workspace clone can produce, and therefore the
 * one that a "could not read anything" run is allowed to take back. */
const EVIDENCE_FILE_NOT_FOUND = "evidence file not found";

/**
 * Deterministic check of what the agent claimed per thread. Two production
 * incidents shape the rules: a planner that declared work "already resolved"
 * and skipped an explicit review request, and a cheap model that mapped new
 * requests onto adjacent existing sentences and reported "ready, no
 * implementation needed". Hence already_addressed has to name a file and a
 * literal quote that is really there, near the commented line, and can never
 * answer our own bot's thread.
 */
export async function verifyDispositions(
  input: VerifyDispositionsInput,
): Promise<ReviewLedgerVerification> {
  const accepted: ReviewThreadDisposition[] = [];
  const rejected: ReviewLedgerRejection[] = [];
  const ignoredContextAliases: string[] = [];
  const aliases = new Set(input.workItems.map((item) => item.alias));
  const contextAliases = new Set(input.contextAliases ?? []);

  // Counted rather than inspected one read at a time: one unreadable file is a
  // wrong path from the model, every read unreadable is a workspace without the
  // PR's repository in it, and only the second may excuse the model.
  let reads = 0;
  let unreadable = 0;
  const readFile = async (filePath: string): Promise<string | null> => {
    reads += 1;
    const content = await input.readFile(filePath);
    if (content === null) unreadable += 1;
    return content;
  };

  for (const item of input.workItems) {
    const matches = input.dispositions.filter((d) => d.alias === item.alias);
    if (matches.length === 0) {
      rejected.push({ alias: item.alias, reason: "no disposition" });
      continue;
    }
    if (matches.length > 1) {
      // No "first one wins": two answers for one thread means the agent lost
      // track of the ledger, so the whole alias goes back for a retry.
      rejected.push({ alias: item.alias, reason: "duplicate disposition" });
      continue;
    }
    const disposition = matches[0]!;
    const reason = await rejectionReason(item, disposition, readFile);
    if (reason) {
      rejected.push({ alias: item.alias, reason });
      continue;
    }
    // Aliases are positional, so a feed we re-read later can hand T1 to a
    // different thread. Settlement follows this stamp, not the alias.
    accepted.push({ ...disposition, threadId: item.threadId });
  }

  for (const disposition of input.dispositions) {
    if (aliases.has(disposition.alias)) continue;
    if (contextAliases.has(disposition.alias)) {
      ignoredContextAliases.push(disposition.alias);
      continue;
    }
    rejected.push({ alias: disposition.alias, reason: "unknown alias" });
  }

  const verification: ReviewLedgerVerification = { accepted, rejected };
  if (ignoredContextAliases.length > 0) {
    verification.ignoredContextAliases = ignoredContextAliases;
  }
  return reads > 0 && unreadable === reads
    ? withUnavailableEvidence(verification, input)
    : verification;
}

/**
 * Nothing on the branch could be read, so no quote was ever compared. Rejecting
 * `already_addressed` here would hand the model a correction note it cannot act
 * on (the file it must quote is unreadable for this run too), burn the retry and
 * fail the run with "the model lied" when the truth is "this run had no clone of
 * the PR's repository".
 *
 * So the dispositions are accepted, flagged, and kept out of the evidence list,
 * which makes settlement answer without a quote it cannot stand behind.
 */
function withUnavailableEvidence(
  verification: ReviewLedgerVerification,
  input: VerifyDispositionsInput,
): ReviewLedgerVerification {
  const salvageable = new Set(
    verification.rejected
      .filter((entry) => entry.reason === EVIDENCE_FILE_NOT_FOUND)
      .map((entry) => entry.alias),
  );
  const rejected = verification.rejected.filter(
    (entry) => !salvageable.has(entry.alias),
  );
  const accepted = [...verification.accepted];
  for (const item of input.workItems) {
    if (!salvageable.has(item.alias)) continue;
    const disposition = input.dispositions.find((d) => d.alias === item.alias);
    if (!disposition) continue;
    accepted.push({
      ...disposition,
      threadId: item.threadId,
      evidenceUnverified: true,
    });
  }
  return { ...verification, accepted, rejected, evidenceUnavailable: true };
}

/** Null when the disposition holds up, otherwise the rule that rejected it. */
async function rejectionReason(
  thread: ReviewThread,
  disposition: ReviewThreadDisposition,
  readFile: (filePath: string) => Promise<string | null>,
): Promise<string | null> {
  if (disposition.disposition === "actionable") return null;

  const needsReply =
    disposition.disposition === "question" || disposition.disposition === "out_of_scope";
  if (needsReply) {
    return disposition.reply?.trim() ? null : "reply required";
  }

  if (thread.source === "bot") {
    // Our own bot only speaks in a thread after we replied, so "already
    // addressed" there is always a way to skip work.
    return "bot threads cannot be marked already_addressed";
  }

  const evidence = disposition.evidence;
  if (!evidence || !evidence.quote.trim()) return "evidence required";

  const quote = normalizeForComparison(evidence.quote);
  const qualityReason = evidenceQualityReason(evidence.filePath, evidence.quote, quote);
  if (qualityReason) return qualityReason;

  if (thread.filePath && evidence.filePath !== thread.filePath) {
    return "evidence must come from the thread's file";
  }

  const content = await readFile(evidence.filePath);
  if (content === null) return EVIDENCE_FILE_NOT_FOUND;

  if (!normalizeForComparison(content).includes(quote)) return "quote not found in file";

  if (thread.filePath && typeof thread.line === "number") {
    const window = lineWindow(content, thread.line);
    if (!normalizeForComparison(window).includes(quote)) {
      return "quote outside the thread's line window";
    }
  }

  return null;
}

/**
 * Quotes travel through a model and a JSON payload, so indentation, line
 * breaks and typography are not reliable; only the sequence of words is. NFC
 * first (a file can hold decomposed accents while the model returns composed
 * ones), then typographic quotes folded to ASCII and zero width characters
 * dropped, so honest evidence is not rejected over invisible bytes. The same
 * function runs on the quote, the whole file and the line window, otherwise
 * the three comparisons would disagree.
 */
function normalizeForComparison(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Null when the quote is substantial enough to stand as evidence. A markdown
 * heading is excluded because it survives any rewrite of the section below it;
 * the same leading hash in code is an ordinary comment and stays valid.
 */
function evidenceQualityReason(
  filePath: string,
  rawQuote: string,
  normalizedQuote: string,
): string | null {
  const words = normalizedQuote.split(" ").filter((word) => word.length > 0);
  if (
    normalizedQuote.length < MIN_EVIDENCE_QUOTE_CHARS ||
    words.length < MIN_EVIDENCE_QUOTE_WORDS
  ) {
    return "quote too short to verify";
  }
  const lowered = filePath.toLowerCase();
  const isMarkdown = MARKDOWN_EXTENSIONS.some((extension) => lowered.endsWith(extension));
  const isSingleLine = !rawQuote.trim().includes("\n");
  if (isMarkdown && isSingleLine && normalizedQuote.startsWith("#")) {
    return "quote is only a heading";
  }
  return null;
}

/** 1-based inclusive [line - 40, line + 40], clamped to the file. */
function lineWindow(content: string, line: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, line - 1 - EVIDENCE_LINE_WINDOW);
  const end = Math.min(lines.length, line + EVIDENCE_LINE_WINDOW);
  return lines.slice(start, end).join("\n");
}

export type ReviewGate = "proceed" | "no_change" | "retry" | "fail";

export interface ResolveReviewGateInput {
  workItems: ReviewThread[];
  verification: ReviewLedgerVerification;
  researchDeclaresWrites: boolean;
  retryUsed: boolean;
}

/**
 * The ledger only speaks when there are threads to answer; null hands the
 * decision back to the caller's existing no-change handling. A rejected
 * disposition is never a verdict about the code, so it buys one retry and then
 * fails the run rather than silently proceeding.
 */
export function resolveReviewGate(input: ResolveReviewGateInput): ReviewGate | null {
  if (input.workItems.length === 0) return null;
  if (input.verification.rejected.length > 0) {
    return input.retryUsed ? "fail" : "retry";
  }
  const hasActionable = input.verification.accepted.some(
    (disposition) => disposition.disposition === "actionable",
  );
  if (hasActionable) return "proceed";
  // Nothing to do for the threads, but the agent may still want to write for
  // reasons outside them; the publish guard is what stops an empty push.
  return input.researchDeclaresWrites ? "proceed" : "no_change";
}

/**
 * Handed back to the agent on the retry. It repeats the rule that killed each
 * alias, because the failure mode we saw was a model reusing the same wrong
 * evidence when it was only told "try again".
 */
export function buildCorrectionNote(rejected: ReviewLedgerRejection[]): string {
  return [
    "Review thread dispositions were rejected",
    "",
    ...rejected.map((entry) => `- ${entry.alias}: ${entry.reason}`),
    "",
    "Every alias listed above needs a new disposition. `already_addressed` means the change exists on the branch now and you can quote it literally from the thread's file, otherwise use `actionable`.",
  ].join("\n");
}

/** One line for the run's failure reason, readable in the dashboard list. */
export function buildGateFailureReason(rejected: ReviewLedgerRejection[]): string {
  const detail = rejected
    .map((entry) => `${entry.alias} (${entry.reason})`)
    .join(", ");
  const prefix = "review ledger: dispositions rejected twice";
  return detail ? `${prefix} for ${detail}` : prefix;
}

export interface BuildRunFailureNoteInput {
  runId: string;
  reason: string;
  unsettledAliases: string[];
  /** Locations for those aliases. A reviewer never saw "T1": the aliases exist
   * only inside the run, so a bare list names nothing they can look at. */
  workItems?: readonly ReviewLedgerGuardWorkItem[];
  /** The commit this run pushed before it died, when it got that far. Null or
   * absent means nothing reached the branch. */
  pushedHead?: string | null;
  /** Threads settlement actually replied in. Optional, and absent counts as
   * zero, so a caller that has not wired it up yet gets today's note rather
   * than a claim about work it cannot vouch for. */
  answeredCount?: number;
}

/**
 * Posted on the PR when the run dies, so a reviewer is not left waiting on a
 * reply that will never come.
 *
 * Three openings, because the run can die in three different states and one
 * sentence for all of them is a lie in two of them:
 *
 * - threads still open: what the reviewer needs is the list, plus the commit if
 *   one was pushed. A run that pushed and then lost the checks did address the
 *   feedback, in code, and "failed before it could address review feedback"
 *   reads as a lie the moment they look at the diff on the branch;
 * - every thread answered, run died afterwards: the reviewer has their replies
 *   already, and telling them otherwise sends them looking for nothing;
 * - nothing to answer: the neutral note, unchanged.
 */
export function buildRunFailureNote(input: BuildRunFailureNoteInput): string {
  const plainHead = `AI Workflow run \`${input.runId}\` failed before it could address review feedback: ${input.reason}.`;
  if (input.unsettledAliases.length > 0) {
    const head = input.pushedHead
      ? `AI Workflow run \`${input.runId}\` pushed \`${input.pushedHead}\` but the run failed at \`${input.reason}\` before replying in the threads.`
      : plainHead;
    const named = input.unsettledAliases.map((alias) =>
      describeAlias(alias, input.workItems ?? []),
    );
    return `${head} Threads left open: ${named.join(", ")}.`;
  }
  const answered = input.answeredCount ?? 0;
  if (answered > 0) {
    const head =
      answered === 1
        ? `AI Workflow run \`${input.runId}\` answered the open review thread, then failed at \`${input.reason}\`.`
        : `AI Workflow run \`${input.runId}\` answered all ${answered} open review threads, then failed at \`${input.reason}\`.`;
    return input.pushedHead ? `${head} The branch carries \`${input.pushedHead}\`.` : head;
  }
  return plainHead;
}

/** "T1 (src/foo.ts:42)", "T3 (general comment)", or the bare alias when the
 * caller passed no locations. Mirrors describeActionableAlias in the publisher,
 * which names threads for the same reader. */
function describeAlias(
  alias: string,
  workItems: readonly ReviewLedgerGuardWorkItem[],
): string {
  const workItem = workItems.find((item) => item.alias === alias);
  if (!workItem) return alias;
  if (workItem.filePath === undefined) return `${alias} (general comment)`;
  return workItem.line === undefined
    ? `${alias} (${workItem.filePath})`
    : `${alias} (${workItem.filePath}:${workItem.line})`;
}

/** Why a disposition produced no provider write. Every reason is reported in
 * the settle result; a thread that quietly disappears is the failure mode this
 * type exists to prevent. */
export type SettleSkipReason = "cap" | "third_party" | "thread_gone" | "deadline";

export interface SettlementPost {
  thread: ReviewThreadTarget;
  body: string;
  resolve: boolean;
}

/**
 * One planned outcome per accepted disposition, in disposition order. Exactly
 * one of post / error / skipped is set, and every plan carries the identity the
 * settle result reports back, so nothing is dropped between plan and result.
 */
export type SettlementPlan =
  | { kind: "post"; threadId: string; alias: string; post: SettlementPost }
  | { kind: "error"; threadId: string; alias: string; error: string }
  | { kind: "skipped"; threadId: string; alias: string; skipped: SettleSkipReason };

export interface PlanSettlementsInput {
  /** Identity-only feed projection: the same one that survives a cold resume. */
  threads: readonly ReviewThreadTarget[];
  accepted: readonly ReviewThreadDisposition[];
  headSha: string | null;
  /** The PR's own repository, named in the "nothing was pushed" error so the
   * operator can tell which repository failed to publish. */
  repoPath: string;
  // The caller re-checks the quote against the pushed tree; evidence can go
  // stale between verification and settlement (a later fix cycle rewrites the
  // file), and a reply quoting a line that is no longer there is worse than a
  // plain "please take another look".
  evidencePresent: (disposition: ReviewThreadDisposition) => boolean;
}

/**
 * Turns accepted dispositions into the reply we post per thread. Only work we
 * actually pushed may resolve a thread; everything else stays open for a human
 * to close.
 */
export function planSettlements(input: PlanSettlementsInput): SettlementPlan[] {
  const plans: SettlementPlan[] = [];
  for (const disposition of input.accepted) {
    const thread = findSettlementThread(input.threads, disposition);
    if (!thread) {
      // The feed no longer knows this thread: a human deleted or resolved it
      // between the decision and the push. Nothing to post, but the run has to
      // say so, otherwise an answered-looking alias just vanishes.
      plans.push({
        kind: "skipped",
        threadId: disposition.threadId ?? "",
        alias: disposition.alias,
        skipped: "thread_gone",
      });
      continue;
    }
    const identity = { threadId: thread.threadId, alias: thread.alias };
    // A drifted alias must never make us post into a scanner's thread; third
    // party threads are context only and are never work items.
    if (thread.source === "third_party") {
      plans.push({ kind: "skipped", ...identity, skipped: "third_party" });
      continue;
    }

    if (disposition.disposition === "actionable") {
      // No push means no evidence of the fix, so we say nothing rather than
      // claim work the reviewer cannot see. Loudly: the publish guard failed
      // this run, and a reviewer waiting on an answer deserves better than a
      // thread the run never mentions again.
      if (!input.headSha) {
        plans.push({
          kind: "error",
          ...identity,
          error: `no pushed head for ${input.repoPath}`,
        });
        continue;
      }
      const reply = disposition.reply?.trim();
      const lines = [`Addressed in \`${input.headSha}\`.`];
      if (reply) lines.push(reply);
      plans.push({
        kind: "post",
        ...identity,
        post: {
          thread,
          body: withMarker(lines.join("\n"), thread),
          resolve: true,
        },
      });
      continue;
    }

    if (disposition.disposition === "already_addressed") {
      const evidence = disposition.evidence;
      // An unverified quote is never posted as a quote, whatever the caller's
      // second pass says: nobody compared it to the branch, and a quotation mark
      // in a bot's reply reads as proof.
      const body = !evidence
        ? "This appears to be covered already; please take another look."
        : disposition.evidenceUnverified
          ? `I could not read \`${evidence.filePath}\` on this branch to confirm, but this looks handled already; please take another look.`
          : input.evidencePresent(disposition)
            ? [
                `Already addressed in \`${evidence.filePath}\`:`,
                "",
                blockquote(evidence.quote),
              ].join("\n")
            : staleEvidenceReply(evidence.filePath, input.headSha);
      plans.push({
        kind: "post",
        ...identity,
        post: { thread, body: withMarker(body, thread), resolve: false },
      });
      continue;
    }

    plans.push({
      kind: "post",
      ...identity,
      post: {
        thread,
        body: withMarker(disposition.reply?.trim() ?? "", thread),
        resolve: false,
      },
    });
  }
  return plans;
}

/**
 * What the reviewer reads when the quote we verified is no longer on the tree
 * we pushed. It names the file and, when we have one, the commit that moved it:
 * "no longer present" alone reads as "the fix was lost", which is the opposite
 * of what happened.
 */
function staleEvidenceReply(filePath: string, headSha: string | null): string {
  return headSha
    ? `\`${filePath}\` changed in \`${headSha}\` and the quoted fragment moved; please take another look.`
    : `\`${filePath}\` changed and the quoted fragment moved; please take another look.`;
}

/**
 * The stamped threadId wins over the alias, since aliases are positional and a
 * feed read again after the push can hand the same alias to another thread.
 */
function findSettlementThread(
  threads: readonly ReviewThreadTarget[],
  disposition: ReviewThreadDisposition,
): ReviewThreadTarget | undefined {
  if (disposition.threadId) {
    return threads.find((entry) => entry.threadId === disposition.threadId);
  }
  return threads.find((entry) => entry.alias === disposition.alias);
}

/** Every ledger reply carries its thread marker, so we never answer twice. */
function withMarker(body: string, thread: ReviewThreadTarget): string {
  return `${body}\n\n${reviewLedgerMarker(thread.threadId)}`;
}

function blockquote(quote: string): string {
  return quote
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

export interface ReviewLedgerGuardWorkItem {
  alias: string;
  threadId: string;
  filePath?: string;
  line?: number;
}

export interface ReviewLedgerGuardSummary {
  workItems: ReviewLedgerGuardWorkItem[];
  acceptedAliases: string[];
  actionableAliases: string[];
  rejectedCount: number;
  truncated: number;
  declaredWrites: boolean;
}

/**
 * The narrow wire format for the publish guard. The guard runs inside a "use
 * step", whose input is serialized into the durable event log, so it gets six
 * scalars instead of the whole ledger (twenty threads with full note bodies).
 * Null for an unverified ledger: the guard must never decide on dispositions
 * nobody checked.
 */
export function buildReviewLedgerGuardSummary(
  state: ReviewLedgerState,
): ReviewLedgerGuardSummary | null {
  if (!state.verification) return null;
  return buildReviewLedgerGuardSummaryFromDurable(buildReviewLedgerDurableState(state));
}

/**
 * The same summary, built from the projection instead of the live ledger. This
 * is the path a cold scheduler resume takes: ctx.reviewLedger is gone, and the
 * publish guard still has to know that this run's zero commits are the honest
 * answer to its review threads rather than a model that wriggled out of work.
 */
export function buildReviewLedgerGuardSummaryFromDurable(
  durable: ReviewLedgerDurableState,
): ReviewLedgerGuardSummary {
  return {
    workItems: durable.feedLite
      .filter((entry) => isReviewLedgerWorkItem(entry))
      .map(toGuardWorkItem),
    acceptedAliases: durable.dispositions.map((disposition) => disposition.alias),
    actionableAliases: durable.dispositions
      .filter((disposition) => disposition.disposition === "actionable")
      .map((disposition) => disposition.alias),
    rejectedCount: durable.rejectedCount,
    truncated: durable.truncated,
    declaredWrites: durable.declaredWrites,
  };
}

function toGuardWorkItem(thread: ReviewThreadTarget): ReviewLedgerGuardWorkItem {
  const item: ReviewLedgerGuardWorkItem = {
    alias: thread.alias,
    threadId: thread.threadId,
  };
  // Omit instead of carrying undefined: this object lands in the event log,
  // where undefined is not a JSON value.
  if (thread.filePath !== undefined) item.filePath = thread.filePath;
  if (thread.line !== undefined) item.line = thread.line;
  return item;
}

/**
 * The hot-path half of durable settlement: everything settle needs, and nothing
 * that must not enter the event log. Note bodies are dropped here, which is the
 * whole point of the projection; see {@link ReviewLedgerDurableState}.
 *
 * Total by design. An unverified ledger yields zero dispositions, so a recovered
 * run settles nothing rather than acting on claims nobody checked.
 */
export function buildReviewLedgerDurableState(
  state: ReviewLedgerState,
): ReviewLedgerDurableState {
  const durable: ReviewLedgerDurableState = {
    dispositions: (state.verification?.accepted ?? []).map(toDurableDisposition),
    // Missing means the wiring did not report; assume the model wanted to write,
    // which keeps the pre-ledger behaviour instead of unlocking a zero-commit
    // success by accident.
    declaredWrites: state.researchDeclaresWrites ?? true,
    truncated: state.feed.truncated,
    rejectedCount: state.verification?.rejected.length ?? 0,
    feedLite: state.feed.threads.map((thread) =>
      toDurableFeedEntry(thread, state.feed.snapshotAt),
    ),
  };
  if (state.evidencePresentThreadIds) {
    durable.evidencePresentThreadIds = [...state.evidencePresentThreadIds];
  }
  return durable;
}

/**
 * The two free-text fields, bounded before they enter the durable event log.
 * Neither is bounded at its source: a reply is whatever the model wrote, and a
 * quote is a substring of a file the verifier reads up to 200 KB of. Twenty
 * dispositions of that would be hundreds of kilobytes in one checkpoint.
 *
 * The agent's own output schema stays frozen; this is a defensive cut at the
 * boundary that owns the size problem. Settlement reads this projection, so the
 * limits also bound what lands in the thread: a reply past 4000 characters or a
 * quote past 1500 is a pathology either way, and a clipped answer beats a
 * checkpoint nobody can write.
 */
const DURABLE_REPLY_MAX_CHARS = 4000;
const DURABLE_QUOTE_MAX_CHARS = 1500;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function toDurableDisposition(
  disposition: ReviewThreadDisposition,
): ReviewThreadDisposition {
  const entry: ReviewThreadDisposition = {
    alias: disposition.alias,
    disposition: disposition.disposition,
  };
  if (disposition.threadId !== undefined) entry.threadId = disposition.threadId;
  if (disposition.reply !== undefined) {
    entry.reply = clip(disposition.reply, DURABLE_REPLY_MAX_CHARS);
  }
  if (disposition.evidence !== undefined) {
    entry.evidence = {
      filePath: disposition.evidence.filePath,
      quote: clip(disposition.evidence.quote, DURABLE_QUOTE_MAX_CHARS),
    };
  }
  // Carried across the resume: without it a recovered run would quote evidence
  // nobody ever checked.
  if (disposition.evidenceUnverified !== undefined) {
    entry.evidenceUnverified = disposition.evidenceUnverified;
  }
  return entry;
}

function toDurableFeedEntry(
  thread: ReviewThread,
  snapshotAt: string,
): ReviewLedgerDurableFeedEntry {
  const entry: ReviewLedgerDurableFeedEntry = {
    threadId: thread.threadId,
    alias: thread.alias,
    source: thread.source,
    resolvable: thread.resolvable,
    awaitingHuman: thread.awaitingHuman,
    snapshotAt,
  };
  if (thread.filePath !== undefined) entry.filePath = thread.filePath;
  if (thread.line !== undefined) entry.line = thread.line;
  return entry;
}

/**
 * The cold-path half: read the projection back out of a checkpointed node
 * output. Returns null for anything that is not a well formed projection, so
 * the caller can report a loud failure instead of settling on half a ledger.
 */
export function parseReviewLedgerDurableState(
  value: unknown,
): ReviewLedgerDurableState | null {
  if (!isRecord(value)) return null;
  const {
    dispositions,
    declaredWrites,
    truncated,
    rejectedCount,
    feedLite,
    evidencePresentThreadIds,
  } = value;
  if (typeof declaredWrites !== "boolean") return null;
  if (typeof truncated !== "number" || typeof rejectedCount !== "number") return null;
  if (!Array.isArray(dispositions) || !Array.isArray(feedLite)) return null;

  const parsedFeed: ReviewLedgerDurableFeedEntry[] = [];
  for (const entry of feedLite) {
    const parsed = parseDurableFeedEntry(entry);
    if (!parsed) return null;
    parsedFeed.push(parsed);
  }
  const parsedDispositions: ReviewThreadDisposition[] = [];
  for (const entry of dispositions) {
    const parsed = parseDurableDisposition(entry);
    if (!parsed) return null;
    parsedDispositions.push(parsed);
  }
  if (
    evidencePresentThreadIds !== undefined &&
    !(
      Array.isArray(evidencePresentThreadIds) &&
      evidencePresentThreadIds.every((id) => typeof id === "string")
    )
  ) {
    return null;
  }

  const state: ReviewLedgerDurableState = {
    dispositions: parsedDispositions,
    declaredWrites,
    truncated,
    rejectedCount,
    feedLite: parsedFeed,
  };
  if (evidencePresentThreadIds !== undefined) {
    state.evidencePresentThreadIds = evidencePresentThreadIds as string[];
  }
  return state;
}

const DISPOSITION_KINDS: ReviewThreadDisposition["disposition"][] = [
  "actionable",
  "already_addressed",
  "question",
  "out_of_scope",
];

const THREAD_SOURCES: ReviewThread["source"][] = ["human", "bot", "third_party"];

function parseDurableFeedEntry(value: unknown): ReviewLedgerDurableFeedEntry | null {
  if (!isRecord(value)) return null;
  const { threadId, alias, source, resolvable, awaitingHuman, snapshotAt, filePath, line } =
    value;
  if (typeof threadId !== "string" || threadId === "") return null;
  if (typeof alias !== "string" || alias === "") return null;
  if (typeof snapshotAt !== "string" || snapshotAt === "") return null;
  if (typeof resolvable !== "boolean" || typeof awaitingHuman !== "boolean") return null;
  if (!THREAD_SOURCES.includes(source as ReviewThread["source"])) return null;
  if (filePath !== undefined && typeof filePath !== "string") return null;
  if (line !== undefined && typeof line !== "number") return null;

  const entry: ReviewLedgerDurableFeedEntry = {
    threadId,
    alias,
    source: source as ReviewThread["source"],
    resolvable,
    awaitingHuman,
    snapshotAt,
  };
  if (typeof filePath === "string") entry.filePath = filePath;
  if (typeof line === "number") entry.line = line;
  return entry;
}

function parseDurableDisposition(value: unknown): ReviewThreadDisposition | null {
  if (!isRecord(value)) return null;
  const { alias, threadId, disposition, reply, evidence, evidenceUnverified } = value;
  if (typeof alias !== "string" || alias === "") return null;
  if (!DISPOSITION_KINDS.includes(disposition as ReviewThreadDisposition["disposition"])) {
    return null;
  }
  if (threadId !== undefined && typeof threadId !== "string") return null;
  if (reply !== undefined && typeof reply !== "string") return null;
  if (evidenceUnverified !== undefined && typeof evidenceUnverified !== "boolean") {
    return null;
  }

  const parsed: ReviewThreadDisposition = {
    alias,
    disposition: disposition as ReviewThreadDisposition["disposition"],
  };
  if (typeof threadId === "string") parsed.threadId = threadId;
  if (typeof reply === "string") parsed.reply = reply;
  if (typeof evidenceUnverified === "boolean") {
    parsed.evidenceUnverified = evidenceUnverified;
  }
  if (evidence !== undefined) {
    if (
      !isRecord(evidence) ||
      typeof evidence.filePath !== "string" ||
      typeof evidence.quote !== "string"
    ) {
      return null;
    }
    parsed.evidence = { filePath: evidence.filePath, quote: evidence.quote };
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
