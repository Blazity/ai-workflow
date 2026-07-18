import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { BlockOutput, ClarificationRequest, ClarificationStatus } from "@shared/contracts";
import type { RunKind } from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests } from "../db/schema.js";
import type {
  ClarificationRuntimeContext,
  ClarificationSourceHead,
} from "../db/clarifications-schema.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import type {
  InterpreterControlState,
  StepsRecord,
} from "../workflow-definition/interpreter.js";
import type {
  ClarificationOriginEntry,
  WorkflowDefinitionVersionPin,
} from "../workflows/agent-input.js";
import type { WorkflowBlockType } from "@shared/contracts";
import type { RunBudgetFailure, RunBudgetState } from "../workflows/run-budget.js";

export type ClarificationCheckpointState =
  | "preparing"
  | "ready"
  | "consumed"
  | "cancelled"
  | "budget_exhausted"
  | "expired"
  | "orphaned";

export type ClarificationCleanupState =
  | "none"
  | "retained"
  | "delete_pending"
  | "deleting"
  | "deleted"
  | "failed";

export interface ClarificationRow {
  id: string;
  ticketKey: string | null;
  runId: string;
  blockId: string | null;
  definitionId: number | null;
  definitionVersion: number | null;
  questions: string[];
  suggestedAnswers: string[] | null;
  status: ClarificationStatus;
  askedAt: Date;
  answer: string | null;
  answeredById: string | null;
  answeredByLabel: string | null;
  answeredAt: Date | null;
  dispatchedRunId: string | null;
  subjectKey: string;
  ownerToken: string;
  waitingNodeId: string | null;
  definitionVersionPin: WorkflowDefinitionVersionPin | null;
  originEntry: ClarificationOriginEntry;
  originTriggerNodeId: string;
  originTriggerType: WorkflowBlockType;
  triggerPayload: BlockOutput;
  priorSteps: StepsRecord;
  interpreterState: InterpreterControlState;
  budgetState: RunBudgetState;
  runtimeContext: ClarificationRuntimeContext;
  workspaceManifest: WorkspaceManifest | null;
  sourceHeads: ClarificationSourceHead[];
  checkpointState: ClarificationCheckpointState | null;
  expiresAt: Date | null;
  snapshotId: string | null;
  sourceSandboxId: string | null;
  snapshotRequestedAt: Date | null;
  snapshotExpiresAt: Date | null;
  cleanupState: ClarificationCleanupState;
  cleanupError: string | null;
  cleanupClaimedAt: Date | null;
  successorOwnerToken: string | null;
  successorReservedAt: Date | null;
  publishedAt: Date | null;
}

/** Domain-level failure a write raises (409 conflict). Routes map statusCode onto
 *  the HTTP response; distinct from the 403 auth gate. */
export class ClarificationStoreError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type ClarificationSelect = typeof clarificationRequests.$inferSelect;

function mapRow(row: ClarificationSelect): ClarificationRow {
  const fallbackTicketKey = row.ticketKey ?? row.subjectKey ?? row.id;
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    runId: row.runId,
    blockId: row.blockId ?? null,
    definitionId: row.definitionId ?? null,
    definitionVersion: row.definitionVersion ?? null,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers ?? null,
    status: row.status as ClarificationStatus,
    askedAt: row.askedAt,
    answer: row.answer,
    answeredById: row.answeredById,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt,
    dispatchedRunId: row.dispatchedRunId,
    subjectKey: row.subjectKey ?? `ticket:jira:${fallbackTicketKey}`,
    ownerToken: row.ownerToken ?? `legacy:${row.runId}`,
    waitingNodeId: row.waitingNodeId ?? row.blockId ?? null,
    definitionVersionPin:
      row.definitionVersionPin ?? row.definitionVersion ?? null,
    originEntry: row.originEntry ?? { kind: "ticket", ticketKey: fallbackTicketKey },
    originTriggerNodeId: row.originTriggerNodeId ?? row.waitingNodeId ?? row.blockId ?? "trigger",
    originTriggerType: row.originTriggerType ?? "trigger_ticket_ai",
    triggerPayload: row.triggerPayload ?? {
      status: "legacy",
      ...(row.ticketKey ? { ticketKey: row.ticketKey } : {}),
    },
    priorSteps: row.priorSteps ?? {},
    interpreterState: row.interpreterState ?? { attempts: {}, executions: 0 },
    budgetState: row.budgetState ?? emptyBudgetState(),
    runtimeContext: row.runtimeContext ?? emptyRuntimeContext(),
    workspaceManifest: row.workspaceManifest ?? null,
    sourceHeads: row.sourceHeads ?? [],
    checkpointState: (row.checkpointState as ClarificationCheckpointState | null) ?? null,
    expiresAt: row.expiresAt ?? null,
    snapshotId: row.snapshotId ?? null,
    sourceSandboxId: row.sourceSandboxId ?? null,
    snapshotRequestedAt: row.snapshotRequestedAt ?? null,
    snapshotExpiresAt: row.snapshotExpiresAt ?? null,
    cleanupState: row.cleanupState as ClarificationCleanupState,
    cleanupError: row.cleanupError ?? null,
    cleanupClaimedAt: row.cleanupClaimedAt ?? null,
    successorOwnerToken: row.successorOwnerToken ?? null,
    successorReservedAt: row.successorReservedAt ?? null,
    publishedAt: row.publishedAt ?? null,
  };
}

function emptyRuntimeContext(): ClarificationRuntimeContext {
  return {
    preSandboxAdditions: { research: [], implementation: [], review: [] },
  };
}

function emptyBudgetState(): RunBudgetState {
  return {
    activeElapsedMs: 0,
    tokensInput: 0,
    tokensCached: 0,
    tokensOutput: 0,
    tokensKnown: true,
    costNanos: 0,
    costUsd: 0,
    costKnown: true,
  };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export interface CreateClarificationCheckpointInput {
  ticketKey: string | null;
  subjectKey: string;
  ownerToken: string;
  runId: string;
  waitingNodeId: string;
  definitionId: number | null;
  definitionVersionPin: WorkflowDefinitionVersionPin;
  originEntry: ClarificationOriginEntry;
  originTriggerNodeId: string;
  originTriggerType: WorkflowBlockType;
  triggerPayload: BlockOutput;
  priorSteps: StepsRecord;
  interpreterState: InterpreterControlState;
  budgetState: RunBudgetState;
  runtimeContext: ClarificationRuntimeContext;
  workspaceManifest: WorkspaceManifest | null;
  sourceHeads: ClarificationSourceHead[];
  sourceSandboxId: string | null;
  snapshotRequestedAt: Date | null;
  expiresAt: Date;
  questions: string[];
  suggestedAnswers?: string[] | null;
}

/**
 * Persists the complete replay-free continuation payload without making the
 * question answerable. Publishing is a separate transition after snapshot
 * creation has stopped the source sandbox and made the checkpoint restorable.
 */
export async function createClarificationCheckpoint(
  db: Db,
  input: CreateClarificationCheckpointInput,
): Promise<ClarificationRow> {
  const id = `clarification:${createHash("sha256")
    .update(`${input.subjectKey}\0${input.runId}\0${input.waitingNodeId}`)
    .digest("hex")}`;
  const rows = await db
    .insert(clarificationRequests)
    .values({
      id,
      ticketKey: input.ticketKey,
      subjectKey: input.subjectKey,
      ownerToken: input.ownerToken,
      runId: input.runId,
      blockId: input.waitingNodeId,
      waitingNodeId: input.waitingNodeId,
      definitionId: input.definitionId,
      definitionVersion:
        typeof input.definitionVersionPin === "number"
          ? input.definitionVersionPin
          : null,
      definitionVersionPin: input.definitionVersionPin,
      originEntry: input.originEntry,
      originTriggerNodeId: input.originTriggerNodeId,
      originTriggerType: input.originTriggerType,
      triggerPayload: input.triggerPayload,
      priorSteps: input.priorSteps,
      interpreterState: input.interpreterState,
      budgetState: input.budgetState,
      runtimeContext: input.runtimeContext,
      workspaceManifest: input.workspaceManifest,
      sourceHeads: input.sourceHeads,
      sourceSandboxId: input.sourceSandboxId,
      snapshotRequestedAt: input.snapshotRequestedAt,
      expiresAt: input.expiresAt,
      questions: input.questions,
      suggestedAnswers: input.suggestedAnswers ?? null,
      status: "superseded",
      checkpointState: "preparing",
      cleanupState: "none",
    })
    .onConflictDoNothing({ target: clarificationRequests.id })
    .returning();
  if (rows[0]) return mapRow(rows[0]);
  const existing = await getClarification(db, id);
  if (
    !existing ||
    existing.subjectKey !== input.subjectKey ||
    existing.ownerToken !== input.ownerToken ||
    existing.runId !== input.runId ||
    existing.waitingNodeId !== input.waitingNodeId
  ) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_identity_conflict");
  }
  return existing;
}

export interface ClarificationSnapshotMetadata {
  snapshotId: string;
  sourceSandboxId: string;
  expiresAt: Date;
}

/**
 * Adopts an externally-created snapshot before any later provider polling.
 * This is deliberately separate from checkpoint completion: a snapshot ID is
 * cleanup-critical as soon as the provider returns it, while the question must
 * not become answerable until the source sandbox is confirmed stopped.
 */
export async function recordClarificationSnapshotMetadata(
  db: Db,
  id: string,
  snapshot: ClarificationSnapshotMetadata,
): Promise<ClarificationRow> {
  const current = await getClarification(db, id);
  if (!current) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_not_preparing");
  }
  assertSnapshotIdentity(current, snapshot);
  if (current.checkpointState === "cancelled") {
    await attachLateCancelledSnapshot(db, id, snapshot);
    throw new ClarificationStoreError(409, "clarification_checkpoint_cancelled");
  }
  if (current.checkpointState === "ready") {
    if (isSameSnapshotIdentity(current, snapshot)) return current;
    throw new ClarificationStoreError(409, "clarification_checkpoint_snapshot_conflict");
  }
  if (current.checkpointState !== "preparing") {
    throw new ClarificationStoreError(409, "clarification_checkpoint_not_preparing");
  }

  const rows = await db
    .update(clarificationRequests)
    .set({
      snapshotId: snapshot.snapshotId,
      sourceSandboxId: snapshot.sourceSandboxId,
      snapshotExpiresAt: snapshot.expiresAt,
      cleanupState: "retained",
      cleanupError: null,
      cleanupClaimedAt: null,
    })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.checkpointState, "preparing"),
        or(
          isNull(clarificationRequests.snapshotId),
          eq(clarificationRequests.snapshotId, snapshot.snapshotId),
        ),
        or(
          isNull(clarificationRequests.sourceSandboxId),
          eq(clarificationRequests.sourceSandboxId, snapshot.sourceSandboxId),
        ),
        or(
          isNull(clarificationRequests.snapshotExpiresAt),
          eq(clarificationRequests.snapshotExpiresAt, snapshot.expiresAt),
        ),
      ),
    )
    .returning();
  if (rows[0]) return mapRow(rows[0]);

  // Cancellation and replay can both win after the initial read. Re-read once
  // so a cancelled row adopts the cleanup ID, while the same persisted ID is
  // idempotent and conflicting provider objects are rejected explicitly.
  const refreshed = await getClarification(db, id);
  if (!refreshed) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_not_preparing");
  }
  assertSnapshotIdentity(refreshed, snapshot);
  if (refreshed.checkpointState === "cancelled") {
    await attachLateCancelledSnapshot(db, id, snapshot);
    throw new ClarificationStoreError(409, "clarification_checkpoint_cancelled");
  }
  if (
    (refreshed.checkpointState === "preparing" || refreshed.checkpointState === "ready") &&
    isSameSnapshotIdentity(refreshed, snapshot)
  ) {
    return refreshed;
  }
  throw new ClarificationStoreError(409, "clarification_checkpoint_not_preparing");
}

/** Marks the checkpoint restorable. A null snapshot is valid for workspace-free runs. */
export async function completeClarificationCheckpoint(
  db: Db,
  id: string,
  snapshot: ClarificationSnapshotMetadata | null,
): Promise<ClarificationRow> {
  const current = await getClarification(db, id);
  if (!current) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_not_preparing");
  }
  if (snapshot) assertSnapshotIdentity(current, snapshot);
  if (!snapshot && current.snapshotId !== null) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_snapshot_conflict");
  }
  if (current.checkpointState === "cancelled") {
    if (snapshot) await attachLateCancelledSnapshot(db, id, snapshot);
    throw new ClarificationStoreError(409, "clarification_checkpoint_cancelled");
  }
  if (current.checkpointState === "ready") {
    const sameSnapshot = snapshot
      ? current.snapshotId === snapshot.snapshotId &&
        current.sourceSandboxId === snapshot.sourceSandboxId &&
        current.snapshotExpiresAt?.getTime() === snapshot.expiresAt.getTime()
      : current.snapshotId === null;
    if (sameSnapshot) return current;
    throw new ClarificationStoreError(409, "clarification_checkpoint_snapshot_conflict");
  }
  const rows = await db
    .update(clarificationRequests)
    .set({
      checkpointState: "ready",
      snapshotId: snapshot?.snapshotId ?? null,
      sourceSandboxId: snapshot?.sourceSandboxId ?? current.sourceSandboxId,
      snapshotExpiresAt: snapshot?.expiresAt ?? null,
      cleanupState: snapshot ? "retained" : "none",
      cleanupError: null,
    })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.checkpointState, "preparing"),
      ),
    )
    .returning();
  if (!rows[0]) {
    if (snapshot && await attachLateCancelledSnapshot(db, id, snapshot)) {
      throw new ClarificationStoreError(409, "clarification_checkpoint_cancelled");
    }
    throw new ClarificationStoreError(409, "clarification_checkpoint_not_preparing");
  }
  return mapRow(rows[0]);
}

function assertSnapshotIdentity(
  current: ClarificationRow,
  snapshot: ClarificationSnapshotMetadata,
): void {
  if (
    current.sourceSandboxId !== null &&
    current.sourceSandboxId !== snapshot.sourceSandboxId
  ) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_source_conflict");
  }
  if (
    current.snapshotId !== null &&
    (current.snapshotId !== snapshot.snapshotId ||
      (current.snapshotExpiresAt !== null &&
        current.snapshotExpiresAt.getTime() !== snapshot.expiresAt.getTime()))
  ) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_snapshot_conflict");
  }
}

function isSameSnapshotIdentity(
  current: ClarificationRow,
  snapshot: ClarificationSnapshotMetadata,
): boolean {
  return (
    current.snapshotId === snapshot.snapshotId &&
    current.sourceSandboxId === snapshot.sourceSandboxId &&
    current.snapshotExpiresAt?.getTime() === snapshot.expiresAt.getTime()
  );
}

/** Snapshot creation is external and cannot share the checkpoint transaction.
 * If cancellation wins after creation, retain the late ID on the terminal row
 * and queue deletion before surfacing the cancelled completion boundary. */
async function attachLateCancelledSnapshot(
  db: Db,
  id: string,
  snapshot: ClarificationSnapshotMetadata,
): Promise<boolean> {
  const terminal = await getClarification(db, id);
  if (!terminal || terminal.checkpointState !== "cancelled") return false;
  assertSnapshotIdentity(terminal, snapshot);
  const rows = await db
    .update(clarificationRequests)
    .set({
      snapshotId: snapshot.snapshotId,
      sourceSandboxId: snapshot.sourceSandboxId,
      snapshotExpiresAt: snapshot.expiresAt,
      cleanupState: "delete_pending",
      cleanupError: null,
      cleanupClaimedAt: null,
    })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.checkpointState, "cancelled"),
        or(
          isNull(clarificationRequests.snapshotId),
          eq(clarificationRequests.snapshotId, snapshot.snapshotId),
        ),
      ),
    )
    .returning({ id: clarificationRequests.id });
  if (rows.length > 0) return true;

  // A concurrent late completion may have filled the same terminal metadata.
  // Re-read once so the same snapshot is idempotent and a different one fails
  // as an explicit conflict instead of becoming an untracked provider object.
  const refreshed = await getClarification(db, id);
  if (!refreshed || refreshed.checkpointState !== "cancelled") return false;
  assertSnapshotIdentity(refreshed, snapshot);
  return refreshed.snapshotId === snapshot.snapshotId;
}

export async function updateClarificationCheckpointBudget(
  db: Db,
  id: string,
  budgetState: RunBudgetState,
  budgetFailure: RunBudgetFailure | null = null,
): Promise<void> {
  const rows = await db
    .update(clarificationRequests)
    .set({
      budgetState,
      ...(budgetFailure
        ? {
            status: "superseded",
            checkpointState: "budget_exhausted",
            cleanupState: cleanupStateAfterRetirement(),
          }
        : {}),
    })
    .where(
      and(
        eq(clarificationRequests.id, id),
        inArray(clarificationRequests.checkpointState, ["preparing", "ready"]),
      ),
    )
    .returning({ id: clarificationRequests.id });
  if (!rows[0]) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_not_active");
  }
}

/**
 * Makes a ready checkpoint answerable. Exact owner proof, old-question
 * retirement, and publication share one SQL statement so an owner handoff can
 * never land between authorization and mutation.
 */
export async function publishClarificationCheckpoint(
  db: Db,
  id: string,
  now = new Date(),
): Promise<{ row: ClarificationRow; supersededSnapshots: string[] }> {
  const checkpoint = await getClarification(db, id);
  if (!checkpoint || checkpoint.checkpointState !== "ready") {
    throw new ClarificationStoreError(409, "clarification_checkpoint_not_ready");
  }
  if (checkpoint.expiresAt && checkpoint.expiresAt.getTime() <= now.getTime()) {
    throw new ClarificationStoreError(
      410,
      "clarification_checkpoint_expired: restart the ticket to rebuild the workspace",
    );
  }
  if (checkpoint.status === "pending") {
    await consumeAnsweredPredecessor(db, checkpoint);
    return { row: checkpoint, supersededSnapshots: [] };
  }

  const result = await db.execute(sql`
    WITH exact_owner AS MATERIALIZED (
      SELECT 1
      FROM active_runs
      WHERE subject_key = ${checkpoint.subjectKey}
        AND owner_token = ${checkpoint.ownerToken}
        AND run_id = ${checkpoint.runId}
        AND state = 'bound'
      FOR UPDATE
    ), candidate AS MATERIALIZED (
      SELECT id
      FROM clarification_requests
      WHERE id = ${id}
        AND status = 'superseded'
        AND checkpoint_state = 'ready'
        AND (expires_at IS NULL OR expires_at > ${now})
        AND EXISTS (SELECT 1 FROM exact_owner)
      FOR UPDATE
    ), retired AS (
      UPDATE clarification_requests AS previous
      SET status = 'superseded',
          cleanup_state = CASE
            WHEN previous.snapshot_id IS NOT NULL THEN 'delete_pending'
            ELSE previous.cleanup_state
          END
      WHERE previous.subject_key = ${checkpoint.subjectKey}
        AND previous.status = 'pending'
        AND previous.id <> ${id}
        AND EXISTS (SELECT 1 FROM candidate)
      RETURNING previous.snapshot_id
    ), published AS (
      UPDATE clarification_requests AS target
      SET status = 'pending', published_at = ${now}
      FROM candidate
      CROSS JOIN (SELECT count(*) FROM retired) AS retirement_barrier
      WHERE target.id = candidate.id
      RETURNING target.id
    ), consumed_predecessor AS (
      UPDATE clarification_requests AS predecessor
      SET checkpoint_state = 'consumed',
          cleanup_state = CASE
            WHEN predecessor.snapshot_id IS NOT NULL THEN 'delete_pending'
            ELSE predecessor.cleanup_state
          END,
          cleanup_error = NULL,
          cleanup_claimed_at = NULL
      WHERE predecessor.subject_key = ${checkpoint.subjectKey}
        AND predecessor.status = 'answered'
        AND predecessor.checkpoint_state = 'ready'
        AND predecessor.successor_owner_token = ${checkpoint.ownerToken}
        AND predecessor.dispatched_run_id = ${checkpoint.runId}
        AND predecessor.id <> ${id}
        AND EXISTS (SELECT 1 FROM published)
      RETURNING predecessor.id
    )
    SELECT
      (SELECT count(*)::integer FROM exact_owner) AS exact_owner_count,
      (SELECT id FROM published) AS published_id,
      (SELECT count(*)::integer FROM consumed_predecessor) AS consumed_predecessor_count,
      COALESCE(
        (SELECT jsonb_agg(snapshot_id) FILTER (WHERE snapshot_id IS NOT NULL) FROM retired),
        '[]'::jsonb
      ) AS superseded_snapshots
  `);
  const outcome = rawRows<{
    exact_owner_count: number;
    published_id: string | null;
    consumed_predecessor_count: number;
    superseded_snapshots: unknown;
  }>(result)[0];
  if (!outcome?.published_id) {
    if (Number(outcome?.exact_owner_count ?? 0) === 0) {
      throw new ClarificationStoreError(
        409,
        "clarification_checkpoint_predecessor_not_bound",
      );
    }
    throw new ClarificationStoreError(409, "clarification_checkpoint_publish_conflict");
  }
  const published = await getClarification(db, outcome.published_id);
  if (!published) {
    throw new ClarificationStoreError(500, "clarification_checkpoint_publish_not_readable");
  }
  return {
    row: published,
    supersededSnapshots: Array.isArray(outcome.superseded_snapshots)
      ? outcome.superseded_snapshots.filter(
          (snapshotId): snapshotId is string => typeof snapshotId === "string",
        )
      : [],
  };
}

/** A published follow-up checkpoint proves its run consumed the prior answer. */
async function consumeAnsweredPredecessor(
  db: Db,
  checkpoint: Pick<ClarificationRow, "id" | "subjectKey" | "ownerToken" | "runId">,
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({
      checkpointState: "consumed",
      cleanupState: cleanupStateAfterRetirement(),
      cleanupError: null,
      cleanupClaimedAt: null,
    })
    .where(
      and(
        eq(clarificationRequests.subjectKey, checkpoint.subjectKey),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.checkpointState, "ready"),
        eq(clarificationRequests.successorOwnerToken, checkpoint.ownerToken),
        eq(clarificationRequests.dispatchedRunId, checkpoint.runId),
        ne(clarificationRequests.id, checkpoint.id),
      ),
    );
}

/**
 * Inserts a fresh pending clarification for a ticket, superseding any existing
 * pending one for the same ticket so the partial unique index (one pending row
 * per ticket) never trips. The id is generated app-side.
 */
export async function createClarificationRequest(
  db: Db,
  input: {
    ticketKey: string;
    runId: string;
    blockId?: string | null;
    definitionId?: number | null;
    definitionVersion?: number | null;
    questions: string[];
    suggestedAnswers?: string[] | null;
  },
): Promise<ClarificationRow> {
  const subjectKey = `ticket:jira:${input.ticketKey.trim().toUpperCase()}`;
  // neon-http (loaded inside the WDK step that runs this block) has no interactive
  // transactions. Supersede the current pending row, then insert the new one; the
  // partial unique index (one pending row per ticket) still guarantees a single
  // open clarification. If the insert fails, the run fails and re-runs a fresh ask.
  await db
    .update(clarificationRequests)
    .set({ status: "superseded", cleanupState: cleanupStateAfterRetirement() })
    .where(
      and(
        eq(clarificationRequests.subjectKey, subjectKey),
        eq(clarificationRequests.status, "pending"),
      ),
    );
  const rows = await db
    .insert(clarificationRequests)
    .values({
      id: randomUUID(),
      ticketKey: input.ticketKey,
      subjectKey,
      runId: input.runId,
      blockId: input.blockId ?? null,
      definitionId: input.definitionId ?? null,
      definitionVersion: input.definitionVersion ?? null,
      questions: input.questions,
      suggestedAnswers: input.suggestedAnswers ?? null,
    })
    .returning();
  return mapRow(rows[0]!);
}

export async function getClarification(db: Db, id: string): Promise<ClarificationRow | null> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.id, id))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Latest clarification for a run (newest ask first); null when the run asked nothing. */
export async function getClarificationForRun(
  db: Db,
  runId: string,
): Promise<ClarificationRow | null> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(eq(clarificationRequests.runId, runId))
    .orderBy(desc(clarificationRequests.askedAt))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getPendingForTicket(
  db: Db,
  ticketKey: string,
): Promise<ClarificationRow | null> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.ticketKey, ticketKey),
        eq(clarificationRequests.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getPendingForSubject(
  db: Db,
  subjectKey: string,
): Promise<ClarificationRow | null> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.subjectKey, subjectKey),
        eq(clarificationRequests.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Durable clarification subjects that generic ticket dispatch/reconciliation
 * must not take over. Answered-ready rows stay protected across the route/start
 * crash window even when their exact successor owner has to be recreated. A
 * consumed checkpoint protects only its exact active continuation; this lets a
 * clarification resume outside AI without a racy provider pickup move, while a
 * later independent AI-column pickup remains possible after terminal release.
 */
export async function listProtectedClarificationSubjectKeys(db: Db): Promise<string[]> {
  const rows = await db
    .select({ subjectKey: clarificationRequests.subjectKey })
    .from(clarificationRequests)
    .where(
      and(
        isNotNull(clarificationRequests.subjectKey),
        or(
          and(
            inArray(clarificationRequests.status, ["pending", "answered"]),
            eq(clarificationRequests.checkpointState, "ready"),
          ),
          and(
            eq(clarificationRequests.status, "answered"),
            eq(clarificationRequests.checkpointState, "consumed"),
            isNotNull(clarificationRequests.successorOwnerToken),
            isNotNull(clarificationRequests.dispatchedRunId),
            sql`exists (
              select 1 from ${activeRuns}
              where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
                and ${activeRuns.ownerToken} = ${clarificationRequests.successorOwnerToken}
                and ${activeRuns.runId} = ${clarificationRequests.dispatchedRunId}
                and ${activeRuns.state} = 'bound'
            )`,
          ),
        ),
      ),
    );
  return rows
    .map((row) => row.subjectKey)
    .filter((subjectKey): subjectKey is string => subjectKey !== null);
}

/** Answer CAS succeeded but endpoint/start bookkeeping did not finish. */
export async function listUndispatchedAnsweredClarifications(
  db: Db,
  now = new Date(),
): Promise<ClarificationRow[]> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.checkpointState, "ready"),
        isNull(clarificationRequests.dispatchedRunId),
        isNotNull(clarificationRequests.successorOwnerToken),
      ),
    )
    .orderBy(asc(clarificationRequests.answeredAt));
  return rows
    .map(mapRow)
    .filter(
      (row) =>
        row.answer !== null &&
        (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()),
    );
}

/**
 * Recreates a missing clarification successor only while the durable
 * checkpoint is still dispatchable. Keeping this predicate in the same SQL
 * statement as the active-run insert prevents a cancellation that wins after
 * reconciliation's read from being undone by a stale recovery candidate. The
 * row lock linearizes this insert with the cancellation tombstone update.
 */
export async function reserveClarificationSuccessor(
  db: Db,
  input: {
    clarificationId: string;
    ownerToken: string;
    kind: RunKind;
  },
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into active_runs (
      subject_key,
      ticket_key,
      owner_token,
      run_id,
      state,
      run_kind,
      created_at,
      updated_at
    )
    select
      clarification.subject_key,
      clarification.ticket_key,
      clarification.successor_owner_token,
      null,
      'reserved',
      ${input.kind},
      now(),
      now()
    from clarification_requests as clarification
    where clarification.id = ${input.clarificationId}
      and clarification.status = 'answered'
      and clarification.checkpoint_state = 'ready'
      and clarification.successor_owner_token = ${input.ownerToken}
      and clarification.dispatched_run_id is null
      and (clarification.expires_at is null or clarification.expires_at > now())
      and (
        clarification.snapshot_id is null
        or (
          clarification.snapshot_expires_at > now()
          and clarification.cleanup_state = 'retained'
        )
      )
    for update of clarification
    on conflict (subject_key) do nothing
    returning subject_key
  `);
  return rawRows<{ subject_key: string }>(result).length > 0;
}

/** Answered Q&A history for a ticket, oldest first; injected into resume prompts. */
export async function listAnsweredForTicket(
  db: Db,
  ticketKey: string,
): Promise<ClarificationRow[]> {
  const rows = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.ticketKey, ticketKey),
        eq(clarificationRequests.status, "answered"),
      ),
    )
    .orderBy(asc(clarificationRequests.askedAt));
  return rows.map(mapRow);
}

/**
 * Compare-and-set answer: transitions a pending row to answered. Zero rows
 * updated means it was already answered (or superseded) by a racer, surfaced as
 * ClarificationStoreError(409) so callers release any held claim.
 */
export async function answerClarification(
  db: Db,
  input: {
    id: string;
    answer: string;
    actor: { id: string; label: string };
    successorOwnerToken?: string;
    now?: Date;
  },
): Promise<ClarificationRow> {
  const current = await getClarification(db, input.id);
  if (!current || current.status !== "pending") {
    throw new ClarificationStoreError(409, "already_answered");
  }
  const now = input.now ?? new Date();
  assertClarificationCheckpointAvailable(current, now);

  const rows = await db
    .update(clarificationRequests)
    .set({
      status: "answered",
      answer: input.answer,
      answeredById: input.actor.id,
      answeredByLabel: input.actor.label,
      answeredAt: now,
      ...(input.successorOwnerToken
        ? {
            successorOwnerToken: input.successorOwnerToken,
            successorReservedAt: now,
          }
        : {}),
    })
    .where(
      and(eq(clarificationRequests.id, input.id), eq(clarificationRequests.status, "pending")),
    )
    .returning();
  const row = rows[0];
  if (!row) {
    throw new ClarificationStoreError(409, "already_answered");
  }
  return mapRow(row);
}

/** Shared availability gate for the initial answer and answered-row dispatch retries. */
export function assertClarificationCheckpointAvailable(
  current: ClarificationRow,
  now = new Date(),
): void {
  if (
    current.checkpointState === "expired" ||
    (current.expiresAt !== null && current.expiresAt.getTime() <= now.getTime())
  ) {
    throw new ClarificationStoreError(
      410,
      "clarification_checkpoint_expired: restart the ticket to rebuild the workspace",
    );
  }
  if (current.checkpointState && current.checkpointState !== "ready") {
    throw new ClarificationStoreError(
      409,
      "clarification_checkpoint_unavailable: restart the ticket to rebuild the workspace",
    );
  }
  if (
    current.workspaceManifest &&
    (!current.snapshotId || !current.sourceSandboxId)
  ) {
    throw new ClarificationStoreError(
      409,
      "clarification_snapshot_unavailable: restart the ticket to rebuild the workspace",
    );
  }
  if (
    current.snapshotId &&
    (!current.snapshotExpiresAt ||
      current.snapshotExpiresAt.getTime() <= now.getTime())
  ) {
    throw new ClarificationStoreError(
      410,
      "clarification_snapshot_expired: restart the ticket to rebuild the workspace",
    );
  }
  if (current.snapshotId && current.cleanupState !== "retained") {
    throw new ClarificationStoreError(
      409,
      "clarification_snapshot_unavailable: restart the ticket to rebuild the workspace",
    );
  }
}

export interface ClarificationCleanupWork {
  clarificationId: string;
  snapshotId: string;
  reason: "expired" | "orphaned";
}

/**
 * Repairs unpublished rows and retires checkpoints that can no longer resume.
 * A pending row is live only while its exact predecessor owner/run stays bound.
 * Snapshot deletion is queued for a separate serializable Workflow step.
 */
export async function reconcileClarificationCheckpoints(
  db: Db,
  now = new Date(),
): Promise<ClarificationCleanupWork[]> {
  const checkpoints = await db
    .select()
    .from(clarificationRequests)
    .where(
      and(
        inArray(clarificationRequests.checkpointState, ["preparing", "ready"]),
        or(
          eq(clarificationRequests.status, "pending"),
          eq(clarificationRequests.status, "answered"),
          and(
            eq(clarificationRequests.status, "superseded"),
            isNull(clarificationRequests.publishedAt),
          ),
        ),
      ),
    );
  const owners = await db.select().from(activeRuns);
  const work: ClarificationCleanupWork[] = [];

  for (const raw of checkpoints) {
    const row = mapRow(raw);
    const expired =
      (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) ||
      (row.snapshotId !== null &&
        (row.snapshotExpiresAt === null ||
          row.snapshotExpiresAt.getTime() <= now.getTime()));
    const pending = row.status === "pending";
    const unpublished = row.status === "superseded" && row.publishedAt === null;
    const hasExactPredecessor = owners.some(
      (owner) =>
        owner.subjectKey === row.subjectKey &&
        owner.ownerToken === row.ownerToken &&
        owner.runId === row.runId &&
        owner.state === "bound",
    );
    const hasExactSuccessor = owners.some(
      (owner) =>
        owner.subjectKey === row.subjectKey &&
        owner.ownerToken === row.successorOwnerToken &&
        owner.runId === row.dispatchedRunId &&
        owner.state === "bound",
    );
    if (
      row.status === "answered" &&
      row.checkpointState === "ready" &&
      row.dispatchedRunId !== null &&
      !hasExactSuccessor
    ) {
      if (await hasPublishedSuccessorCheckpoint(db, row)) {
        await consumeAnsweredCheckpoint(db, row);
        continue;
      }
      await db
        .update(clarificationRequests)
        .set({ dispatchedRunId: null })
        .where(
          and(
            eq(clarificationRequests.id, row.id),
            eq(clarificationRequests.status, "answered"),
            eq(clarificationRequests.checkpointState, "ready"),
            eq(clarificationRequests.dispatchedRunId, row.dispatchedRunId),
          ),
        );
      continue;
    }
    if (
      !expired &&
      unpublished &&
      row.checkpointState === "ready" &&
      hasExactPredecessor
    ) {
      try {
        await publishClarificationCheckpoint(db, row.id, now);
      } catch (error) {
        if (!(error instanceof ClarificationStoreError) || error.statusCode !== 409) {
          throw error;
        }
      }
      continue;
    }
    const reason = expired
      ? "expired"
      : (pending || unpublished) && !hasExactPredecessor
        ? "orphaned"
        : null;
    if (!reason) continue;

    const cleanupState = row.snapshotId ? "delete_pending" : "deleted";
    const changed = await db
      .update(clarificationRequests)
      .set({
        status: "superseded",
        checkpointState: reason,
        cleanupState,
      })
      .where(
        and(
          eq(clarificationRequests.id, row.id),
          eq(clarificationRequests.status, row.status),
          eq(clarificationRequests.checkpointState, row.checkpointState!),
          ...(row.status === "answered"
            ? [isNull(clarificationRequests.dispatchedRunId)]
            : []),
        ),
      )
      .returning({ id: clarificationRequests.id });
    if (changed.length > 0 && row.snapshotId) {
      work.push({ clarificationId: row.id, snapshotId: row.snapshotId, reason });
    }
  }

  return work;
}

async function hasPublishedSuccessorCheckpoint(
  db: Db,
  row: ClarificationRow,
): Promise<boolean> {
  if (!row.successorOwnerToken || !row.dispatchedRunId) return false;
  const successors = await db
    .select({ id: clarificationRequests.id })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.subjectKey, row.subjectKey),
        eq(clarificationRequests.ownerToken, row.successorOwnerToken),
        eq(clarificationRequests.runId, row.dispatchedRunId),
        isNotNull(clarificationRequests.publishedAt),
        ne(clarificationRequests.id, row.id),
      ),
    )
    .limit(1);
  return successors.length > 0;
}

async function consumeAnsweredCheckpoint(db: Db, row: ClarificationRow): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({
      checkpointState: "consumed",
      cleanupState: cleanupStateAfterRetirement(),
      cleanupError: null,
      cleanupClaimedAt: null,
    })
    .where(
      and(
        eq(clarificationRequests.id, row.id),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.checkpointState, "ready"),
        eq(clarificationRequests.successorOwnerToken, row.successorOwnerToken!),
        eq(clarificationRequests.dispatchedRunId, row.dispatchedRunId!),
      ),
    );
}

export async function markClarificationSnapshotDeleted(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(clarificationRequests)
    .set({ cleanupState: "deleted", cleanupError: null, cleanupClaimedAt: null })
    .where(
      and(
        eq(clarificationRequests.id, id),
        inArray(clarificationRequests.cleanupState, [
          "delete_pending",
          "deleting",
          "failed",
        ]),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length > 0;
}

export async function markClarificationSnapshotDeletedBySnapshotId(
  db: Db,
  snapshotId: string,
): Promise<boolean> {
  const rows = await db
    .update(clarificationRequests)
    .set({ cleanupState: "deleted", cleanupError: null, cleanupClaimedAt: null })
    .where(
      and(
        eq(clarificationRequests.snapshotId, snapshotId),
        inArray(clarificationRequests.cleanupState, [
          "delete_pending",
          "deleting",
          "failed",
        ]),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length > 0;
}

/** Atomically owns terminal/replacement cleanup before the external delete step. */
export async function scheduleClarificationSnapshotCleanup(
  db: Db,
  id: string,
): Promise<string | null> {
  const rows = await db
    .update(clarificationRequests)
    .set({ cleanupState: "delete_pending", cleanupError: null, cleanupClaimedAt: null })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.cleanupState, "retained"),
      ),
    )
    .returning({ snapshotId: clarificationRequests.snapshotId });
  return rows[0]?.snapshotId ?? null;
}

export interface ClarificationSnapshotCleanupCandidate {
  clarificationId: string;
  snapshotId: string;
}

/** Failed deletes remain visible and are retried by the next reconciliation poll. */
export async function listClarificationSnapshotCleanup(
  db: Db,
  now = new Date(),
): Promise<ClarificationSnapshotCleanupCandidate[]> {
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1_000);
  const rows = await db
    .select({
      clarificationId: clarificationRequests.id,
      snapshotId: clarificationRequests.snapshotId,
    })
    .from(clarificationRequests)
    .where(
      and(
        or(
          inArray(clarificationRequests.cleanupState, ["delete_pending", "failed"]),
          and(
            eq(clarificationRequests.cleanupState, "deleting"),
            or(
              isNull(clarificationRequests.cleanupClaimedAt),
              lt(clarificationRequests.cleanupClaimedAt, staleBefore),
            ),
          ),
        ),
        isNotNull(clarificationRequests.snapshotId),
      ),
    )
    .orderBy(asc(clarificationRequests.askedAt));
  return rows.filter(
    (row): row is ClarificationSnapshotCleanupCandidate => row.snapshotId !== null,
  );
}

/** Claims one cleanup dispatch so concurrent cron requests cannot start duplicates. */
export async function claimClarificationSnapshotCleanup(
  db: Db,
  id: string,
  now = new Date(),
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1_000);
  const rows = await db
    .update(clarificationRequests)
    .set({ cleanupState: "deleting", cleanupError: null, cleanupClaimedAt: now })
    .where(
      and(
        eq(clarificationRequests.id, id),
        or(
          inArray(clarificationRequests.cleanupState, ["delete_pending", "failed"]),
          and(
            eq(clarificationRequests.cleanupState, "deleting"),
            or(
              isNull(clarificationRequests.cleanupClaimedAt),
              lt(clarificationRequests.cleanupClaimedAt, staleBefore),
            ),
          ),
        ),
        isNotNull(clarificationRequests.snapshotId),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length > 0;
}

export async function markClarificationSnapshotCleanupFailed(
  db: Db,
  id: string,
  error: string,
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({
      cleanupState: "failed",
      cleanupError: error.slice(0, 1_000),
      cleanupClaimedAt: null,
    })
    .where(
      and(
        eq(clarificationRequests.id, id),
        inArray(clarificationRequests.cleanupState, [
          "delete_pending",
          "deleting",
          "failed",
        ]),
      ),
    );
}

export async function markClarificationSnapshotCleanupFailedBySnapshotId(
  db: Db,
  snapshotId: string,
  error: string,
): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({
      cleanupState: "failed",
      cleanupError: error.slice(0, 1_000),
      cleanupClaimedAt: null,
    })
    .where(
      and(
        eq(clarificationRequests.snapshotId, snapshotId),
        inArray(clarificationRequests.cleanupState, [
          "delete_pending",
          "deleting",
          "failed",
        ]),
      ),
    );
}

/** Supersedes any pending clarification for a ticket; returns the number superseded. */
export async function supersedePendingForTicket(db: Db, ticketKey: string): Promise<number> {
  const rows = await db
    .update(clarificationRequests)
    .set({ status: "superseded", cleanupState: cleanupStateAfterRetirement() })
    .where(
      and(
        eq(clarificationRequests.ticketKey, ticketKey),
        eq(clarificationRequests.status, "pending"),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length;
}

/**
 * Terminal dead-end for a clarification whose ticket disappeared: supersede the
 * row by id regardless of its current status (pending or answered-without-run),
 * so the dashboard stops re-rendering an answer/retry form for a ticket that can
 * never resume. Guarded on dispatched_run_id IS NULL so a clarification that
 * already started a resume run keeps its answered history intact. Returns the
 * number of rows superseded.
 */
export async function supersedeClarification(db: Db, id: string): Promise<number> {
  const rows = await db
    .update(clarificationRequests)
    .set({ status: "superseded", cleanupState: cleanupStateAfterRetirement() })
    .where(
      and(
        eq(clarificationRequests.id, id),
        isNull(clarificationRequests.dispatchedRunId),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length;
}

function cleanupStateAfterRetirement() {
  return sql`case when ${clarificationRequests.snapshotId} is not null then 'delete_pending' else ${clarificationRequests.cleanupState} end`;
}

/**
 * Records only the successor that won the exact active-run owner bind. A retry
 * by that same winner is idempotently accepted so the enclosing Workflow step
 * can finish winner-bound ancillary work after a process interruption.
 */
export async function recordDispatchedRun(
  db: Db,
  id: string,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .update(clarificationRequests)
    .set({ dispatchedRunId: runId })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.checkpointState, "ready"),
        eq(clarificationRequests.successorOwnerToken, ownerToken),
        isNull(clarificationRequests.dispatchedRunId),
        sql`exists (
          select 1 from ${activeRuns}
          where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
            and ${activeRuns.ownerToken} = ${ownerToken}
            and ${activeRuns.runId} = ${runId}
            and ${activeRuns.state} = 'bound'
        )`,
      ),
    )
    .returning({ id: clarificationRequests.id });
  if (rows.length > 0) return true;

  const existing = await db
    .select({ id: clarificationRequests.id })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.checkpointState, "ready"),
        eq(clarificationRequests.successorOwnerToken, ownerToken),
        eq(clarificationRequests.dispatchedRunId, runId),
        sql`exists (
          select 1 from ${activeRuns}
          where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
            and ${activeRuns.ownerToken} = ${ownerToken}
            and ${activeRuns.runId} = ${runId}
            and ${activeRuns.state} = 'bound'
        )`,
      ),
    )
    .limit(1);
  return existing.length > 0;
}

/**
 * Crosses the replay boundary after the waiting block has successfully
 * consumed the human answer. Once consumed, later downstream failures must not
 * clear the winner and rerun already-completed side effects.
 */
export async function markClarificationCheckpointConsumed(
  db: Db,
  id: string,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .update(clarificationRequests)
    .set({
      checkpointState: "consumed",
      cleanupState: sql`case when ${clarificationRequests.snapshotId} is not null then 'delete_pending' else ${clarificationRequests.cleanupState} end`,
      cleanupError: null,
      cleanupClaimedAt: null,
    })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.checkpointState, "ready"),
        eq(clarificationRequests.successorOwnerToken, ownerToken),
        eq(clarificationRequests.dispatchedRunId, runId),
        sql`exists (
          select 1 from ${activeRuns}
          where ${activeRuns.subjectKey} = ${clarificationRequests.subjectKey}
            and ${activeRuns.ownerToken} = ${ownerToken}
            and ${activeRuns.runId} = ${runId}
            and ${activeRuns.state} = 'bound'
        )`,
      ),
    )
    .returning({ id: clarificationRequests.id });
  if (rows.length > 0) return true;

  const existing = await db
    .select({ id: clarificationRequests.id })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.checkpointState, "consumed"),
        eq(clarificationRequests.successorOwnerToken, ownerToken),
        eq(clarificationRequests.dispatchedRunId, runId),
      ),
    )
    .limit(1);
  return existing.length > 0;
}

export async function clearDispatchedRun(
  db: Db,
  id: string,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .update(clarificationRequests)
    .set({ dispatchedRunId: null })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.checkpointState, "ready"),
        eq(clarificationRequests.successorOwnerToken, ownerToken),
        eq(clarificationRequests.dispatchedRunId, runId),
        sql`not exists (
          select 1
          from clarification_requests as published_successor
          where published_successor.subject_key = ${clarificationRequests.subjectKey}
            and published_successor.owner_token = ${clarificationRequests.successorOwnerToken}
            and published_successor.run_id = ${clarificationRequests.dispatchedRunId}
            and published_successor.published_at is not null
            and published_successor.id <> ${clarificationRequests.id}
        )`,
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length > 0;
}

/**
 * Persists an operator cancellation before its exact active owner is changed.
 * It retires a pending question before a racing answer can win and also follows
 * the predecessor identity after an answer minted its successor token. The
 * cancelled tombstone keeps reconciliation from recreating that successor.
 * Snapshot cleanup is queued in the same write so no retained workspace leaks.
 */
export async function tombstoneClarificationCancellation(
  db: Db,
  input: {
    subjectKey: string;
    ownerToken: string;
    runId: string | null;
  },
): Promise<{ matched: boolean; successorOwnerToken: string | null }> {
  const cancelledDispatchedRun =
    input.runId === null
      ? sql`${clarificationRequests.dispatchedRunId}`
      : sql`case
          when ${clarificationRequests.successorOwnerToken} = ${input.ownerToken}
          then coalesce(${clarificationRequests.dispatchedRunId}, ${input.runId})
          else ${clarificationRequests.dispatchedRunId}
        end`;
  const rows = await db
    .update(clarificationRequests)
    .set({
      status: sql`case
        when ${clarificationRequests.status} = 'pending' then 'superseded'
        else ${clarificationRequests.status}
      end`,
      checkpointState: "cancelled",
      dispatchedRunId: cancelledDispatchedRun,
      cleanupState: cleanupStateAfterRetirement(),
      cleanupError: null,
      cleanupClaimedAt: null,
    })
    .where(
      and(
        eq(clarificationRequests.subjectKey, input.subjectKey),
        inArray(clarificationRequests.status, ["pending", "answered", "superseded"]),
        inArray(clarificationRequests.checkpointState, [
          "preparing",
          "ready",
          "cancelled",
        ]),
        or(
          input.runId === null
            ? eq(clarificationRequests.successorOwnerToken, input.ownerToken)
            : and(
                eq(clarificationRequests.ownerToken, input.ownerToken),
                eq(clarificationRequests.runId, input.runId),
              ),
          and(
            eq(clarificationRequests.successorOwnerToken, input.ownerToken),
            or(
              isNull(clarificationRequests.dispatchedRunId),
              ...(input.runId === null
                ? []
                : [eq(clarificationRequests.dispatchedRunId, input.runId)]),
            ),
          ),
        ),
      ),
    )
    .returning({ successorOwnerToken: clarificationRequests.successorOwnerToken });
  return rows[0]
    ? { matched: true, successorOwnerToken: rows[0].successorOwnerToken ?? null }
    : { matched: false, successorOwnerToken: null };
}

export function serializeClarification(row: ClarificationRow): ClarificationRequest {
  return {
    id: row.id,
    ticketKey: row.ticketKey,
    runId: row.runId,
    blockId: row.blockId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers,
    status: row.status,
    askedAt: row.askedAt.toISOString(),
    answer: row.answer,
    answeredById: row.answeredById,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt ? row.answeredAt.toISOString() : null,
    dispatchedRunId: row.dispatchedRunId,
  };
}
