import { and, eq, gte, inArray } from "drizzle-orm";
import type {
  BlockRunState,
  HarnessRunManifestRecord,
} from "@shared/contracts";
import { getDb, type Db } from "../../client.js";
import type { RunKind } from "@shared/contracts";
import { activeRuns, workflowOwnedBranches, workflowRuns } from "../../schema.js";

/**
 * Postgres read path for the dashboard. Replaces the Vercel Workflow `world.runs`
 * collectors for the recent-runs list, the overview KPIs, the workflows table,
 * and the cost view — sourcing from the durable `workflow_runs` telemetry table
 * instead. Three things this unlocks that the world API could not:
 *   - per-run cost/tokens (persisted by recordRunUsage; the world API has neither)
 *   - real time-window filtering on `started_at` (the world API caps at 100 rows)
 *   - ticket search across all history (indexed `ticket_key` / `ticket_title`)
 *
 * SECURITY: every caller-supplied value reaches SQL only as a *bound parameter*.
 * The window is whitelisted to an enum (parseWindow) → a JS-computed cutoff Date;
 * the search string is bound into an ILIKE pattern with its wildcards escaped
 * (parseSearch + searchCondition). The dashboard sends typed intent, never SQL.
 */

/**
 * True when the run has already recorded a terminal "failed" outcome. The Jira
 * webhook consults this before cancelling a run whose ticket left the AI
 * column: the bot's own failure handling moves a failed ticket to the backlog,
 * which fires that webhook, and cancelling would overwrite the run's genuine
 * failure with a "cancelled" status the errors KPI never counts.
 */
export async function isRunRecordedFailed(db: Db, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return row?.status === "failed";
}

export function isConnectedRunRecordedFailed(runId: string): Promise<boolean> {
  return isRunRecordedFailed(getDb(), runId);
}

/**
 * True when the run has already recorded a terminal "success" outcome. Same
 * webhook guard as isRunRecordedFailed: the bot's own success finalization
 * moves a finished ticket to AI Review, which fires the "ticket left the AI
 * column" webhook, and cancelling would overwrite the run's genuine success
 * with a "cancelled" status even though the PR and ticket move already landed.
 */
export async function isRunRecordedSucceeded(db: Db, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return row?.status === "success";
}

export function isConnectedRunRecordedSucceeded(runId: string): Promise<boolean> {
  return isRunRecordedSucceeded(getDb(), runId);
}

/**
 * True when this exact run has durable PR/publication evidence. Agent PR
 * telemetry lands only at terminal completion, so an active run additionally
 * correlates its current claim to a confirmed workflow-owned publication for
 * the same ticket. The timestamp boundary rejects a prior run's ticket-scoped
 * PR row. Exact-run workflow telemetry remains valid for gate and legacy runs.
 */
export async function hasDurableRunPublication(db: Db, runId: string): Promise<boolean> {
  const [row] = await db
    .select({
      prRepo: workflowRuns.prRepo,
      prUrl: workflowRuns.prUrl,
      prNumber: workflowRuns.prNumber,
      prs: workflowRuns.prs,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  if (
    row &&
    row.prNumber !== null &&
    row.prNumber > 0 &&
    ((typeof row.prUrl === "string" && row.prUrl.trim().length > 0) ||
      (typeof row.prRepo === "string" && row.prRepo.trim().length > 0))
  ) {
    return true;
  }
  if (
    row &&
    Array.isArray(row.prs) &&
    row.prs.some(
      (pr) =>
        Boolean(
          pr &&
            (pr.provider === "github" || pr.provider === "gitlab") &&
            typeof pr.repoPath === "string" &&
            pr.repoPath.trim().length > 0 &&
            typeof pr.id === "number" &&
            pr.id > 0 &&
            typeof pr.url === "string" &&
            pr.url.trim().length > 0,
        ),
    )
  ) {
    return true;
  }

  const publications = await db
    .select({
      provider: workflowOwnedBranches.provider,
      repoPath: workflowOwnedBranches.repoPath,
      branchName: workflowOwnedBranches.branchName,
      publishedHeadSha: workflowOwnedBranches.publishedHeadSha,
      targetBranch: workflowOwnedBranches.targetBranch,
      prId: workflowOwnedBranches.prId,
      prUrl: workflowOwnedBranches.prUrl,
      prBranchName: workflowOwnedBranches.prBranchName,
      prPublishedHeadSha: workflowOwnedBranches.prPublishedHeadSha,
      prTargetBranch: workflowOwnedBranches.prTargetBranch,
    })
    .from(activeRuns)
    .innerJoin(
      workflowOwnedBranches,
      eq(workflowOwnedBranches.ticketKey, activeRuns.ticketKey),
    )
    .where(
      and(
        eq(activeRuns.runId, runId),
        eq(workflowOwnedBranches.prCorrelationPending, false),
        gte(workflowOwnedBranches.updatedAt, activeRuns.createdAt),
      ),
    );

  return publications.some(
    (publication) =>
      (publication.provider === "github" || publication.provider === "gitlab") &&
      publication.repoPath.trim().length > 0 &&
      publication.branchName.trim().length > 0 &&
      Boolean(publication.publishedHeadSha?.trim()) &&
      Boolean(publication.targetBranch?.trim()) &&
      publication.prId !== null &&
      publication.prId > 0 &&
      Boolean(publication.prUrl?.trim()) &&
      Boolean(publication.prBranchName?.trim()) &&
      Boolean(publication.prPublishedHeadSha?.trim()) &&
      Boolean(publication.prTargetBranch?.trim()),
  );
}

export function hasConnectedDurableRunPublication(runId: string): Promise<boolean> {
  return hasDurableRunPublication(getDb(), runId);
}

/**
 * Reverse lookup for cancel-by-id: the live claim that currently owns a run,
 * addressed by run id instead of subject key. `active_runs` holds only in-flight
 * claims (one row per active subject) and has no index on run_id, but the table
 * is tiny, so the scan is cheap. Returns the subject and its exact owner token
 * so an operator cancel can drive cancelSubjectRunDetailed for a run that has no
 * ticket at all (a webhook or schedule trigger). The ticket and kind let manual
 * ticket cancellation withdraw its AI-column enrolment before release. Null
 * when no live claim carries this run id: the run is already terminal or
 * unknown, and the caller falls back to workflow_runs.
 */
export async function findLiveRunClaimByRunId(
  db: Db,
  runId: string,
): Promise<{
  subjectKey: string;
  ticketKey: string | null;
  ownerToken: string;
  kind: RunKind;
} | null> {
  const [row] = await db
    .select({
      subjectKey: activeRuns.subjectKey,
      ticketKey: activeRuns.ticketKey,
      ownerToken: activeRuns.ownerToken,
      kind: activeRuns.runKind,
    })
    .from(activeRuns)
    .where(eq(activeRuns.runId, runId))
    .limit(1);
  return row ? { ...row, kind: row.kind as RunKind } : null;
}

export function findConnectedLiveRunClaimByRunId(runId: string) {
  return findLiveRunClaimByRunId(getDb(), runId);
}

/**
 * Terminal-side half of the cancel-by-id reverse lookup: once a run has left
 * `active_runs` its durable outcome lives in `workflow_runs`, keyed by run id
 * (PK). Returns the recorded status (null when the row exists but a status-less
 * writer created it), or null when no row exists at all, which the caller reads
 * as an unknown run id. This is the fallback consulted only after the live
 * lookup misses, so it never sees a run that is still cancellable.
 */
export async function findRunOutcomeByRunId(
  db: Db,
  runId: string,
): Promise<{ status: string | null } | null> {
  const [row] = await db
    .select({ status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return row ?? null;
}

export function findConnectedRunOutcomeByRunId(runId: string) {
  return findRunOutcomeByRunId(getDb(), runId);
}

// ── Model attribution for rows built outside this module ─────────────────────

/**
 * Attributed models for the given run ids, from the same evidence the run list
 * uses. The Overview's live rows are built from the run registry, which knows
 * nothing about models; they override the store row by id on the runs and ticket
 * screens (mergeLiveRuns), so without this an in-flight run would show the org
 * default on exactly the screens the store already labels honestly. Ids with no
 * row, and runs with no attributable model, are simply absent from the map.
 */
export async function fetchRunModels(
  db: Db,
  runIds: string[],
): Promise<Map<string, string>> {
  const models = new Map<string, string>();
  if (runIds.length === 0) return models;

  const rows = await db
    .select({
      runId: workflowRuns.runId,
      model: workflowRuns.model,
    })
    .from(workflowRuns)
    .where(inArray(workflowRuns.runId, runIds));

  for (const row of rows) {
    if (row.model) models.set(row.runId, row.model);
  }
  return models;
}

/** DB-shaped model attribution evidence. Interpreting the evidence belongs to
 * the overview service, where presentation policy is owned. */
export interface RunModelEvidenceRow {
  model: string | null;
  harnessManifests: HarnessRunManifestRecord[] | null;
  blockStatuses: Record<string, Omit<BlockRunState, "output">> | null;
}

export async function fetchRunModelEvidence(
  db: Db,
  runIds: string[],
): Promise<Map<string, RunModelEvidenceRow>> {
  const evidence = new Map<string, RunModelEvidenceRow>();
  if (runIds.length === 0) return evidence;
  const rows = await db.select({
    runId: workflowRuns.runId,
    model: workflowRuns.model,
    harnessManifests: workflowRuns.harnessManifests,
    blockStatuses: workflowRuns.blockStatuses,
  }).from(workflowRuns).where(inArray(workflowRuns.runId, runIds));
  for (const row of rows) {
    evidence.set(row.runId, {
      model: row.model,
      harnessManifests: row.harnessManifests,
      blockStatuses: row.blockStatuses,
    });
  }
  return evidence;
}

export function fetchConnectedRunModelEvidence(runIds: string[]) {
  return fetchRunModelEvidence(getDb(), runIds);
}

export async function listRunPullRequestUrls(db: Db, runId: string): Promise<string[]> {
  const [row] = await db
    .select({ prs: workflowRuns.prs })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return (row?.prs ?? []).map((pr) => pr.url);
}

export function listConnectedRunPullRequestUrls(runId: string): Promise<string[]> {
  return listRunPullRequestUrls(getDb(), runId);
}
