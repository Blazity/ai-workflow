import {
  and,
  desc,
  eq,
  gt,
  lt,
  sql,
} from "drizzle-orm";
import type {
  ReplayAttemptOutcome,
  ReplayAttemptState,
  ReplayCaptureStatus,
  ReplaySanitizedEnvelope,
  WorkflowReplayGraphSnapshot,
  WorkflowReplayLayoutSnapshot,
  WorkflowReplaySelectedTransition,
} from "@shared/contracts";
import { getDb, type Db } from "../../client.js";
import {
  workflowBlockAttempts,
  workflowRunObservations,
  workflowRuns,
} from "../../schema.js";

const REPLAY_RETENTION_DAYS = 30;
export const DEFAULT_REPLAY_PAGE_LIMIT = 100;
export const MAX_REPLAY_PAGE_LIMIT = 200;
const DEFAULT_REPLAY_CLEANUP_LIMIT = 100;
const MAX_REPLAY_CLEANUP_LIMIT = 500;

export class RunObservationStoreError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "RunObservationStoreError";
  }
}

export interface CaptureRunObservationStartInput {
  db: Db;
  runId: string;
  organizationId: string;
  definitionId: number;
  definitionVersion: number;
  definitionSchemaVersion: 1 | 2;
  graph: WorkflowReplayGraphSnapshot;
  layout: WorkflowReplayLayoutSnapshot;
  runtimeManifest: ReplaySanitizedEnvelope;
  captureStatus?: ReplayCaptureStatus;
  now?: Date;
  retentionDays?: number;
}

export interface CaptureRunObservationStartResult {
  captureStatus: ReplayCaptureStatus;
  capturedAt: Date;
  expiresAt: Date;
}

export interface MarkRunReplayCaptureUnavailableInput {
  db: Db;
  runId: string;
  organizationId: string;
  failedAt?: Date;
}

export interface StartWorkflowBlockAttemptInput {
  db: Db;
  runId: string;
  organizationId: string;
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  startedAt?: Date;
}

export interface StartWorkflowBlockAttemptResult {
  attemptId: number;
}

export interface GetWorkflowBlockAttemptPersistenceInput {
  db: Db;
  runId: string;
  organizationId: string;
  attemptId: number;
}

export interface WorkflowBlockAttemptPersistence {
  state: ReplayAttemptState;
  outcome: ReplayAttemptOutcome | null;
  selectedTransition: WorkflowReplaySelectedTransition | null;
  diagnosticId: string | null;
  inputEnvelope: ReplaySanitizedEnvelope | null;
  outputEnvelope: ReplaySanitizedEnvelope | null;
  logEnvelope: ReplaySanitizedEnvelope | null;
  metadataEnvelope: ReplaySanitizedEnvelope | null;
  observationRevision: number;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
}

export interface ReplaceWorkflowBlockAttemptPersistenceInput {
  db: Db;
  runId: string;
  organizationId: string;
  attemptId: number;
  expectedRevision: number;
  state: ReplayAttemptState;
  outcome: ReplayAttemptOutcome | null;
  selectedTransition: WorkflowReplaySelectedTransition | null;
  diagnosticId: string | null;
  inputEnvelope: ReplaySanitizedEnvelope | null;
  outputEnvelope: ReplaySanitizedEnvelope | null;
  logEnvelope: ReplaySanitizedEnvelope | null;
  metadataEnvelope: ReplaySanitizedEnvelope | null;
  completedAt: Date | null;
  durationMs: number | null;
  updatedAt: Date;
}

export interface DeleteExpiredRunObservationsInput {
  db: Db;
  now?: Date;
  limit?: number;
}

export interface DeleteExpiredRunObservationsResult {
  deleted: number;
  runIds: string[];
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new RunObservationStoreError(400, `${field} must not be empty`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RunObservationStoreError(
      400,
      `${field} must be a positive integer`,
    );
  }
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function retentionExpiry(now: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new RunObservationStoreError(
      400,
      "retentionDays must be an integer between 1 and 365",
    );
  }
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function normalizeCleanupLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_REPLAY_CLEANUP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RunObservationStoreError(400, "limit must be a positive integer");
  }
  return Math.min(limit, MAX_REPLAY_CLEANUP_LIMIT);
}

export async function captureRunObservationStart(
  input: CaptureRunObservationStartInput,
): Promise<CaptureRunObservationStartResult> {
  assertNonEmpty(input.runId, "runId");
  assertNonEmpty(input.organizationId, "organizationId");
  assertPositiveInteger(input.definitionId, "definitionId");
  assertPositiveInteger(input.definitionVersion, "definitionVersion");
  const now = input.now ?? new Date();
  const expiresAt = retentionExpiry(
    now,
    input.retentionDays ?? REPLAY_RETENTION_DAYS,
  );
  const captureStatus = input.captureStatus ?? "available";
  const graph = JSON.stringify(input.graph);
  const layout = JSON.stringify(input.layout);
  const manifest = JSON.stringify(structuredClone(input.runtimeManifest));
  const result = await input.db.execute(sql`
    WITH requested AS (
      SELECT
        ${input.runId}::text AS run_id,
        ${input.organizationId}::text AS organization_id,
        ${input.definitionId}::integer AS definition_id,
        ${input.definitionVersion}::integer AS definition_version,
        ${input.definitionSchemaVersion}::integer AS definition_schema_version,
        ${graph}::jsonb AS graph,
        ${layout}::jsonb AS layout,
        ${manifest}::jsonb AS runtime_manifest,
        ${captureStatus}::text AS capture_status,
        ${now}::timestamptz AS captured_at,
        ${expiresAt}::timestamptz AS expires_at
    ),
    claimed_run AS (
      INSERT INTO workflow_runs (
        run_id,
        replay_organization_id,
        replay_captured_at,
        replay_expires_at,
        updated_at
      )
      SELECT
        run_id,
        organization_id,
        captured_at,
        expires_at,
        captured_at
      FROM requested
      ON CONFLICT (run_id) DO UPDATE
      SET
        replay_organization_id = coalesce(
          workflow_runs.replay_organization_id,
          excluded.replay_organization_id
        ),
        replay_captured_at = coalesce(
          workflow_runs.replay_captured_at,
          excluded.replay_captured_at
        ),
        replay_expires_at = coalesce(
          workflow_runs.replay_expires_at,
          excluded.replay_expires_at
        ),
        updated_at = CASE
          WHEN workflow_runs.replay_captured_at IS NULL THEN excluded.updated_at
          ELSE workflow_runs.updated_at
        END
      WHERE (
        workflow_runs.replay_organization_id IS NULL
        OR workflow_runs.replay_organization_id = excluded.replay_organization_id
      )
      AND workflow_runs.replay_capture_failed_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_run_observations existing
        CROSS JOIN requested
        WHERE existing.run_id = requested.run_id
          AND (
            existing.organization_id <> requested.organization_id
            OR existing.definition_id <> requested.definition_id
            OR existing.definition_version <> requested.definition_version
            OR existing.definition_schema_version
              <> requested.definition_schema_version
            OR existing.graph <> requested.graph
            OR existing.layout <> requested.layout
            OR existing.runtime_manifest <> requested.runtime_manifest
            OR existing.capture_status <> requested.capture_status
          )
      )
      RETURNING
        run_id,
        replay_captured_at,
        replay_expires_at
    ),
    inserted AS (
      INSERT INTO workflow_run_observations (
        run_id,
        organization_id,
        definition_id,
        definition_version,
        definition_schema_version,
        graph,
        layout,
        runtime_manifest,
        capture_status,
        captured_at,
        updated_at,
        expires_at
      )
      SELECT
        requested.run_id,
        requested.organization_id,
        requested.definition_id,
        requested.definition_version,
        requested.definition_schema_version,
        requested.graph,
        requested.layout,
        requested.runtime_manifest,
        requested.capture_status,
        claimed_run.replay_captured_at,
        claimed_run.replay_captured_at,
        claimed_run.replay_expires_at
      FROM requested
      INNER JOIN claimed_run ON claimed_run.run_id = requested.run_id
      ON CONFLICT (run_id) DO NOTHING
      RETURNING capture_status, captured_at, expires_at
    )
    SELECT capture_status, captured_at, expires_at
    FROM inserted
    UNION ALL
    SELECT
      existing.capture_status,
      existing.captured_at,
      existing.expires_at
    FROM workflow_run_observations existing
    INNER JOIN claimed_run ON claimed_run.run_id = existing.run_id
    CROSS JOIN requested
    WHERE existing.run_id = requested.run_id
      AND existing.organization_id = requested.organization_id
      AND existing.definition_id = requested.definition_id
      AND existing.definition_version = requested.definition_version
      AND existing.definition_schema_version = requested.definition_schema_version
      AND existing.graph = requested.graph
      AND existing.layout = requested.layout
      AND existing.runtime_manifest = requested.runtime_manifest
      AND existing.capture_status = requested.capture_status
      AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
  `);
  const [row] = rawRows<{
    capture_status: ReplayCaptureStatus;
    captured_at: Date | string;
    expires_at: Date | string;
  }>(result);
  if (!row) {
    throw new RunObservationStoreError(
      409,
      "Run replay snapshot conflicts with an existing immutable capture",
    );
  }
  return {
    captureStatus: row.capture_status,
    capturedAt: asDate(row.captured_at),
    expiresAt: asDate(row.expires_at),
  };
}

export function captureConnectedRunObservationStart(
  input: Omit<CaptureRunObservationStartInput, "db">,
): Promise<CaptureRunObservationStartResult> {
  return captureRunObservationStart({ ...input, db: getDb() });
}

/**
 * Monotonically marks replay capture as incomplete for a run. The marker is
 * stored on the long-lived run row so a timed-out write that completes later
 * cannot make a partial replay appear available.
 */
export async function markRunReplayCaptureUnavailable(
  input: MarkRunReplayCaptureUnavailableInput,
): Promise<void> {
  assertNonEmpty(input.runId, "runId");
  assertNonEmpty(input.organizationId, "organizationId");
  const failedAt = input.failedAt ?? new Date();
  const result = await input.db.execute(sql`
    INSERT INTO workflow_runs (
      run_id,
      replay_organization_id,
      replay_capture_failed_at,
      updated_at
    )
    VALUES (
      ${input.runId},
      ${input.organizationId},
      ${failedAt},
      ${failedAt}
    )
    ON CONFLICT (run_id) DO UPDATE
    SET
      replay_organization_id = coalesce(
        workflow_runs.replay_organization_id,
        excluded.replay_organization_id
      ),
      replay_capture_failed_at = coalesce(
        workflow_runs.replay_capture_failed_at,
        excluded.replay_capture_failed_at
      ),
      updated_at = CASE
        WHEN workflow_runs.replay_capture_failed_at IS NULL
          THEN excluded.updated_at
        ELSE workflow_runs.updated_at
      END
    WHERE workflow_runs.replay_organization_id IS NULL
      OR workflow_runs.replay_organization_id = excluded.replay_organization_id
    RETURNING run_id
  `);
  if (rawRows(result).length === 0) {
    throw new RunObservationStoreError(
      409,
      "Run replay capture belongs to another organization",
    );
  }
}

export function markConnectedRunReplayCaptureUnavailable(
  input: Omit<MarkRunReplayCaptureUnavailableInput, "db">,
) {
  return markRunReplayCaptureUnavailable({ ...input, db: getDb() });
}

export async function startWorkflowBlockAttempt(
  input: StartWorkflowBlockAttemptInput,
): Promise<StartWorkflowBlockAttemptResult> {
  assertNonEmpty(input.runId, "runId");
  assertNonEmpty(input.organizationId, "organizationId");
  assertNonEmpty(input.nodeId, "nodeId");
  assertNonEmpty(input.activationScopeId, "activationScopeId");
  assertPositiveInteger(input.attempt, "attempt");
  const startedAt = input.startedAt ?? new Date();
  const result = await input.db.execute(sql`
    WITH requested AS (
      SELECT
        ${input.runId}::text AS run_id,
        ${input.organizationId}::text AS organization_id,
        ${input.nodeId}::text AS node_id,
        ${input.attempt}::integer AS attempt,
        ${input.activationScopeId}::text AS activation_scope_id,
        ${startedAt}::timestamptz AS started_at
    ),
    available_observation AS (
      SELECT requested.*
      FROM requested
      INNER JOIN workflow_run_observations observation
        ON observation.run_id = requested.run_id
        AND observation.organization_id = requested.organization_id
      INNER JOIN workflow_runs run
        ON run.run_id = requested.run_id
      WHERE observation.capture_status = 'available'
        AND observation.expires_at > requested.started_at
        AND run.replay_capture_failed_at IS NULL
    ),
    allocated AS (
      INSERT INTO workflow_block_attempts (
        run_id,
        organization_id,
        node_id,
        attempt,
        activation_scope_id,
        state,
        started_at,
        created_at,
        updated_at
      )
      SELECT
        run_id,
        organization_id,
        node_id,
        attempt,
        activation_scope_id,
        'running',
        started_at,
        started_at,
        started_at
      FROM available_observation
      ON CONFLICT (run_id, node_id, attempt, activation_scope_id) DO UPDATE
      SET updated_at = workflow_block_attempts.updated_at
      RETURNING id AS attempt_id
    )
    SELECT attempt_id FROM allocated
  `);
  const [allocated] = rawRows<{ attempt_id: number }>(result);
  if (!allocated) {
    throw new RunObservationStoreError(
      404,
      "Replay observation is not available",
    );
  }
  return { attemptId: allocated.attempt_id };
}

export function startConnectedWorkflowBlockAttempt(
  input: Omit<StartWorkflowBlockAttemptInput, "db">,
) {
  return startWorkflowBlockAttempt({ ...input, db: getDb() });
}

export async function getWorkflowBlockAttemptPersistence(
  input: GetWorkflowBlockAttemptPersistenceInput,
): Promise<WorkflowBlockAttemptPersistence | null> {
  const [row] = await input.db
    .select({
      state: workflowBlockAttempts.state,
      outcome: workflowBlockAttempts.outcome,
      selectedTransition: workflowBlockAttempts.selectedTransition,
      diagnosticId: workflowBlockAttempts.diagnosticId,
      inputEnvelope: workflowBlockAttempts.inputEnvelope,
      outputEnvelope: workflowBlockAttempts.outputEnvelope,
      logEnvelope: workflowBlockAttempts.logEnvelope,
      metadataEnvelope: workflowBlockAttempts.metadataEnvelope,
      observationRevision: workflowBlockAttempts.observationRevision,
      startedAt: workflowBlockAttempts.startedAt,
      completedAt: workflowBlockAttempts.completedAt,
      durationMs: workflowBlockAttempts.durationMs,
    })
    .from(workflowBlockAttempts)
    .where(
      and(
        eq(workflowBlockAttempts.id, input.attemptId),
        eq(workflowBlockAttempts.runId, input.runId),
        eq(workflowBlockAttempts.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function getConnectedWorkflowBlockAttemptPersistence(
  input: Omit<GetWorkflowBlockAttemptPersistenceInput, "db">,
) {
  return getWorkflowBlockAttemptPersistence({ ...input, db: getDb() });
}

export async function replaceWorkflowBlockAttemptPersistence(
  input: ReplaceWorkflowBlockAttemptPersistenceInput,
): Promise<boolean> {
  const rows = await input.db
    .update(workflowBlockAttempts)
    .set({
      state: input.state,
      outcome: input.outcome,
      selectedTransition: input.selectedTransition,
      diagnosticId: input.diagnosticId,
      inputEnvelope: input.inputEnvelope,
      outputEnvelope: input.outputEnvelope,
      logEnvelope: input.logEnvelope,
      metadataEnvelope: input.metadataEnvelope,
      observationRevision: input.expectedRevision + 1,
      completedAt: input.completedAt,
      durationMs: input.durationMs,
      updatedAt: input.updatedAt,
    })
    .where(
      and(
        eq(workflowBlockAttempts.id, input.attemptId),
        eq(workflowBlockAttempts.runId, input.runId),
        eq(workflowBlockAttempts.organizationId, input.organizationId),
        eq(workflowBlockAttempts.observationRevision, input.expectedRevision),
      ),
    )
    .returning({ id: workflowBlockAttempts.id });
  return rows.length > 0;
}

export function replaceConnectedWorkflowBlockAttemptPersistence(
  input: Omit<ReplaceWorkflowBlockAttemptPersistenceInput, "db">,
) {
  return replaceWorkflowBlockAttemptPersistence({ ...input, db: getDb() });
}

export async function readRunReplayRun(
  db: Db,
  runId: string,
  organizationId: string,
) {
  const [run] = await db
    .select({
      organizationId: workflowRuns.replayOrganizationId,
      capturedAt: workflowRuns.replayCapturedAt,
      expiresAt: workflowRuns.replayExpiresAt,
      failedAt: workflowRuns.replayCaptureFailedAt,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.runId, runId),
      eq(workflowRuns.replayOrganizationId, organizationId),
    ))
    .limit(1);
  return run ?? null;
}

export async function readRunReplayObservation(
  db: Db,
  runId: string,
  organizationId: string,
  now: Date,
) {
  const [observation] = await db
    .select()
    .from(workflowRunObservations)
    .where(
      and(
        eq(workflowRunObservations.runId, runId),
        eq(workflowRunObservations.organizationId, organizationId),
        gt(workflowRunObservations.expiresAt, now),
      ),
    )
    .limit(1);
  return observation ?? null;
}

export function listRunReplayAttemptRows(
  db: Db,
  input: { runId: string; organizationId: string; afterId: number | null; limit: number },
) {
  return db.select().from(workflowBlockAttempts)
    .where(and(
      eq(workflowBlockAttempts.runId, input.runId),
      eq(workflowBlockAttempts.organizationId, input.organizationId),
      ...(input.afterId === null ? [] : [lt(workflowBlockAttempts.id, input.afterId)]),
    ))
    .orderBy(desc(workflowBlockAttempts.id))
    .limit(input.limit);
}

export async function readRunReplayAttemptRow(
  db: Db,
  input: { runId: string; organizationId: string; attemptId: number },
) {
  const [row] = await db.select().from(workflowBlockAttempts)
    .where(and(
      eq(workflowBlockAttempts.id, input.attemptId),
      eq(workflowBlockAttempts.runId, input.runId),
      eq(workflowBlockAttempts.organizationId, input.organizationId),
    ))
    .limit(1);
  return row ?? null;
}

export function readConnectedRunReplayRun(runId: string, organizationId: string) {
  return readRunReplayRun(getDb(), runId, organizationId);
}

export function readConnectedRunReplayObservation(
  runId: string,
  organizationId: string,
  now: Date,
) {
  return readRunReplayObservation(getDb(), runId, organizationId, now);
}

export function listConnectedRunReplayAttemptRows(
  input: Parameters<typeof listRunReplayAttemptRows>[1],
) {
  return listRunReplayAttemptRows(getDb(), input);
}

export function readConnectedRunReplayAttemptRow(
  input: Parameters<typeof readRunReplayAttemptRow>[1],
) {
  return readRunReplayAttemptRow(getDb(), input);
}

export async function deleteExpiredRunObservations(
  input: DeleteExpiredRunObservationsInput,
): Promise<DeleteExpiredRunObservationsResult> {
  const now = input.now ?? new Date();
  const limit = normalizeCleanupLimit(input.limit);
  const result = await input.db.execute(sql`
    WITH due AS (
      SELECT run_id
      FROM workflow_run_observations
      WHERE expires_at <= ${now}
      ORDER BY expires_at ASC, run_id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM workflow_run_observations observation
    USING due
    WHERE observation.run_id = due.run_id
    RETURNING observation.run_id
  `);
  const runIds = rawRows<{ run_id: string }>(result).map(
    ({ run_id }) => run_id,
  );
  return { deleted: runIds.length, runIds };
}

export function deleteConnectedExpiredRunObservations(
  input: Omit<DeleteExpiredRunObservationsInput, "db">,
): Promise<DeleteExpiredRunObservationsResult> {
  return deleteExpiredRunObservations({ ...input, db: getDb() });
}
