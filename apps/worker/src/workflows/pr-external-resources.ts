import { createHash, randomUUID } from "node:crypto";
import type {
  ReviewResult,
  WorkflowPrCheckReference,
} from "@shared/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  workflowPrReviewPublicationComments,
  workflowPrReviewPublications,
  workflowRunExternalChecks,
  workflowRuns,
} from "../db/schema.js";
import {
  hasGateStatusCapability,
  hasPRFilesCapability,
  hasPRReviewCapability,
  reviewFindingDigest,
  type GateStatusUpdate,
  type PRFile,
  type PRReviewInlineComment,
} from "../adapters/vcs/types.js";
import { assertActiveRunOwner, type ActiveRunOwner } from "../lib/active-run-owner.js";
import {
  compareMergedFindingsForDisplay,
  compareMergedFindingsForPublication,
  highFindingBlockingAgreement,
  MAX_PUBLISHED_INLINE_REVIEW_COMMENTS,
  mergeReviewFindings,
  mergedReviewFindingCommentBody,
  mergedReviewFindingNote,
  type MergedReviewFinding,
  type ReviewFindingCandidate,
} from "./review-finding-merge.js";
import { scrubForPublication } from "../lib/publication-scrub.js";
import type { PrTriggerPayload } from "./agent-input.js";
import { findRunPrSiblings } from "../db/queries/run-pr-siblings.js";
import { logger } from "../lib/logger.js";

export type CheckBusinessConclusion = "success" | "failure" | "neutral";
export type CheckTerminalIntent =
  | CheckBusinessConclusion
  | "cancelled"
  | "timed_out"
  | "superseded";

export interface PrRunTarget {
  subjectKey: string;
  provider: "github" | "gitlab";
  repoPath: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
}

export function prRunTarget(
  subjectKey: string,
  pr: PrTriggerPayload,
): PrRunTarget {
  return {
    subjectKey,
    provider: pr.provider,
    repoPath: pr.repoPath,
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
  };
}

/** Only a review decision may reach the provider as a verdict. Every intent
 * that means "this review never concluded" folds into "cancelled", the one
 * conclusion that reads as not-completed on both providers: GitHub renders
 * "timed_out" as a failed check, and GitLab's mapCommitStatus collapses
 * "timed_out" into "failed" and "neutral" into "success". */
function checkProviderUpdate(
  conclusion: CheckTerminalIntent,
  details: string,
): GateStatusUpdate {
  const mapped =
    conclusion === "cancelled" ||
    conclusion === "timed_out" ||
    conclusion === "superseded"
      ? "cancelled"
      : conclusion;
  return {
    status: "completed",
    conclusion: mapped,
    summary:
      details ||
      (conclusion === "superseded"
        ? "Superseded by a newer pull request commit."
        : `Workflow ${conclusion}.`),
  };
}

export async function createRunOwnedPrCheck(args: {
  db: Db;
  owner: ActiveRunOwner;
  target: PrRunTarget;
  nodeId: string;
  attempt: number;
  activationScope: string;
  name: string;
}): Promise<WorkflowPrCheckReference> {
  const existing = await args.db
    .select()
    .from(workflowRunExternalChecks)
    .where(
      and(
        eq(workflowRunExternalChecks.runId, args.owner.runId!),
        eq(workflowRunExternalChecks.nodeId, args.nodeId),
        eq(workflowRunExternalChecks.attempt, args.attempt),
        eq(workflowRunExternalChecks.activationScope, args.activationScope),
      ),
    )
    .limit(1);
  if (existing[0]?.providerReference) {
    return {
      id: existing[0].id,
      headSha: existing[0].headSha,
      name: existing[0].name,
    };
  }
  await assertActiveRunOwner(args.db, args.owner);
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const vcs = createRepositoryVCS({
    provider: args.target.provider,
    repoPath: args.target.repoPath,
    baseBranch: args.target.baseRef,
  });
  if (!hasGateStatusCapability(vcs)) {
    throw new Error(`${args.target.provider} does not support workflow PR checks.`);
  }
  const current = await vcs.getPRHead(args.target.prNumber);
  if (
    current.headSha !== args.target.headSha ||
    current.state !== "open"
  ) {
    throw new Error("The pull request changed before its check could be created.");
  }

  const id = existing[0]?.id ?? randomUUID();
  if (!existing[0]) {
    await args.db.insert(workflowRunExternalChecks).values({
      id,
      runId: args.owner.runId!,
      nodeId: args.nodeId,
      attempt: args.attempt,
      activationScope: args.activationScope,
      subjectKey: args.target.subjectKey,
      provider: args.target.provider,
      repository: args.target.repoPath,
      prNumber: args.target.prNumber,
      headSha: args.target.headSha,
      name: args.name,
      providerReference: null,
      state: "creating",
    });
  }
  try {
    const providerReference = await vcs.createGateStatus(
      args.name,
      args.target.headSha,
      id,
    );
    await args.db
      .update(workflowRunExternalChecks)
      .set({ providerReference, state: "pending", updatedAt: new Date() })
      .where(eq(workflowRunExternalChecks.id, id));
  } catch (error) {
    await args.db
      .update(workflowRunExternalChecks)
      .set({
        // A check that could not even be created holds no verdict, so this
        // placeholder must stay outside the decided set closeRunPrChecks keeps.
        closureIntent: "cancelled",
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(workflowRunExternalChecks.id, id));
    throw error;
  }
  return { id, headSha: args.target.headSha, name: args.name };
}

export async function completeRunOwnedPrCheck(args: {
  db: Db;
  owner: ActiveRunOwner;
  target: PrRunTarget;
  reference: WorkflowPrCheckReference;
  conclusion: CheckBusinessConclusion;
  details: string;
  refreshHead?: boolean;
}): Promise<void> {
  const [storedCheck] = await args.db
    .select()
    .from(workflowRunExternalChecks)
    .where(eq(workflowRunExternalChecks.id, args.reference.id))
    .limit(1);
  if (!storedCheck || storedCheck.runId !== args.owner.runId || storedCheck.name !== args.reference.name) {
    throw new Error(
      "The PR check does not belong to this workflow run and pull request head.",
    );
  }
  if (storedCheck.state === "completed") return;
  let check = storedCheck;
  let target = args.target;
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const vcs = createRepositoryVCS({
    provider: args.target.provider,
    repoPath: args.target.repoPath,
    baseBranch: args.target.baseRef,
  });
  if (args.refreshHead) {
    await assertActiveRunOwner(args.db, args.owner);
    const latest = await vcs.getPRHead(args.target.prNumber);
    if (latest.state !== "open") {
      throw new Error("The pull request is no longer open.");
    }
    target = { ...args.target, headSha: latest.headSha };
    if (latest.headSha !== check.headSha) {
      if (!hasGateStatusCapability(vcs)) {
        throw new Error(`${args.target.provider} does not support workflow PR checks.`);
      }
      const providerReference = await vcs.createGateStatus(
        check.name,
        latest.headSha,
        check.id,
      );
      await args.db
        .update(workflowRunExternalChecks)
        .set({
          headSha: latest.headSha,
          providerReference,
          state: "pending",
          updatedAt: new Date(),
        })
        .where(eq(workflowRunExternalChecks.id, check.id));
      check = {
        ...check,
        headSha: latest.headSha,
        providerReference,
        state: "pending",
      };
    }
  }
  if (
    check.headSha !== target.headSha ||
    (!args.refreshHead && check.headSha !== args.reference.headSha)
  ) {
    throw new Error(
      "The PR check does not belong to this workflow run and pull request head.",
    );
  }
  if (!check.providerReference) {
    throw new Error("The PR check provider reference is unavailable.");
  }
  await assertActiveRunOwner(args.db, args.owner);
  await args.db
    .update(workflowRunExternalChecks)
    .set({
      state: "closing",
      closureIntent: args.conclusion,
      updatedAt: new Date(),
    })
    .where(eq(workflowRunExternalChecks.id, check.id));
  if (!hasGateStatusCapability(vcs)) {
    throw new Error(`${args.target.provider} does not support workflow PR checks.`);
  }
  const current = await vcs.getPRHead(args.target.prNumber);
  if (
    current.headSha !== target.headSha ||
    current.state !== "open"
  ) {
    await vcs.updateGateStatus(
      check.providerReference,
      checkProviderUpdate(
        "superseded",
        "Superseded by a newer pull request commit.",
      ),
    );
    await args.db
      .update(workflowRunExternalChecks)
      .set({
        state: "completed",
        closureIntent: "superseded",
        conclusion: "superseded",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workflowRunExternalChecks.id, check.id));
    throw new Error("The PR check was superseded by a newer commit.");
  }
  await vcs.updateGateStatus(
    check.providerReference,
    checkProviderUpdate(args.conclusion, args.details),
  );
  await args.db
    .update(workflowRunExternalChecks)
    .set({
      state: "completed",
      conclusion: args.conclusion,
      completedAt: new Date(),
      updatedAt: new Date(),
      lastError: null,
    })
    .where(eq(workflowRunExternalChecks.id, check.id));
}

export async function closeRunPrChecks(args: {
  db: Db;
  runId: string;
  intent: CheckTerminalIntent;
  details: string;
  checkIds?: string[];
}): Promise<{ closed: number; pending: number }> {
  const filters = [
    eq(workflowRunExternalChecks.runId, args.runId),
    inArray(workflowRunExternalChecks.state, ["pending", "closing"]),
  ];
  if (args.checkIds) {
    filters.push(inArray(workflowRunExternalChecks.id, args.checkIds));
  }
  const rows = await args.db
    .select()
    .from(workflowRunExternalChecks)
    .where(and(...filters));
  let closed = 0;
  let pending = 0;
  for (const check of rows) {
    // A conclusion the workflow already decided outranks this sweep, which
    // only knows the run ended, not what the review concluded. Supersession is
    // the exception in both directions: a caller that watched the head move
    // knows something fresher than a verdict that never reached the provider,
    // and a check already marked superseded stays superseded. Do not widen the
    // decided set over "superseded" without keeping that precedence.
    const decided =
      check.closureIntent === "superseded" ||
      (args.intent !== "superseded" &&
        (check.closureIntent === "success" ||
          check.closureIntent === "failure" ||
          check.closureIntent === "neutral"));
    const intent = decided
      ? (check.closureIntent as CheckTerminalIntent)
      : args.intent;
    await args.db
      .update(workflowRunExternalChecks)
      .set({
        state: "closing",
        closureIntent: intent,
        updatedAt: new Date(),
      })
      .where(eq(workflowRunExternalChecks.id, check.id));
    if (!check.providerReference) {
      pending++;
      continue;
    }
    try {
      const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
      const vcs = createRepositoryVCS({
        provider: check.provider as "github" | "gitlab",
        repoPath: check.repository,
        baseBranch: "main",
      });
      if (!hasGateStatusCapability(vcs)) throw new Error("PR checks are unsupported.");
      await vcs.updateGateStatus(
        check.providerReference,
        checkProviderUpdate(intent, args.details),
      );
      await args.db
        .update(workflowRunExternalChecks)
        .set({
          state: "completed",
          conclusion: intent,
          completedAt: new Date(),
          updatedAt: new Date(),
          lastError: null,
        })
        .where(eq(workflowRunExternalChecks.id, check.id));
      closed++;
    } catch (error) {
      pending++;
      await args.db
        .update(workflowRunExternalChecks)
        .set({
          retryCount: check.retryCount + 1,
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(eq(workflowRunExternalChecks.id, check.id));
    }
  }
  return { closed, pending };
}

/** Statuses a run never leaves, so a check it still owes will never be paid. */
const ENDED_RUN_STATUSES = ["success", "failed", "blocked", "cancelled"];

/** Long enough for a terminating run to finish closing its own checks. */
const ABANDONED_CHECK_GRACE_MS = 60 * 1000;

/**
 * A run that dies between creating its check and deciding a verdict leaves the
 * check open forever: the scheduler records no block outcome, so no closing
 * step ever runs, and the pull request shows a check stuck in progress that
 * blocks merge with no way to retry.
 *
 * The grace window matters. A run marks itself terminal and closes its checks
 * as two separate writes, so a row read microseconds apart from the first would
 * look abandoned while the second is still in flight, and we would overwrite a
 * real verdict with "cancelled".
 */
async function abandonedPendingCheckIds(
  db: Db,
  rows: Array<{ id: string; runId: string; state: string; updatedAt: Date | null }>,
): Promise<Set<string>> {
  const candidates = rows.filter(
    (row) =>
      row.state === "pending" &&
      Date.now() - (row.updatedAt?.getTime() ?? 0) >= ABANDONED_CHECK_GRACE_MS,
  );
  if (candidates.length === 0) return new Set();
  const runIds = [...new Set(candidates.map((row) => row.runId))];
  const runs = await db
    .select({ runId: workflowRuns.runId, status: workflowRuns.status })
    .from(workflowRuns)
    .where(inArray(workflowRuns.runId, runIds));
  const ended = new Set(
    runs
      .filter((run) => run.status && ENDED_RUN_STATUSES.includes(run.status))
      .map((run) => run.runId),
  );
  return new Set(
    candidates.filter((row) => ended.has(row.runId)).map((row) => row.id),
  );
}

export async function reconcilePendingPrChecks(
  db: Db,
  limit = 25,
): Promise<{ attempted: number; closed: number; pending: number }> {
  const rows = await db
    .select()
    .from(workflowRunExternalChecks)
    .where(
      inArray(workflowRunExternalChecks.state, ["creating", "pending", "closing"]),
    )
    .orderBy(asc(workflowRunExternalChecks.updatedAt))
    .limit(limit);
  const abandoned = await abandonedPendingCheckIds(db, rows);
  const retries: Array<{
    checkId: string;
    runId: string;
    intent: CheckTerminalIntent;
    details: string;
  }> = [];
  for (const row of rows) {
    if (row.state === "pending") {
      // "pending" means the provider check exists and the run still owes it a
      // verdict. Only a run that will never speak again may be closed here, so
      // anything still in flight is left alone.
      if (!abandoned.has(row.id)) continue;
      await db
        .update(workflowRunExternalChecks)
        .set({
          state: "closing",
          closureIntent: row.closureIntent ?? "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(workflowRunExternalChecks.id, row.id));
      retries.push({
        checkId: row.id,
        runId: row.runId,
        intent: (row.closureIntent as CheckTerminalIntent | null) ?? "cancelled",
        details: "The run ended without completing this check.",
      });
      continue;
    }
    if (row.state === "creating" && !row.providerReference) {
      try {
        const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
        const vcs = createRepositoryVCS({
          provider: row.provider as "github" | "gitlab",
          repoPath: row.repository,
          baseBranch: "main",
        });
        if (!hasGateStatusCapability(vcs)) {
          throw new Error("PR checks are unsupported.");
        }
        const providerReference = await vcs.createGateStatus(
          row.name,
          row.headSha,
          row.id,
        );
        await db
          .update(workflowRunExternalChecks)
          .set({
            providerReference,
            state: "closing",
            // The run died before it could ask for anything; no verdict exists.
            closureIntent: row.closureIntent ?? "cancelled",
            updatedAt: new Date(),
          })
          .where(eq(workflowRunExternalChecks.id, row.id));
      } catch (error) {
        await db
          .update(workflowRunExternalChecks)
          .set({
            retryCount: row.retryCount + 1,
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(workflowRunExternalChecks.id, row.id));
        continue;
      }
    }
    if (!row.closureIntent) continue;
    retries.push({
      checkId: row.id,
      runId: row.runId,
      intent: row.closureIntent as CheckTerminalIntent,
      details: row.lastError ?? "Retrying PR check completion.",
    });
  }
  let closed = 0;
  let pending = 0;
  for (const retry of retries) {
    const result = await closeRunPrChecks({
      db,
      runId: retry.runId,
      intent: retry.intent,
      details: retry.details,
      checkIds: [retry.checkId],
    });
    closed += result.closed;
    pending += result.pending;
  }
  return { attempted: retries.length, closed, pending };
}

function normalizedPath(
  path: string,
  fileLines: ReadonlyMap<string, ReadonlyMap<number, number | null>>,
): string | null {
  const value = fileLines.has(path) ? path : path.replace(/^(a|b)\//, "");
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return value;
}

function changedNewSidePositions(
  patch: string,
): Map<number, number | null> {
  const lines = new Map<number, number | null>();
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(
      /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/,
    );
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (newLine === 0 || line.startsWith("\\")) continue;
    if (line.startsWith("-")) {
      oldLine++;
      continue;
    }
    if (line.startsWith("+")) {
      lines.set(newLine, null);
      newLine++;
      continue;
    }
    lines.set(newLine, oldLine);
    oldLine++;
    newLine++;
  }
  return lines;
}

/**
 * Turns every reviewer's findings into one comment per defect.
 *
 * Anchoring is unchanged; what is new is that findings are merged across
 * reviewers first, and that the cap applies to the review a reader sees rather
 * than to each reviewer separately. Nothing is dropped: a defect that loses its
 * inline slot is listed in the summary with a visible count.
 */
export function partitionReviewFindings(
  results: ReviewResult[],
  files: PRFile[],
  options: {
    maxComments?: number;
    currentRepository?: string;
    siblingRepositories?: ReadonlyMap<
      string,
      { url: string; headSha?: string }
    >;
  } = {},
): {
  comments: PRReviewInlineComment[];
  /** Every defect, whether or not it won an inline slot. The published verdict
   * is read from this, so severity and cross-reviewer agreement must survive
   * the conversion to comments, which keeps neither. */
  merged: MergedReviewFinding[];
  fallback: MergedReviewFinding[];
  withheld: MergedReviewFinding[];
  reportedCount: number;
  distinctCount: number;
} {
  const fileLines = new Map(
    files.map((file) => [
      file.path,
      file.patch
        ? changedNewSidePositions(file.patch)
        : new Map<number, number | null>(),
    ]),
  );
  const candidates: ReviewFindingCandidate[] = [];
  for (const [reviewerIndex, result] of results.entries()) {
    for (const [findingIndex, finding] of result.findings.entries()) {
      const crossRepository =
        typeof finding.repo === "string" &&
        finding.repo.length > 0 &&
        finding.repo !== options.currentRepository;
      const path = normalizedPath(finding.file, fileLines);
      const start = finding.startLine;
      const end = finding.endLine ?? start;
      const changed = path ? fileLines.get(path) : undefined;
      const rangeLength =
        start !== undefined && end !== undefined ? end - start + 1 : 0;
      const locatable =
        path !== null &&
        start !== undefined &&
        end !== undefined &&
        start <= end &&
        changed !== undefined &&
        rangeLength <= changed.size &&
        rangeContainsOnlyChangedSideLines(new Set(changed.keys()), start, end);
      candidates.push({
        reviewerIndex,
        findingIndex,
        finding,
        // The normalized path groups `a/x.ts` with `x.ts`; the raw file is the
        // fallback so an unresolvable path still only ever matches itself.
        groupKey: `${finding.repo ?? options.currentRepository ?? ""}:${path ?? finding.file.trim()}`,
        anchor: crossRepository
          ? null
          : locatable
          ? {
              path,
              startLine: start,
              endLine: end,
              startOldLine: changed.get(start) ?? null,
              endOldLine: changed.get(end) ?? null,
            }
          : null,
        ...(crossRepository ? { crossRepository: true } : {}),
      });
    }
  }

  const merged = mergeReviewFindings(candidates);
  const placeable: MergedReviewFinding[] = [];
  const fallback: MergedReviewFinding[] = [];
  for (const finding of merged) {
    (finding.anchor === null ? fallback : placeable).push(finding);
  }

  const maxComments = options.maxComments ?? MAX_PUBLISHED_INLINE_REVIEW_COMMENTS;
  const ranked = [...placeable].sort(compareMergedFindingsForPublication);
  const chosen = ranked.slice(0, maxComments);
  const withheld = ranked.slice(maxComments);

  const comments = [...chosen]
    .sort(compareMergedFindingsForDisplay)
    .map((finding) => ({
      // Property order is load-bearing: reviewCommentContentHash stringifies
      // this object, so reordering these keys rewrites every stored hash.
      path: finding.anchor!.path,
      startLine: finding.anchor!.startLine,
      endLine: finding.anchor!.endLine,
      startOldLine: finding.anchor!.startOldLine,
      endOldLine: finding.anchor!.endOldLine,
      body: mergedReviewFindingCommentBody(
        finding,
        results.length,
        reviewFindingBlocksPublication(finding, results.length),
      ),
    }));

  return {
    comments,
    merged,
    fallback,
    withheld,
    reportedCount: candidates.length,
    distinctCount: merged.length,
  };
}

/**
 * Whether one defect holds the check back on its own.
 *
 * `sources.length` is the number of DISTINCT reviewers that reported it, because
 * merging is cross-reviewer only: `mergeable` refuses a candidate from a reviewer
 * already in the cluster.
 *
 * The agreement threshold comes from `highFindingBlockingAgreement` because the
 * published note quotes that number at the reader. One rule, two readers: a
 * second copy of it would let the check and the review disagree about the same
 * finding, and a hand-written numeral in the note would say a third thing.
 */
export function reviewFindingBlocksPublication(
  finding: MergedReviewFinding,
  reviewerCount: number,
): boolean {
  if (finding.crossRepository) return false;
  if (finding.severity === "Blocker") return true;
  if (finding.severity !== "High") return false;
  return finding.sources.length >= highFindingBlockingAgreement(reviewerCount);
}

/**
 * The published verdict, read from the merged findings rather than from the
 * reviewers' own decisions.
 *
 * Each reviewer already asks for changes on any Blocker or High it found on its
 * own (`buildReviewAgentSuccessOutput`), so requiring all of them to approve
 * turned one reviewer's lone High into a red check on nearly every commit. The
 * gate therefore reads the clusters: a Blocker always blocks, a High blocks only
 * when independent reviewers agreed on it, which is the strongest signal
 * available that the finding is real. Per-reviewer decisions are untouched and
 * still reach `fix_agent` verbatim.
 */
export function reviewPublicationDecision(
  merged: readonly MergedReviewFinding[],
  reviewerCount: number,
): "approve" | "request_changes" {
  return merged.some((finding) =>
    reviewFindingBlocksPublication(finding, reviewerCount),
  )
    ? "request_changes"
    : "approve";
}

function rangeContainsOnlyChangedSideLines(
  changed: Set<number>,
  start: number,
  end: number,
): boolean {
  for (let line = start; line <= end; line++) {
    if (!changed.has(line)) return false;
  }
  return true;
}

/**
 * One finding as a markdown list item, for the summary sections that name the
 * findings no inline comment could carry.
 *
 * The note is the SAME string the inline comment body carries, on its own
 * indented continuation line, exactly as `reviewFallbackBullet` renders that body
 * when a provider refuses an inline position. A finding reaches this line because
 * it could not be anchored or lost its inline slot, which changes nothing about
 * what it earned: with a wording of its own here, a non-blocking High read as a
 * blocking one purely because of where it landed, and the agreement note read as
 * a different kind of remark from the identical sentence one section above.
 *
 * The indent is load-bearing for the same reason it is in `reviewFallbackBullet`:
 * an unindented blank line closes a markdown list, so the note would detach into
 * its own paragraph and every finding after it would open a fresh list.
 */
function reviewSummaryLine(
  finding: MergedReviewFinding,
  reviewerCount: number,
  siblingRepositories?: ReadonlyMap<string, { url: string; headSha?: string }>,
): string {
  const location = finding.startLine
    ? `${finding.file}:${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ""}`
    : finding.file;
  const sibling = finding.crossRepository && finding.repo
    ? siblingRepositories?.get(finding.repo)
    : undefined;
  const attribution = finding.crossRepository && finding.repo
    ? ` [${finding.repo}${sibling?.headSha ? ` @ ${sibling.headSha}` : ""}]${sibling?.url ? `(${sibling.url})` : ""}`
    : "";
  const head = `- **${finding.severity}**${attribution} \`${location}\`: ${finding.description}`;
  const note = mergedReviewFindingNote(
    finding,
    reviewerCount,
    reviewFindingBlocksPublication(finding, reviewerCount),
  );
  return note === "" ? head : `${head}\n\n  ${note}`;
}

/**
 * One reviewer's feedback as a single list item.
 *
 * Continuation lines are indented into the item, exactly as `reviewFallbackBullet`
 * does it and for the same reason: feedback is multi-paragraph prose, and an
 * unindented blank line closes a markdown list. Without the indent the second
 * paragraph detaches into its own block, every reviewer after it opens a fresh
 * list, and the section renders as a wall of text instead of one item per
 * reviewer.
 */
function reviewFeedbackBullet(feedback: string): string {
  const [first = "", ...rest] = feedback.split("\n");
  const continuation = rest.map((line) => (line.trim() === "" ? "" : `  ${line}`));
  return [`- ${first}`, ...continuation].join("\n");
}

export function reviewSummary(
  results: ReviewResult[],
  fallback: MergedReviewFinding[],
  withheld: MergedReviewFinding[] = [],
  counts: { reportedCount: number; distinctCount: number } = {
    reportedCount: 0,
    distinctCount: 0,
  },
  siblingRepositories: ReadonlyMap<string, { url: string; headSha?: string }> = new Map(),
): string {
  const feedback = results
    .map((result) => result.feedback?.trim())
    .filter((value): value is string => Boolean(value));
  const lines = ["## AI Workflow review"];
  if (counts.reportedCount > counts.distinctCount) {
    // Singular when three reviewers all described one defect, which is the most
    // common shape this line reports and the one a reader sees first.
    const noun = counts.distinctCount === 1 ? "finding" : "findings";
    lines.push(
      "",
      `_${counts.distinctCount} distinct ${noun} merged from ${counts.reportedCount} reported by ${results.length} reviewers._`,
    );
  }
  if (fallback.length > 0) {
    lines.push("", "### Findings not placed inline");
    for (const finding of fallback) {
      lines.push(reviewSummaryLine(finding, results.length, siblingRepositories));
    }
  }
  if (withheld.length > 0) {
    // The count belongs in the heading: a cap that truncates silently reads as
    // "nothing else was found", which is the opposite of what happened.
    const noun = withheld.length === 1 ? "finding" : "findings";
    lines.push("", `### ${withheld.length} further ${noun} not shown inline`);
    for (const finding of withheld) {
      lines.push(reviewSummaryLine(finding, results.length, siblingRepositories));
    }
  }
  if (siblingRepositories.size > 0) {
    lines.push("", "### Related pull requests");
    for (const [repo, sibling] of siblingRepositories) {
      lines.push(
        `- [${repo}](${sibling.url})${sibling.headSha ? ` @ \`${sibling.headSha}\`` : ""}`,
      );
    }
  }
  if (results.every((result) => result.findings.length === 0) && feedback.length === 0) {
    lines.push("", "No findings.");
  }
  // LAST, and collapsed, and never edited.
  //
  // Collapsed because three reviewers explaining one defect repeat each other,
  // and that repetition is what made this section unreadable. Never edited
  // because removing it means deciding which prose is a restatement, and two
  // attempts at that failed: a similarity gate cannot separate "the same defect"
  // from "a different defect on the same symbol", and the unit is wrong anyway,
  // because a model writes a whole list of unrelated findings without a blank
  // line between them, so dropping a "paragraph" dropped findings nobody
  // restated. A disclosure moves the repetition out of the reader's way while
  // keeping every word one click away, which is the only version where a lost
  // finding is impossible.
  //
  // Last for two reasons beyond ordering the verdict before its supporting
  // material. This string is also read as PLAIN TEXT: the deployed
  // post-pr-review definition binds it into complete_pr_check, which reaches
  // GitHub as a check-run title sliced to 200 characters and GitLab as a
  // commit-status description clamped to 255, and with the block on top the
  // client's first 200 characters began "<details><summary>Reviewer notes".
  // (The shipped template no longer binds it, but a definition deployed before
  // that change still does, and it cannot be revised in place.) And reviewer
  // prose is agent-authored: a reviewer that writes a bare `<details>` of its own
  // would otherwise swallow the findings sections below it into this box.
  //
  // No count in the label. `scrubForPublication` runs over the assembled summary
  // after this point and can empty a reviewer's prose, so any number here is a
  // claim about content this block might not contain: "Reviewer notes (2)" over
  // an empty box is exactly the loss the disclosure exists to rule out.
  //
  // The blank lines inside the block are required: both providers only parse the
  // body as markdown when the tags are separated from it, and without them the
  // list renders literally.
  if (feedback.length > 0) {
    lines.push(
      "",
      "<details><summary>Reviewer notes</summary>",
      "",
      ...feedback.map(reviewFeedbackBullet),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
}

/**
 * Thread digests for the findings this round reports into the SUMMARY rather than
 * inline: the ones the inline cap pushed out, and the ones whose line is no longer
 * part of the diff.
 *
 * The adapters settle a thread when the round stops reporting its finding, and the
 * placed comments alone cannot distinguish that from "still reported, just not
 * inline". Without this list a finding demoted by the cap kept its thread and had it
 * marked resolved, while the same finding was listed as standing three lines below
 * in the summary.
 *
 * The body is built by the same function and scrubbed by the same pass as a placed
 * comment (`partitionReviewFindings`), because the digest has to come out identical
 * to the one the thread was opened under. The path is the anchor's when there is
 * one, and otherwise the cluster's group key, which is the same normalised path an
 * anchor would have carried.
 */
export function deferredReviewFindingDigests(
  deferred: readonly MergedReviewFinding[],
  reviewerCount: number,
): string[] {
  return deferred.map((finding) =>
    reviewFindingDigest({
      path: finding.anchor?.path ?? finding.sources[0]!.groupKey,
      body: scrubForPublication(
        mergedReviewFindingCommentBody(
          finding,
          reviewerCount,
          reviewFindingBlocksPublication(finding, reviewerCount),
        ),
      ),
    }),
  );
}

export function reviewCommentContentHash(
  comment: PRReviewInlineComment,
  index: number,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ index, ...comment }))
    .digest("hex");
}

export async function publishRunOwnedPrReview(args: {
  db: Db;
  owner: ActiveRunOwner;
  target: PrRunTarget;
  nodeId: string;
  attempt: number;
  activationScope: string;
  reviewResults: ReviewResult[];
}): Promise<{
  decision: "approve" | "request_changes";
  summary: string;
  inlineCommentCount: number;
  summaryFallbackCount: number;
}> {
  await assertActiveRunOwner(args.db, args.owner);
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const vcs = createRepositoryVCS({
    provider: args.target.provider,
    repoPath: args.target.repoPath,
    baseBranch: args.target.baseRef,
  });
  if (!hasPRFilesCapability(vcs) || !hasPRReviewCapability(vcs)) {
    throw new Error(`${args.target.provider} does not support workflow PR reviews.`);
  }
  const current = await vcs.getPRHead(args.target.prNumber);
  if (current.headSha !== args.target.headSha || current.state !== "open") {
    throw new Error("The pull request changed before the review could be published.");
  }
  const files = await vcs.listPRFiles(args.target.prNumber);
  const siblingLookup = await findRunPrSiblings({
    db: args.db,
    provider: args.target.provider,
    repoPath: args.target.repoPath,
    prNumber: args.target.prNumber,
  });
  const siblingRepositories = new Map<string, { url: string; headSha?: string }>();
  if (siblingLookup.status === "siblings") {
    for (const sibling of siblingLookup.siblings) {
      siblingRepositories.set(sibling.repoPath, {
        url: sibling.url,
        ...(sibling.headSha ? { headSha: sibling.headSha } : {}),
      });
    }
  }
  const {
    comments: placedComments,
    merged,
    fallback,
    withheld,
    reportedCount,
    distinctCount,
  } = partitionReviewFindings(args.reviewResults, files, {
    currentRepository: args.target.repoPath,
    siblingRepositories,
  });
  const crossRepositoryFindingCount = merged.filter(
    (finding) => finding.crossRepository,
  ).length;
  logger.info(
    {
      runId: args.owner.runId,
      pr: `${args.target.provider}:${args.target.repoPath}#${args.target.prNumber}`,
      siblingLookup: siblingLookup.status,
      siblingRepositories: siblingRepositories.size,
      crossRepositoryFindingCount,
    },
    "post_pr_review_context",
  );
  // Review feedback and finding descriptions are agent-authored prose. Scrubbing
  // the summary here rather than at the publish call also covers the value
  // returned to the workflow, which complete_pr_check binds into the check run
  // details shown on the pull request.
  const comments = placedComments.map((comment) => ({
    ...comment,
    body: scrubForPublication(comment.body),
  }));
  const decision = reviewPublicationDecision(merged, args.reviewResults.length);
  const summary = scrubForPublication(
    reviewSummary(args.reviewResults, fallback, withheld, {
      reportedCount,
      distinctCount,
    }, siblingRepositories),
  );
  const normalized = {
    provider: args.target.provider,
    repository: args.target.repoPath,
    prNumber: args.target.prNumber,
    headSha: args.target.headSha,
    decision,
    results: args.reviewResults,
  };
  // The database key only: it records WHICH review was published, so it stays
  // derived from the verdict and the reviewer output.
  const contentHash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  // WHAT A ROUND IS (AIW-236), because two things below are keyed differently and
  // the difference is the whole feature.
  //
  // A round is one reviewed head commit of one pull request: the tuple
  // (provider, repository, prNumber, headSha). Every push opens a new round. The
  // round is what the database probe further down dedupes on, and that is the only
  // place `headSha` may be dropped from, and dropping it there resolves the probe to
  // a pull request that was already reviewed once and leaves the newest code with
  // no review at all.
  //
  // A round is NOT the identity of anything the reader sees, and that is the
  // change: the summary is ONE comment per pull request that every round edits in
  // place, and an inline thread belongs to a FINDING and outlives the round that
  // opened it, staying anchored across a force-push or a rebase. So the key handed
  // to the adapter identifies the PULL REQUEST and nothing narrower. Both adapters
  // render it into the `<!-- ai-workflow-review:... -->` marker they search for to
  // find that one summary. The head commit travels separately in `headSha`, and
  // each adapter writes it into a marker of its own so it can still recognise a
  // round it already published.
  //
  // Deliberately not the content hash, ever. While the marker carried it, a
  // reworded finding published a second full review (AIW-234), and any change to
  // the verdict rule above would have published one on every pull request already
  // reviewed.
  const idempotencyKey = createHash("sha256")
    .update(
      JSON.stringify({
        provider: args.target.provider,
        repository: args.target.repoPath,
        prNumber: args.target.prNumber,
      }),
    )
    .digest("hex");
  // The round probe: keyed on the head commit and never on the content hash. A
  // content-keyed probe let reworded prose miss the published row, insert a second
  // one, and then record a publication that never happened, with GitLab's
  // positionally rebuilt comment ids attributing this round's comments to the
  // previous round's discussions. One head is one review, in the database as well
  // as on the pull request.
  //
  // The cost, and it is a real one: the FIRST review of a head is the only one.
  // Neither a rewording nor a flipped verdict can revise it or reach the reader,
  // and the pull request keeps whatever the first round said until a new commit
  // opens a new round. The check run reports that same published verdict, so the
  // check and the review always agree.
  const roundRows = await args.db
    .select()
    .from(workflowPrReviewPublications)
    .where(
      and(
        eq(workflowPrReviewPublications.provider, args.target.provider),
        eq(workflowPrReviewPublications.repository, args.target.repoPath),
        eq(workflowPrReviewPublications.prNumber, args.target.prNumber),
        eq(workflowPrReviewPublications.headSha, args.target.headSha),
      ),
    )
    .orderBy(asc(workflowPrReviewPublications.createdAt));
  const publishedRound = roundRows.find((row) => row.state === "published");
  if (publishedRound) {
    // What is returned is what the pull request actually carries, not what this
    // round's reviewers said: complete_pr_check binds this summary into the
    // check run text and the Branch reads this decision, so returning fresh
    // prose would describe a review nobody can open. The first review of a head
    // wins, and a second opinion on the same commit is dropped rather than
    // published beside it.
    return {
      decision:
        publishedRound.decision === "approve" ? "approve" : "request_changes",
      summary: publishedRound.summary,
      inlineCommentCount: publishedRound.inlineCommentCount,
      summaryFallbackCount: publishedRound.summaryFallbackCount,
    };
  }
  // Markers earlier attempts at THIS round may have written, in no order that
  // matters: the adapters test for membership. A row that never reached
  // "published" can still have a review on the pull request, because the publish
  // call can succeed and the state update that follows it can be lost, and before
  // the key became stable that marker carried the row's content hash. Handing
  // those to the adapter keeps such a review recognised instead of posting a
  // second copy next to it.
  //
  // Same head only, and that is load-bearing: these rows come from the round query
  // above. A key from an earlier head would name a review of code that has since
  // been pushed over, and the adapter would hand that review back instead of
  // reviewing the current head.
  const priorIdempotencyKeys = roundRows.map((row) => row.contentHash);
  const existing = roundRows.find((row) => row.contentHash === contentHash);
  const publicationId = existing?.id ?? randomUUID();
  const commentRecords = comments.map((comment, index) => ({
    contentHash: reviewCommentContentHash(comment, index),
  }));
  if (!existing) {
    await args.db.insert(workflowPrReviewPublications).values({
      id: publicationId,
      runId: args.owner.runId!,
      nodeId: args.nodeId,
      attempt: args.attempt,
      activationScope: args.activationScope,
      provider: args.target.provider,
      repository: args.target.repoPath,
      prNumber: args.target.prNumber,
      headSha: args.target.headSha,
      contentHash,
      decision,
      summary,
      inlineCommentCount: comments.length,
      summaryFallbackCount: fallback.length,
    });
    if (comments.length > 0) {
      await args.db.insert(workflowPrReviewPublicationComments).values(
        commentRecords.map((comment) => ({
          publicationId,
          contentHash: comment.contentHash,
        })),
      );
    }
  }
  // Unconditional: a round with a published row returned above, so nothing here
  // is on record as published. A review can still be on the pull request without
  // a row that says so, and the adapter's marker lookup is what covers that.
  const beforePublish = await vcs.getPRHead(args.target.prNumber);
  if (
    beforePublish.headSha !== args.target.headSha ||
    beforePublish.state !== "open"
  ) {
    throw new Error(
      "The pull request changed before the review could be published.",
    );
  }
  let published;
  try {
    published = await vcs.publishPRReview(args.target.prNumber, {
      idempotencyKey,
      priorIdempotencyKeys,
      // Everything still reported that no inline comment carries. Both adapters
      // leave these threads open, so a finding demoted out of the inline set does
      // not read as resolved while the summary still lists it.
      deferredFindingDigests: deferredReviewFindingDigests(
        [...fallback, ...withheld],
        args.reviewResults.length,
      ),
      headSha: args.target.headSha,
      decision,
      summary,
      comments,
    });
  } catch (error) {
    const diagnosticId = randomUUID();
    console.error(
      `[${diagnosticId}] PR review publication failed:`,
      error instanceof Error ? error.message : String(error),
    );
    await args.db
      .update(workflowPrReviewPublications)
      .set({
        lastError: "Provider review publication failed.",
        diagnosticId,
        updatedAt: new Date(),
      })
      .where(eq(workflowPrReviewPublications.id, publicationId));
    throw new Error(
      `PR review publication failed. Diagnostic ID: ${diagnosticId}`,
    );
  }
  await args.db
    .update(workflowPrReviewPublications)
    .set({
      state: "published",
      providerReference: published.id,
      publishedAt: new Date(),
      updatedAt: new Date(),
      lastError: null,
    })
    .where(eq(workflowPrReviewPublications.id, publicationId));
  await args.db
    .update(workflowPrReviewPublicationComments)
    .set({ state: "published", publishedAt: new Date() })
    .where(
      eq(
        workflowPrReviewPublicationComments.publicationId,
        publicationId,
      ),
    );
  for (const [index, comment] of commentRecords.entries()) {
    const providerReference = published.commentIds[index];
    if (!providerReference) continue;
    await args.db
      .update(workflowPrReviewPublicationComments)
      .set({ providerReference })
      .where(
        and(
          eq(
            workflowPrReviewPublicationComments.publicationId,
            publicationId,
          ),
          eq(
            workflowPrReviewPublicationComments.contentHash,
            comment.contentHash,
          ),
        ),
      );
  }
  return {
    decision,
    summary,
    inlineCommentCount: comments.length,
    summaryFallbackCount: fallback.length,
  };
}
