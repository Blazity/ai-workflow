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
} from "../db/schema.js";
import {
  hasGateStatusCapability,
  hasPRFilesCapability,
  hasPRReviewCapability,
  type GateStatusUpdate,
  type PRFile,
  type PRReviewInlineComment,
} from "../adapters/vcs/types.js";
import { assertActiveRunOwner, type ActiveRunOwner } from "../lib/active-run-owner.js";
import type { PrTriggerPayload } from "./agent-input.js";

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

function checkProviderUpdate(
  conclusion: CheckTerminalIntent,
  details: string,
): GateStatusUpdate {
  const mapped =
    conclusion === "cancelled"
      ? "cancelled"
      : conclusion === "timed_out"
        ? "timed_out"
        : conclusion === "superseded"
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
    );
    await args.db
      .update(workflowRunExternalChecks)
      .set({ providerReference, state: "pending", updatedAt: new Date() })
      .where(eq(workflowRunExternalChecks.id, id));
  } catch (error) {
    await args.db
      .update(workflowRunExternalChecks)
      .set({
        closureIntent: "failure",
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
}): Promise<void> {
  const [check] = await args.db
    .select()
    .from(workflowRunExternalChecks)
    .where(eq(workflowRunExternalChecks.id, args.reference.id))
    .limit(1);
  if (
    !check ||
    check.runId !== args.owner.runId ||
    check.headSha !== args.target.headSha ||
    check.headSha !== args.reference.headSha ||
    check.name !== args.reference.name
  ) {
    throw new Error(
      "The PR check does not belong to this workflow run and pull request head.",
    );
  }
  if (check.state === "completed") return;
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
}): Promise<{ closed: number; pending: number }> {
  const rows = await args.db
    .select()
    .from(workflowRunExternalChecks)
    .where(
      and(
        eq(workflowRunExternalChecks.runId, args.runId),
        inArray(workflowRunExternalChecks.state, ["pending", "closing"]),
      ),
    );
  let closed = 0;
  let pending = 0;
  for (const check of rows) {
    const intent =
      check.closureIntent === "superseded"
        ? "superseded"
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

export async function reconcilePendingPrChecks(
  db: Db,
  limit = 25,
): Promise<{ attempted: number; closed: number; pending: number }> {
  const rows = await db
    .select()
    .from(workflowRunExternalChecks)
    .where(
      inArray(workflowRunExternalChecks.state, ["creating", "closing"]),
    )
    .orderBy(asc(workflowRunExternalChecks.updatedAt))
    .limit(limit);
  const groups = new Map<string, { intent: CheckTerminalIntent; details: string }>();
  for (const row of rows) {
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
        const providerReference = await vcs.createGateStatus(row.name, row.headSha);
        await db
          .update(workflowRunExternalChecks)
          .set({
            providerReference,
            state: "closing",
            closureIntent: row.closureIntent ?? "failure",
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
    groups.set(row.runId, {
      intent: row.closureIntent as CheckTerminalIntent,
      details: row.lastError ?? "Retrying PR check completion.",
    });
  }
  let closed = 0;
  let pending = 0;
  for (const [runId, value] of groups) {
    const result = await closeRunPrChecks({ db, runId, ...value });
    closed += result.closed;
    pending += result.pending;
  }
  return { attempted: groups.size, closed, pending };
}

function normalizedPath(path: string): string | null {
  const value = path.replace(/^(a|b)\//, "");
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return value;
}

export function changedNewSideLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let current = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      current = Number(hunk[1]);
      continue;
    }
    if (current === 0 || line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    lines.add(current);
    current++;
  }
  return lines;
}

export function partitionReviewFindings(
  results: ReviewResult[],
  files: PRFile[],
): {
  comments: PRReviewInlineComment[];
  fallback: Array<ReviewResult["findings"][number]>;
} {
  const fileLines = new Map(
    files
      .filter((file) => file.patch)
      .map((file) => [file.path, changedNewSideLines(file.patch!)]),
  );
  const comments: PRReviewInlineComment[] = [];
  const fallback: Array<ReviewResult["findings"][number]> = [];
  for (const result of results) {
    for (const finding of result.findings) {
      const path = normalizedPath(finding.file);
      const start = finding.startLine;
      const end = finding.endLine ?? start;
      const changed = path ? fileLines.get(path) : undefined;
      const rangeLength =
        start !== undefined && end !== undefined ? end - start + 1 : 0;
      const locatable =
        path !== null &&
        start !== undefined &&
        end !== undefined &&
        changed !== undefined &&
        rangeLength <= changed.size &&
        rangeContainsOnlyChangedSideLines(changed, start, end);
      if (!locatable) {
        fallback.push(finding);
        continue;
      }
      comments.push({
        path,
        startLine: start,
        endLine: end,
        body: `**${finding.severity}** — ${finding.description}`,
      });
    }
  }
  return { comments, fallback };
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

function reviewSummary(
  results: ReviewResult[],
  fallback: Array<ReviewResult["findings"][number]>,
): string {
  const feedback = results
    .map((result) => result.feedback?.trim())
    .filter((value): value is string => Boolean(value));
  const lines = ["## AI Workflow review"];
  if (feedback.length > 0) lines.push("", ...feedback.map((value) => `- ${value}`));
  if (fallback.length > 0) {
    lines.push("", "### Findings not placed inline");
    for (const finding of fallback) {
      const location = finding.startLine
        ? `${finding.file}:${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ""}`
        : finding.file;
      lines.push(`- **${finding.severity}** \`${location}\` — ${finding.description}`);
    }
  }
  if (results.every((result) => result.findings.length === 0) && feedback.length === 0) {
    lines.push("", "No findings.");
  }
  return lines.join("\n");
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
  const { comments, fallback } = partitionReviewFindings(args.reviewResults, files);
  const decision = args.reviewResults.every(
    (result) => result.decision === "approve",
  )
    ? "approve"
    : "request_changes";
  const summary = reviewSummary(args.reviewResults, fallback);
  const normalized = {
    provider: args.target.provider,
    repository: args.target.repoPath,
    prNumber: args.target.prNumber,
    headSha: args.target.headSha,
    decision,
    results: args.reviewResults,
  };
  const contentHash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  const [existing] = await args.db
    .select()
    .from(workflowPrReviewPublications)
    .where(
      and(
        eq(workflowPrReviewPublications.provider, args.target.provider),
        eq(workflowPrReviewPublications.repository, args.target.repoPath),
        eq(workflowPrReviewPublications.prNumber, args.target.prNumber),
        eq(workflowPrReviewPublications.headSha, args.target.headSha),
        eq(workflowPrReviewPublications.contentHash, contentHash),
      ),
    )
    .limit(1);
  const publicationId = existing?.id ?? randomUUID();
  const commentRecords = comments.map((comment) => ({
    contentHash: createHash("sha256")
      .update(JSON.stringify(comment))
      .digest("hex"),
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
  if (existing?.state !== "published") {
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
        idempotencyKey: contentHash,
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
  }
  return {
    decision,
    summary,
    inlineCommentCount: comments.length,
    summaryFallbackCount: fallback.length,
  };
}
