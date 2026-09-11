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
  SettleReviewThreadAction,
} from "../../adapters/vcs/types.js";
import {
  isReviewLedgerWorkItem,
  reviewLedgerMarker,
  selectReviewLedgerWorkItems as selectWorkItems,
} from "../../adapters/vcs/vcs-bot-identity.js";
export { selectReviewLedgerWorkItems as selectWorkItems } from "../../adapters/vcs/vcs-bot-identity.js";
import type { ResearchResult } from "../../sandbox/agents/types.js";
import type { ExecutionErrorCategory } from "../../workflow-definition/interpreter.js";
import type { AgentWorkflowInput } from "../agent-input.js";
import { type RunBudgetFailure } from "./run-budget.js";
import type { JsonValue } from "@shared/contracts";

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
type SettleSkipReason = "cap" | "third_party" | "thread_gone" | "deadline";

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

export function clarificationExitDisposition(providerParked: boolean): {
  outcome: "awaiting";
  notify: boolean;
} {
  return { outcome: "awaiting", notify: providerParked };
}

export type TerminalStatus =
  | "waiting_for_human"
  | "failed"
  | "skipped"
  | "done";

/**
 * How a PR check still open when the run ends is settled. Reaching this point
 * means no verdict was ever produced: the sandbox died, an external service
 * failed, the clock ran out, or the graph simply never completed the check.
 * Settling it as "failure" would tell the developer their code was rejected by
 * a review that never ran, so both outcomes stay non-verdict. A real verdict
 * never arrives here, complete_pr_check has already closed that check.
 */
export function pendingPrCheckIntent(input: {
  category?: ExecutionErrorCategory;
  budgetMetric?: RunBudgetFailure["metric"];
}): "timed_out" | "cancelled" {
  return input.budgetMetric === "duration" || input.category === "timeout"
    ? "timed_out"
    : "cancelled";
}

export function terminalStatusDisposition(
  terminalStatus: TerminalStatus,
): {
  runOutcome: "success" | "failed" | "awaiting";
  shouldRunFailureSideEffects: boolean;
} {
  if (terminalStatus === "waiting_for_human") {
    return {
      runOutcome: "awaiting",
      shouldRunFailureSideEffects: false,
    };
  }
  if (terminalStatus === "failed") {
    return {
      runOutcome: "failed",
      shouldRunFailureSideEffects: true,
    };
  }
  return {
    runOutcome: "success",
    shouldRunFailureSideEffects: false,
  };
}

/**
 * The ticket-side account of a run that ends as a no-op: research found the
 * ticket already resolved, so this run wrote nothing. Pure so the copy stays
 * unit-testable. The evidence section is omitted when there is nothing to list;
 * the caller only builds this comment once it has concrete evidence.
 */
export function buildResolutionEvidenceComment(research: ResearchResult): string {
  const evidence = research.resolutionEvidence ?? [];
  const sections = [
    "This ticket appears to be already resolved, so no code changes were made by this run.",
    research.body,
  ];
  if (evidence.length > 0) {
    sections.push(
      ["Evidence:", ...evidence.map((item) => `- ${item}`)].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * Decide what to do with research's already-resolved declaration. A review
 * comment on the ticket's own PR means a person explicitly asked for changes,
 * so the no_change_needed exit must not be taken: the first declaration earns
 * one corrective research retry, a repeat fails the block. Uses the same
 * prComments condition as renderRepositoryContexts' remediation section, so
 * the prompt and the engine agree on what counts as pending feedback. Pure so
 * the decision table stays unit-testable.
 */
export function resolveNoChangeAction(
  research: ResearchResult,
  repositoryContexts: ReadonlyArray<{ prComments: readonly unknown[] }>,
  retryUsed: boolean,
): "proceed" | "no_change" | "retry" | "fail" {
  const noChangeSignal =
    research.noChangeNeeded === true &&
    (research.resolutionEvidence ?? []).length > 0 &&
    (research.writeRepositories ?? []).length === 0;
  if (!noChangeSignal) return "proceed";
  const hasPrFeedback = repositoryContexts.some(
    (context) => context.prComments.length > 0,
  );
  if (!hasPrFeedback) return "no_change";
  return retryUsed ? "fail" : "retry";
}

/**
 * The ticket-side account of a run that answered review threads and wrote no
 * code. Never says "already resolved": the threads, not the ticket, are what
 * this run was about, and a reviewer reading "ticket already resolved" after
 * asking a question would reasonably conclude the bot ignored them.
 */
export function buildLedgerNoChangeComment(ledger: ReviewLedgerState): string {
  const accepted = ledger.verification?.accepted ?? [];
  const counts = { already_addressed: 0, question: 0, out_of_scope: 0, actionable: 0 };
  for (const disposition of accepted) counts[disposition.disposition] += 1;
  const sections = [
    accepted.length === 0
      ? nothingToAnswerReason(ledger)
      : `I answered ${accepted.length} review thread${accepted.length === 1 ? "" : "s"} on the pull request and made no code changes in this run.`,
  ];
  const detail = [
    counts.already_addressed > 0
      ? `${counts.already_addressed} already addressed on the branch`
      : null,
    counts.question > 0 ? `${counts.question} answered as a question` : null,
    counts.out_of_scope > 0 ? `${counts.out_of_scope} declined as out of scope` : null,
  ].filter((entry): entry is string => entry !== null);
  if (detail.length > 0) sections.push(`Breakdown: ${detail.join(", ")}.`);
  if (ledger.feed.truncated > 0) {
    sections.push(
      `${ledger.feed.truncated} further threads did not fit into this run and are left for the next one.`,
    );
  }
  return sections.join("\n\n");
}

/** One attempted settlement, serialized directly into block output. */
export type SettledThread = {
  threadId: string;
  alias: string;
  action?: SettleReviewThreadAction;
  error?: string;
  skipped?: SettleSkipReason;
};

/**
 * Why a run that answered nothing still ended clean. The reason has to match the
 * feed: telling a reviewer their reply is awaited, when the only thread left
 * open belongs to a scanner bot, sends them looking for a question nobody asked.
 */
function nothingToAnswerReason(ledger: ReviewLedgerState): string {
  const parked = ledger.feed.threads.some((thread) => thread.awaitingHuman);
  const thirdParty = ledger.feed.threads.some(
    (thread) => !thread.awaitingHuman && thread.source === "third_party",
  );
  const reasons = [
    parked ? "already waiting on a human reply" : null,
    thirdParty ? "owned by another tool's bot" : null,
  ].filter((reason): reason is string => reason !== null);
  if (reasons.length === 0) {
    return "No open review thread on the pull request was left for this run to address, so it made no code changes.";
  }
  return `Every open review thread on the pull request is ${reasons.join(" or ")}, so this run had nothing to address and made no code changes.`;
}

/**
 * Aliases whose thread is still without a ledger reply. Read off the settle
 * results rather than off the verification, because finalize may already have
 * answered several threads before the run died further downstream, and naming
 * those in a failure note would contradict the reply sitting in the thread.
 */
export function unsettledWorkItemAliases(
  ledger: ReviewLedgerState,
  settled: ReadonlyArray<SettledThread>,
): string[] {
  const answered = new Set(settled.filter(settledWithReply).map((entry) => entry.threadId));
  return selectWorkItems(ledger.feed)
    .filter((thread) => !answered.has(thread.threadId))
    .map((thread) => thread.alias);
}

/** A settle entry that really put a reply in its thread. A skip and a provider
 *  error are not answers, and both are reported in the same result. */
function settledWithReply(entry: SettledThread): boolean {
  return Boolean(entry.action) && !entry.error;
}

/**
 * How many threads settlement actually replied in. The failure note needs it to
 * tell "died before answering anyone" apart from "answered everyone, then died",
 * which read the same to a reviewer and mean opposite things.
 */
export function settledAnswerCount(settled: ReadonlyArray<SettledThread>): number {
  return settled.filter(settledWithReply).length;
}

export interface ReviewLedgerMetrics {
  event: "review_ledger";
  workItems: number;
  truncated: number;
  rejected: number;
  gate: ReviewGate;
  dispositions: Record<string, number>;
  settled?: Record<string, number>;
}

/** Settle outcomes flattened into one counter map: an action, a skip reason, or
 * an error. Written defensively because the settler grows new outcomes. */
export function countSettleOutcomes(
  settled: ReadonlyArray<SettledThread>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of settled) {
    const skipped = (entry as { skipped?: string }).skipped;
    const key = entry.error ? "error" : skipped ? `skipped_${skipped}` : entry.action ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Where the reviewed repository is checked out, so evidence can be read from
 * the branch the decision is made on. Null when this run has no PR repository
 * in a trusted V2 workspace, which makes every quote unverifiable and every
 * already_addressed claim a rejection.
 */
export function reviewLedgerRepoLocalPath(ctx: {
  entry: AgentWorkflowInput;
  workspaceManifest: {
    version: number;
    repositories: Array<{
      provider: string;
      repoPath: string;
      localPath: string;
    }>;
  } | null;
}): string | null {
  if (ctx.entry.kind !== "pr_trigger") return null;
  const manifest = ctx.workspaceManifest;
  if (manifest?.version !== 2) return null;
  const pr = ctx.entry.pr;
  return (
    manifest.repositories.find(
      (repo) => repo.provider === pr.provider && repo.repoPath === pr.repoPath,
    )?.localPath ?? null
  );
}

/**
 * The model answers with `reply: null` / `evidence: null` for the fields it does
 * not use, because the Codex strict schema demands every key. The ledger's own
 * contract uses absence instead, so the nulls are dropped here rather than
 * being carried into the verifier and the thread replies.
 */
export function toReviewThreadDispositions(
  entries: ReadonlyArray<{
    alias: string;
    disposition: ReviewThreadDisposition["disposition"];
    reply?: string | null;
    evidence?: { filePath: string; quote: string } | null;
  }> | null | undefined,
): ReviewThreadDisposition[] {
  return (entries ?? []).map((entry) => ({
    alias: entry.alias,
    disposition: entry.disposition,
    ...(entry.reply != null ? { reply: entry.reply } : {}),
    ...(entry.evidence != null ? { evidence: entry.evidence } : {}),
  }));
}

/**
 * Answer the threads on the no_change terminal, through the same step finalize
 * uses after a push. Only the durable projection crosses the boundary, so the
 * event log never sees twenty threads' worth of note bodies, and the provider
 * writes are checkpointed once instead of being replayed on every resume.
 */
/** The location half of a thread, without a word of its conversation: what a
 * step input may carry, and all the failure note needs to name a thread. */
function toLedgerGuardWorkItems(threads: ReviewThread[]): ReviewLedgerGuardWorkItem[] {
  return threads.map((thread) => ({
    alias: thread.alias,
    threadId: thread.threadId,
    ...(thread.filePath !== undefined ? { filePath: thread.filePath } : {}),
    ...(thread.line !== undefined ? { line: thread.line } : {}),
  }));
}

/**
 * Aliases the prompt shows but nobody has to answer: threads waiting on a human
 * and threads owned by a third party's bot. The complement of
 * {@link selectWorkItems} by construction, so the verifier's idea of "context"
 * cannot drift from the prompt's.
 */
function reviewLedgerContextAliases(feed: ReviewThreadFeed): string[] {
  const workItems = new Set(selectWorkItems(feed));
  return feed.threads
    .filter((thread) => !workItems.has(thread))
    .map((thread) => thread.alias);
}

/**
 * Second evidence pass, run on the tree about to be published. A quote verified
 * before the implementation can be gone after it (the same run rewrote the
 * file), and a thread reply quoting a line nobody can find reads as a lie. The
 * rules are not re-implemented here: the same verifier runs again, so the two
 * passes can never disagree about what counts as evidence.
 *
 * Records the thread ids whose quote survived. An absent list means the pass
 * never ran, which the settler reads as "trust every quote"; an empty list means
 * it ran and nothing survived.
 */
export async function runLedgerEvidenceSecondPass(
  ledger: ReviewLedgerState | undefined,
  readFile: (filePath: string) => Promise<string | null>,
): Promise<void> {
  if (!ledger) return;
  const claims = (ledger.verification?.accepted ?? []).filter(
    (disposition) => disposition.disposition === "already_addressed",
  );
  if (claims.length === 0) return;
  const workItems = selectWorkItems(ledger.feed).filter((thread) =>
    claims.some((claim) => claim.threadId === thread.threadId),
  );
  const recheck = await verifyDispositions({
    workItems,
    dispositions: claims,
    readFile,
  });
  // The recheck's own copies carry the verdict of this pass, including the
  // "nothing on this branch could be read" flag. Keeping the first pass's copies
  // instead would let the settler quote evidence this pass never confirmed, or
  // tell the reviewer the fragment moved when the truth is that the file was
  // unreadable. A claim the recheck rejected outright keeps its first-pass copy:
  // the thread still gets an answer, just not one that quotes anything.
  if (ledger.verification) {
    const rechecked = new Map(
      recheck.accepted
        .filter((disposition) => typeof disposition.threadId === "string")
        .map((disposition) => [disposition.threadId, disposition] as const),
    );
    ledger.verification = {
      ...ledger.verification,
      accepted: ledger.verification.accepted.map(
        (disposition) => rechecked.get(disposition.threadId) ?? disposition,
      ),
    };
  }
  ledger.evidencePresentThreadIds = recheck.accepted
    // Accepted without ever being compared to the branch, so it is not evidence.
    .filter((disposition) => !disposition.evidenceUnverified)
    .map((disposition) => disposition.threadId)
    .filter((threadId): threadId is string => typeof threadId === "string");
}

/**
 * The ledger projection an agent node carries in its durable output. A cold
 * resume rebuilds the workflow context from step outputs, so without this the
 * run would come back with no ledger at all and finalize would answer nothing.
 * Narrow on purpose: accepted dispositions and a note-free feed, never the full
 * state, which would put twenty comment bodies into the event log.
 */
export function reviewLedgerOutputFields(
  ctx: { reviewLedger?: ReviewLedgerState },
): { reviewLedger: JsonValue } | Record<string, never> {
  if (!ctx.reviewLedger) return {};
  return { reviewLedger: buildReviewLedgerDurableState(ctx.reviewLedger) };
}

export interface ReviewLedgerGateDeps {
  /** Read a repository file from the tree the decision is made on. */
  readFile: (filePath: string) => Promise<string | null>;
  /** Answer the threads. Only called on the no_change terminal. */
  settle: () => Promise<SettledThread[]>;
  log: (metrics: ReviewLedgerMetrics) => void;
}

export type ReviewLedgerGateOutcome =
  | { kind: "proceed" }
  | { kind: "retry"; correctionNote: string }
  | { kind: "fail"; reason: string }
  | { kind: "no_change"; comment: string; settled: SettledThread[] };

/**
 * The review ledger's replacement for {@link resolveNoChangeAction} on a run
 * that carries open review threads. Verifies what the agent claimed per thread,
 * stamps the result onto the ledger so the publish guard and the settler read
 * the same verdict, and turns the gate into the run's next move.
 *
 * Returns null when the feed has no work items, which hands the decision back to
 * the pre-ledger logic unchanged: a thread awaiting a human and a third party
 * scanner's thread are context, not work.
 */
export async function applyReviewLedgerGate(
  input: {
    ledger: ReviewLedgerState;
    dispositions: ReviewThreadDisposition[];
    declaresWrites: boolean;
    retryUsed: boolean;
    /** The run exists because somebody commented on the PR. */
    reviewDriven: boolean;
  },
  deps: ReviewLedgerGateDeps,
): Promise<ReviewLedgerGateOutcome | null> {
  // A feed with nothing in it is not a ledger decision at all: a review that
  // left only a summary opens no thread, and answering it with a clean no_change
  // would throw away the plan the reviewer asked for. fetch_pr_context already
  // refuses to build such a ledger; this keeps the property local to the gate.
  if (input.ledger.feed.threads.length === 0) return null;
  const workItems = selectWorkItems(input.ledger.feed);
  if (workItems.length === 0) {
    // A review re-trigger whose threads are all waiting on a human has nothing
    // to do, and it must say so instead of inventing work: the pre-ledger path
    // would read the same comments as "unresolved feedback" and drive the run
    // into a retry and a red failure. Any other trigger (failing checks) keeps
    // its own reason to run, so the decision goes back to the caller.
    if (!input.reviewDriven) return null;
    const settled = await deps.settle();
    deps.log({
      event: "review_ledger",
      workItems: 0,
      truncated: input.ledger.feed.truncated,
      rejected: 0,
      gate: "no_change",
      dispositions: {},
      settled: countSettleOutcomes(settled),
    });
    return {
      kind: "no_change",
      comment: buildLedgerNoChangeComment(input.ledger),
      settled,
    };
  }

  const verification = await verifyDispositions({
    workItems,
    dispositions: input.dispositions,
    readFile: deps.readFile,
    contextAliases: reviewLedgerContextAliases(input.ledger.feed),
  });
  input.ledger.dispositions = input.dispositions;
  input.ledger.verification = verification;
  input.ledger.researchDeclaresWrites = input.declaresWrites;

  const gate =
    resolveReviewGate({
      workItems,
      verification,
      researchDeclaresWrites: input.declaresWrites,
      retryUsed: input.retryUsed,
    }) ?? "proceed";

  const dispositionCounts: Record<string, number> = {};
  for (const disposition of verification.accepted) {
    dispositionCounts[disposition.disposition] =
      (dispositionCounts[disposition.disposition] ?? 0) + 1;
  }
  const metrics: ReviewLedgerMetrics = {
    event: "review_ledger",
    workItems: workItems.length,
    truncated: input.ledger.feed.truncated,
    rejected: verification.rejected.length,
    gate,
    dispositions: dispositionCounts,
  };

  if (gate === "retry") {
    deps.log(metrics);
    return { kind: "retry", correctionNote: buildCorrectionNote(verification.rejected) };
  }
  if (gate === "fail") {
    deps.log(metrics);
    return { kind: "fail", reason: buildGateFailureReason(verification.rejected) };
  }
  if (gate === "no_change") {
    // Nothing was pushed, so the settler answers with no sha and resolves
    // nothing; the threads stay open for the reviewer to close.
    const settled = await deps.settle();
    deps.log({ ...metrics, settled: countSettleOutcomes(settled) });
    return {
      kind: "no_change",
      comment: buildLedgerNoChangeComment(input.ledger),
      settled,
    };
  }
  deps.log(metrics);
  return { kind: "proceed" };
}

export { toLedgerGuardWorkItems };
