import type {
  ReviewLedgerRejection,
  ReviewLedgerState,
  ReviewLedgerVerification,
  ReviewThread,
  ReviewThreadDisposition,
  ReviewThreadFeed,
} from "../adapters/vcs/types.js";
import { reviewLedgerMarker } from "../lib/vcs-bot-identity.js";

/**
 * Pure review ledger logic: which unresolved threads are work items, whether
 * the agent's dispositions survive verification, which gate that implies, and
 * what we later write back into each thread. No I/O lives here; file reads are
 * injected so the same rules run in tests, in the ticket path and in the fix
 * loop.
 */

/**
 * Work items are the threads still waiting on us. A thread whose last note is
 * our own ledger reply waits on a human, and a third party bot thread is
 * context only in v1 (we do not answer other vendors' bots).
 */
export function selectWorkItems(feed: ReviewThreadFeed): ReviewThread[] {
  return feed.threads.filter(
    (thread) => !thread.awaitingHuman && thread.source !== "third_party",
  );
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
}

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
  const aliases = new Set(input.workItems.map((item) => item.alias));

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
    const reason = await rejectionReason(item, disposition, input.readFile);
    if (reason) {
      rejected.push({ alias: item.alias, reason });
      continue;
    }
    // Aliases are positional, so a feed we re-read later can hand T1 to a
    // different thread. Settlement follows this stamp, not the alias.
    accepted.push({ ...disposition, threadId: item.threadId });
  }

  for (const disposition of input.dispositions) {
    if (!aliases.has(disposition.alias)) {
      rejected.push({ alias: disposition.alias, reason: "unknown alias" });
    }
  }

  return { accepted, rejected };
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
  if (content === null) return "evidence file not found";

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
}

/**
 * Posted on the PR when the run dies before it can answer the threads, so a
 * reviewer is not left waiting on a reply that will never come.
 */
export function buildRunFailureNote(input: BuildRunFailureNoteInput): string {
  const head = `AI Workflow run \`${input.runId}\` failed before it could address review feedback: ${input.reason}.`;
  return input.unsettledAliases.length === 0
    ? head
    : `${head} Threads left open: ${input.unsettledAliases.join(", ")}.`;
}

export interface ReviewThreadSettlement {
  thread: ReviewThread;
  body: string;
  resolve: boolean;
}

export interface PlanSettlementsInput {
  feed: ReviewThreadFeed;
  accepted: ReviewThreadDisposition[];
  headSha: string | null;
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
export function planSettlements(input: PlanSettlementsInput): ReviewThreadSettlement[] {
  const settlements: ReviewThreadSettlement[] = [];
  for (const disposition of input.accepted) {
    const thread = findSettlementThread(input.feed, disposition);
    // A drifted alias must never make us post into a scanner's thread; third
    // party threads are context only and are never work items.
    if (!thread || thread.source === "third_party") continue;

    if (disposition.disposition === "actionable") {
      // No push means no evidence of the fix, so we say nothing rather than
      // claim work the reviewer cannot see; the publish guard already failed
      // this run.
      if (!input.headSha) continue;
      const reply = disposition.reply?.trim();
      const lines = [`Addressed in \`${input.headSha}\`.`];
      if (reply) lines.push(reply);
      settlements.push({
        thread,
        body: withMarker(lines.join("\n"), thread),
        resolve: true,
      });
      continue;
    }

    if (disposition.disposition === "already_addressed") {
      const evidence = disposition.evidence;
      const body =
        evidence && input.evidencePresent(disposition)
          ? [
              `Already addressed in \`${evidence.filePath}\`:`,
              "",
              blockquote(evidence.quote),
            ].join("\n")
          : evidence && input.headSha
            ? `The quote I verified from \`${evidence.filePath}\` is no longer present at \`${input.headSha}\`; please take another look.`
            : "This appears to be covered already; please take another look.";
      settlements.push({ thread, body: withMarker(body, thread), resolve: false });
      continue;
    }

    settlements.push({
      thread,
      body: withMarker(disposition.reply?.trim() ?? "", thread),
      resolve: false,
    });
  }
  return settlements;
}

/**
 * The stamped threadId wins over the alias, since aliases are positional and a
 * feed read again after the push can hand the same alias to another thread.
 */
function findSettlementThread(
  feed: ReviewThreadFeed,
  disposition: ReviewThreadDisposition,
): ReviewThread | undefined {
  if (disposition.threadId) {
    return feed.threads.find((entry) => entry.threadId === disposition.threadId);
  }
  return feed.threads.find((entry) => entry.alias === disposition.alias);
}

/** Every ledger reply carries its thread marker, so we never answer twice. */
function withMarker(body: string, thread: ReviewThread): string {
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
  const verification = state.verification;
  if (!verification) return null;
  return {
    workItems: selectWorkItems(state.feed).map(toGuardWorkItem),
    acceptedAliases: verification.accepted.map((disposition) => disposition.alias),
    actionableAliases: verification.accepted
      .filter((disposition) => disposition.disposition === "actionable")
      .map((disposition) => disposition.alias),
    rejectedCount: verification.rejected.length,
    truncated: state.feed.truncated,
    // Missing means the wiring did not report; assume the model wanted to
    // write, which keeps the pre-ledger behaviour instead of unlocking a
    // zero-commit success by accident.
    declaredWrites: state.researchDeclaresWrites ?? true,
  };
}

function toGuardWorkItem(thread: ReviewThread): ReviewLedgerGuardWorkItem {
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
