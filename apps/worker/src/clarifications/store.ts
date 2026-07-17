import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { BlockOutput, ClarificationRequest, ClarificationStatus } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests } from "../db/schema.js";
import type { ClarificationSourceHead } from "../db/clarifications-schema.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import type { StepsRecord } from "../workflow-definition/interpreter.js";
import type { WorkflowDefinitionVersionPin } from "../workflows/agent-input.js";
import type { RunBudgetState } from "../workflows/run-budget.js";

export type ClarificationCheckpointState =
  | "preparing"
  | "ready"
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
  ticketKey: string;
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
  triggerPayload: BlockOutput;
  priorSteps: StepsRecord;
  budgetState: RunBudgetState;
  workspaceManifest: WorkspaceManifest | null;
  sourceHeads: ClarificationSourceHead[];
  checkpointState: ClarificationCheckpointState | null;
  expiresAt: Date | null;
  snapshotId: string | null;
  sourceSandboxId: string | null;
  snapshotExpiresAt: Date | null;
  cleanupState: ClarificationCleanupState;
  cleanupError: string | null;
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
    subjectKey: row.subjectKey ?? `ticket:jira:${row.ticketKey}`,
    ownerToken: row.ownerToken ?? `legacy:${row.runId}`,
    waitingNodeId: row.waitingNodeId ?? row.blockId ?? null,
    definitionVersionPin:
      row.definitionVersionPin ?? row.definitionVersion ?? null,
    triggerPayload: row.triggerPayload ?? { status: "legacy", ticketKey: row.ticketKey },
    priorSteps: row.priorSteps ?? {},
    budgetState: row.budgetState ?? emptyBudgetState(),
    workspaceManifest: row.workspaceManifest ?? null,
    sourceHeads: row.sourceHeads ?? [],
    checkpointState: (row.checkpointState as ClarificationCheckpointState | null) ?? null,
    expiresAt: row.expiresAt ?? null,
    snapshotId: row.snapshotId ?? null,
    sourceSandboxId: row.sourceSandboxId ?? null,
    snapshotExpiresAt: row.snapshotExpiresAt ?? null,
    cleanupState: row.cleanupState as ClarificationCleanupState,
    cleanupError: row.cleanupError ?? null,
    successorOwnerToken: row.successorOwnerToken ?? null,
    successorReservedAt: row.successorReservedAt ?? null,
    publishedAt: row.publishedAt ?? null,
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

export interface CreateClarificationCheckpointInput {
  ticketKey: string;
  subjectKey: string;
  ownerToken: string;
  runId: string;
  waitingNodeId: string;
  definitionId: number | null;
  definitionVersionPin: WorkflowDefinitionVersionPin;
  triggerPayload: BlockOutput;
  priorSteps: StepsRecord;
  budgetState: RunBudgetState;
  workspaceManifest: WorkspaceManifest | null;
  sourceHeads: ClarificationSourceHead[];
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
  const rows = await db
    .insert(clarificationRequests)
    .values({
      id: randomUUID(),
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
      triggerPayload: input.triggerPayload,
      priorSteps: input.priorSteps,
      budgetState: input.budgetState,
      workspaceManifest: input.workspaceManifest,
      sourceHeads: input.sourceHeads,
      expiresAt: input.expiresAt,
      questions: input.questions,
      suggestedAnswers: input.suggestedAnswers ?? null,
      status: "superseded",
      checkpointState: "preparing",
      cleanupState: "none",
    })
    .returning();
  return mapRow(rows[0]!);
}

export interface ClarificationSnapshotMetadata {
  snapshotId: string;
  sourceSandboxId: string;
  expiresAt: Date;
}

/** Marks the checkpoint restorable. A null snapshot is valid for workspace-free runs. */
export async function completeClarificationCheckpoint(
  db: Db,
  id: string,
  snapshot: ClarificationSnapshotMetadata | null,
): Promise<ClarificationRow> {
  const rows = await db
    .update(clarificationRequests)
    .set({
      checkpointState: "ready",
      snapshotId: snapshot?.snapshotId ?? null,
      sourceSandboxId: snapshot?.sourceSandboxId ?? null,
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
    throw new ClarificationStoreError(409, "clarification_checkpoint_not_preparing");
  }
  return mapRow(rows[0]);
}

/**
 * Makes a ready checkpoint answerable. Replacement is intentionally ordered:
 * the new durable row already exists, the old pending row is retired, then the
 * new row is published. A crash between the last two writes leaves a ready row
 * that reconciliation/retry can safely publish; it never loses the checkpoint.
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
    return { row: checkpoint, supersededSnapshots: [] };
  }

  const replaced = await db
    .update(clarificationRequests)
    .set({
      status: "superseded",
      cleanupState: cleanupStateAfterRetirement(),
    })
    .where(
      and(
        eq(clarificationRequests.ticketKey, checkpoint.ticketKey),
        eq(clarificationRequests.status, "pending"),
        ne(clarificationRequests.id, checkpoint.id),
      ),
    )
    .returning({ snapshotId: clarificationRequests.snapshotId });

  const rows = await db
    .update(clarificationRequests)
    .set({ status: "pending", publishedAt: now })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.status, "superseded"),
        eq(clarificationRequests.checkpointState, "ready"),
      ),
    )
    .returning();
  if (!rows[0]) {
    throw new ClarificationStoreError(409, "clarification_checkpoint_publish_conflict");
  }
  return {
    row: mapRow(rows[0]),
    supersededSnapshots: replaced
      .map((row) => row.snapshotId)
      .filter((snapshotId): snapshotId is string => snapshotId !== null),
  };
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
  // neon-http (loaded inside the WDK step that runs this block) has no interactive
  // transactions. Supersede the current pending row, then insert the new one; the
  // partial unique index (one pending row per ticket) still guarantees a single
  // open clarification. If the insert fails, the run fails and re-runs a fresh ask.
  await db
    .update(clarificationRequests)
    .set({ status: "superseded", cleanupState: cleanupStateAfterRetirement() })
    .where(
      and(
        eq(clarificationRequests.ticketKey, input.ticketKey),
        eq(clarificationRequests.status, "pending"),
      ),
    );
  const rows = await db
    .insert(clarificationRequests)
    .values({
      id: randomUUID(),
      ticketKey: input.ticketKey,
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

/** Durable parked subjects that generic run reconciliation must not release. */
export async function listPendingClarificationSubjectKeys(db: Db): Promise<string[]> {
  const rows = await db
    .select({ subjectKey: clarificationRequests.subjectKey })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.status, "pending"),
        eq(clarificationRequests.checkpointState, "ready"),
        isNotNull(clarificationRequests.subjectKey),
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
          and(
            eq(clarificationRequests.status, "answered"),
            isNull(clarificationRequests.dispatchedRunId),
          ),
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
    const reason = expired
      ? "expired"
      : (pending || unpublished) && !hasExactPredecessor
        ? "orphaned"
        : null;
    if (!reason) {
      if (unpublished && row.checkpointState === "ready") {
        try {
          await publishClarificationCheckpoint(db, row.id, now);
        } catch (error) {
          if (!(error instanceof ClarificationStoreError) || error.statusCode !== 409) {
            throw error;
          }
        }
      }
      continue;
    }

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

export async function markClarificationSnapshotDeleted(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(clarificationRequests)
    .set({ cleanupState: "deleted", cleanupError: null })
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
    .set({ cleanupState: "deleted", cleanupError: null })
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
    .set({ cleanupState: "delete_pending", cleanupError: null })
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
): Promise<ClarificationSnapshotCleanupCandidate[]> {
  const rows = await db
    .select({
      clarificationId: clarificationRequests.id,
      snapshotId: clarificationRequests.snapshotId,
    })
    .from(clarificationRequests)
    .where(
      and(
        inArray(clarificationRequests.cleanupState, ["delete_pending", "failed"]),
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
): Promise<boolean> {
  const rows = await db
    .update(clarificationRequests)
    .set({ cleanupState: "deleting", cleanupError: null })
    .where(
      and(
        eq(clarificationRequests.id, id),
        inArray(clarificationRequests.cleanupState, ["delete_pending", "failed"]),
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
    .set({ cleanupState: "failed", cleanupError: error.slice(0, 1_000) })
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
    .set({ cleanupState: "failed", cleanupError: error.slice(0, 1_000) })
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

export async function setDispatchedRunId(db: Db, id: string, runId: string): Promise<void> {
  await db
    .update(clarificationRequests)
    .set({ dispatchedRunId: runId })
    .where(eq(clarificationRequests.id, id));
}

/**
 * Resume run's self-heal for a lost endpoint write. The answer endpoint records
 * the dispatched run best-effort; if that single write is lost the answered row
 * would stay dispatched_run_id=null forever and read as retryable, spawning a
 * duplicate resume run. The resume run itself calls this on pickup. Guarded on
 * dispatched_run_id IS NULL so it never overwrites an id the endpoint already
 * set. Returns whether a row was written.
 */
export async function recordDispatchedRun(db: Db, id: string, runId: string): Promise<boolean> {
  const rows = await db
    .update(clarificationRequests)
    .set({ dispatchedRunId: runId })
    .where(
      and(
        eq(clarificationRequests.id, id),
        isNull(clarificationRequests.dispatchedRunId),
      ),
    )
    .returning({ id: clarificationRequests.id });
  return rows.length > 0;
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
