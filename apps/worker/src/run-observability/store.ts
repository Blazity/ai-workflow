import {
  and,
  desc,
  eq,
  gt,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import type {
  ReplayAttemptOutcome,
  ReplayAttemptState,
  ReplayAvailability,
  ReplayCaptureStatus,
  ReplayObservationKind,
  ReplaySanitizedEnvelope,
  WorkflowReplayAttemptDetail,
  WorkflowReplayAttemptSummary,
  WorkflowReplayGraphSnapshot,
  WorkflowReplayLayoutSnapshot,
  WorkflowReplaySelectedTransition,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import { normalizeWorkflowDefinitionLayout } from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  workflowBlockAttempts,
  workflowRunObservations,
  workflowRuns,
} from "../db/schema.js";
import {
  appendReplayLogEnvelope,
  enforceReplayAttemptStorageBudget,
  REPLAY_ATTEMPT_MAX_BYTES,
  sanitizeReplayAttemptOutcome,
  sanitizeReplayGraphSnapshot,
  sanitizeReplayLayoutSnapshot,
  type ReplayAttemptEnvelopeSet,
} from "./sanitizer.js";
import { MAX_REPLAY_ATTEMPTS_PER_RUN } from "./limits.js";

export const REPLAY_RETENTION_DAYS = 30;
export const DEFAULT_REPLAY_PAGE_LIMIT = 100;
export const MAX_REPLAY_PAGE_LIMIT = 200;
export const DEFAULT_REPLAY_CLEANUP_LIMIT = 100;
const MAX_REPLAY_CLEANUP_LIMIT = 500;
const OBSERVATION_CAS_ATTEMPTS = 64;
const ATTEMPT_ROW_BUDGET_OVERHEAD = 1024;
const MAX_SELECTED_EDGE_IDS = 400;
const MAX_TRANSITION_IDENTIFIER_CHARACTERS = 200;

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
  secrets?: readonly string[];
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

export interface UpdateWorkflowBlockAttemptStateInput {
  db: Db;
  runId: string;
  organizationId: string;
  attemptId: number;
  state: "running" | "waiting_loop";
  selectedTransition?: WorkflowReplaySelectedTransition | null;
  observations?: readonly ReplayAttemptObservation[];
  updatedAt?: Date;
}

export interface ReplayAttemptObservation {
  kind: ReplayObservationKind;
  envelope: ReplaySanitizedEnvelope;
}

export interface RecordWorkflowBlockAttemptObservationInput {
  db: Db;
  runId: string;
  organizationId: string;
  attemptId: number;
  kind: ReplayAttemptObservation["kind"];
  envelope: ReplayAttemptObservation["envelope"];
  observedAt?: Date;
}

export interface FinishWorkflowBlockAttemptInput {
  db: Db;
  runId: string;
  organizationId: string;
  attemptId: number;
  state: ReplayAttemptState;
  outcome?: ReplayAttemptOutcome | null;
  selectedTransition?: WorkflowReplaySelectedTransition | null;
  diagnosticId?: string | null;
  observations?: readonly ReplayAttemptObservation[];
  completedAt?: Date;
}

export interface GetRunReplayInput {
  db: Db;
  runId: string;
  organizationId: string;
  limit?: number;
  cursor?: string | null;
  now?: Date;
}

export interface GetRunReplayAttemptInput {
  db: Db;
  runId: string;
  organizationId: string;
  attemptId: number;
  now?: Date;
}

export interface GetRunReplayAvailabilityInput {
  db: Db;
  runId: string;
  organizationId: string;
  now?: Date;
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

function replayCursor(attemptId: number): string {
  return Buffer.from(`attempt:${attemptId}`, "utf8").toString("base64url");
}

function parseReplayCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^attempt:(\d+)$/.exec(decoded);
    if (!match) throw new Error("invalid");
    const id = Number(match[1]);
    assertPositiveInteger(id, "cursor");
    return id;
  } catch {
    throw new RunObservationStoreError(400, "Invalid replay cursor");
  }
}

function normalizePageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_REPLAY_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RunObservationStoreError(400, "limit must be a positive integer");
  }
  return Math.min(limit, MAX_REPLAY_PAGE_LIMIT);
}

function normalizeCleanupLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_REPLAY_CLEANUP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RunObservationStoreError(400, "limit must be a positive integer");
  }
  return Math.min(limit, MAX_REPLAY_CLEANUP_LIMIT);
}

function safeSelectedTransition(
  transition: WorkflowReplaySelectedTransition | null | undefined,
): WorkflowReplaySelectedTransition | null {
  if (!transition) return null;
  if (
    transition.port.length < 1 ||
    transition.port.length > MAX_TRANSITION_IDENTIFIER_CHARACTERS ||
    transition.edgeIds.length > MAX_SELECTED_EDGE_IDS ||
    transition.edgeIds.some(
      (edgeId) =>
        edgeId.length < 1 ||
        edgeId.length > MAX_TRANSITION_IDENTIFIER_CHARACTERS,
    )
  ) {
    return null;
  }
  return {
    port: transition.port,
    edgeIds: [...transition.edgeIds],
  };
}

function attemptEnvelopeBudget(
  outcome: ReplayAttemptOutcome | null,
  selectedTransition: WorkflowReplaySelectedTransition | null,
): number {
  const extraBytes = Buffer.byteLength(
    JSON.stringify({ outcome, selectedTransition }),
    "utf8",
  );
  return Math.max(
    1024,
    REPLAY_ATTEMPT_MAX_BYTES -
      ATTEMPT_ROW_BUDGET_OVERHEAD -
      extraBytes,
  );
}

function applyReplayAttemptObservations(
  current: ReplayAttemptEnvelopeSet,
  observations: readonly ReplayAttemptObservation[] | undefined,
): ReplayAttemptEnvelopeSet {
  const next = { ...current };
  for (const observation of observations ?? []) {
    const envelope = structuredClone(observation.envelope);
    switch (observation.kind) {
      case "input":
        next.input = envelope;
        break;
      case "output":
        next.output = envelope;
        break;
      case "log":
        next.logs = appendReplayLogEnvelope(next.logs, envelope);
        break;
      case "metadata":
        next.metadata = envelope;
        break;
    }
  }
  return next;
}

function mapAttemptSummary(
  row: typeof workflowBlockAttempts.$inferSelect,
): WorkflowReplayAttemptSummary {
  return {
    id: row.id,
    nodeId: row.nodeId,
    attempt: row.attempt,
    activationScopeId: row.activationScopeId,
    state: row.state,
    outcome: row.outcome,
    selectedTransition: row.selectedTransition,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    diagnosticId: row.diagnosticId,
  };
}

function mapAttemptDetail(
  row: typeof workflowBlockAttempts.$inferSelect,
): WorkflowReplayAttemptDetail {
  return {
    ...mapAttemptSummary(row),
    input: row.inputEnvelope,
    output: row.outputEnvelope,
    logs: row.logEnvelope,
    metadata: row.metadataEnvelope,
  };
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
  const sanitizedGraph = sanitizeReplayGraphSnapshot(
    input.graph,
    input.secrets,
  );
  const sanitizedLayout = sanitizeReplayLayoutSnapshot(
    input.layout,
    input.secrets,
  );
  if (!sanitizedGraph || !sanitizedLayout) {
    throw new RunObservationStoreError(
      400,
      "Replay snapshot exceeds safe capture limits",
    );
  }
  const graph = JSON.stringify(sanitizedGraph);
  const layout = JSON.stringify(sanitizedLayout);
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

export async function startWorkflowBlockAttempt(
  input: StartWorkflowBlockAttemptInput,
): Promise<StartWorkflowBlockAttemptResult> {
  assertNonEmpty(input.runId, "runId");
  assertNonEmpty(input.organizationId, "organizationId");
  assertNonEmpty(input.nodeId, "nodeId");
  assertNonEmpty(input.activationScopeId, "activationScopeId");
  assertPositiveInteger(input.attempt, "attempt");
  const startedAt = input.startedAt ?? new Date();

  const identityFilter = and(
    eq(workflowBlockAttempts.runId, input.runId),
    eq(workflowBlockAttempts.organizationId, input.organizationId),
    eq(workflowBlockAttempts.nodeId, input.nodeId),
    eq(workflowBlockAttempts.attempt, input.attempt),
    eq(
      workflowBlockAttempts.activationScopeId,
      input.activationScopeId,
    ),
  );
  const [observation] = await input.db
    .select({ runId: workflowRunObservations.runId })
    .from(workflowRunObservations)
    .innerJoin(
      workflowRuns,
      eq(workflowRuns.runId, workflowRunObservations.runId),
    )
    .where(
      and(
        eq(workflowRunObservations.runId, input.runId),
        eq(workflowRunObservations.organizationId, input.organizationId),
        eq(workflowRunObservations.captureStatus, "available"),
        gt(workflowRunObservations.expiresAt, startedAt),
        isNull(workflowRuns.replayCaptureFailedAt),
      ),
    )
    .limit(1);
  if (!observation) {
    throw new RunObservationStoreError(
      404,
      "Replay observation is not available",
    );
  }

  const [existing] = await input.db
    .select({ attemptId: workflowBlockAttempts.id })
    .from(workflowBlockAttempts)
    .where(identityFilter)
    .limit(1);
  if (existing) return existing;

  // The scheduler hook enforces the exact hard cap before starting any sink
  // work. This durable count is defense in depth for reconstructed or direct
  // callers and makes the run unavailable instead of retaining a partial trace.
  const [count] = await input.db
    .select({ value: sql<number>`count(*)::integer` })
    .from(workflowBlockAttempts)
    .where(
      and(
        eq(workflowBlockAttempts.runId, input.runId),
        eq(workflowBlockAttempts.organizationId, input.organizationId),
      ),
    );
  if (Number(count?.value ?? 0) >= MAX_REPLAY_ATTEMPTS_PER_RUN) {
    await markRunReplayCaptureUnavailable({
      db: input.db,
      runId: input.runId,
      organizationId: input.organizationId,
      failedAt: startedAt,
    });
    throw new RunObservationStoreError(
      409,
      `Replay capture is limited to ${MAX_REPLAY_ATTEMPTS_PER_RUN} attempts per run`,
    );
  }

  const inserted = await input.db
    .insert(workflowBlockAttempts)
    .values({
      runId: input.runId,
      organizationId: input.organizationId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      activationScopeId: input.activationScopeId,
      state: "running",
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    .onConflictDoNothing()
    .returning({ attemptId: workflowBlockAttempts.id });
  if (inserted[0]) return inserted[0];

  const [concurrentExisting] = await input.db
    .select({ attemptId: workflowBlockAttempts.id })
    .from(workflowBlockAttempts)
    .where(identityFilter)
    .limit(1);
  if (!concurrentExisting) {
    throw new RunObservationStoreError(409, "Attempt identity conflict");
  }
  return concurrentExisting;
}

export async function updateWorkflowBlockAttemptState(
  input: UpdateWorkflowBlockAttemptStateInput,
): Promise<boolean> {
  const selectedTransition = safeSelectedTransition(
    input.selectedTransition,
  );
  for (
    let casAttempt = 0;
    casAttempt < OBSERVATION_CAS_ATTEMPTS;
    casAttempt += 1
  ) {
    const [row] = await input.db
      .select()
      .from(workflowBlockAttempts)
      .where(
        and(
          eq(workflowBlockAttempts.id, input.attemptId),
          eq(workflowBlockAttempts.runId, input.runId),
          eq(workflowBlockAttempts.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!row) return false;

    const bounded = enforceReplayAttemptStorageBudget(
      applyReplayAttemptObservations(
        {
          input: row.inputEnvelope,
          output: row.outputEnvelope,
          logs: row.logEnvelope,
          metadata: row.metadataEnvelope,
        },
        input.observations,
      ),
      attemptEnvelopeBudget(row.outcome, selectedTransition),
    );
    const rows = await input.db
      .update(workflowBlockAttempts)
      .set({
        state: input.state,
        selectedTransition,
        inputEnvelope: bounded.input,
        outputEnvelope: bounded.output,
        logEnvelope: bounded.logs,
        metadataEnvelope: bounded.metadata,
        observationRevision: row.observationRevision + 1,
        completedAt: null,
        durationMs: null,
        updatedAt: input.updatedAt ?? new Date(),
      })
      .where(
        and(
          eq(workflowBlockAttempts.id, input.attemptId),
          eq(workflowBlockAttempts.runId, input.runId),
          eq(workflowBlockAttempts.organizationId, input.organizationId),
          eq(
            workflowBlockAttempts.observationRevision,
            row.observationRevision,
          ),
        ),
      )
      .returning({ id: workflowBlockAttempts.id });
    if (rows.length > 0) return true;
  }
  throw new RunObservationStoreError(
    409,
    "Concurrent attempt state updates exceeded the retry limit",
  );
}

export async function recordWorkflowBlockAttemptObservation(
  input: RecordWorkflowBlockAttemptObservationInput,
): Promise<boolean> {
  for (let casAttempt = 0; casAttempt < OBSERVATION_CAS_ATTEMPTS; casAttempt += 1) {
    const [row] = await input.db
      .select()
      .from(workflowBlockAttempts)
      .where(
        and(
          eq(workflowBlockAttempts.id, input.attemptId),
          eq(workflowBlockAttempts.runId, input.runId),
          eq(workflowBlockAttempts.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!row) return false;

    const envelopes = applyReplayAttemptObservations(
      {
        input: row.inputEnvelope,
        output: row.outputEnvelope,
        logs: row.logEnvelope,
        metadata: row.metadataEnvelope,
      },
      [input],
    );
    const bounded = enforceReplayAttemptStorageBudget(
      envelopes,
      attemptEnvelopeBudget(
        row.outcome,
        safeSelectedTransition(row.selectedTransition),
      ),
    );

    const updated = await input.db
      .update(workflowBlockAttempts)
      .set({
        inputEnvelope: bounded.input,
        outputEnvelope: bounded.output,
        logEnvelope: bounded.logs,
        metadataEnvelope: bounded.metadata,
        observationRevision: row.observationRevision + 1,
        updatedAt: input.observedAt ?? new Date(),
      })
      .where(
        and(
          eq(workflowBlockAttempts.id, input.attemptId),
          eq(workflowBlockAttempts.runId, input.runId),
          eq(workflowBlockAttempts.organizationId, input.organizationId),
          eq(
            workflowBlockAttempts.observationRevision,
            row.observationRevision,
          ),
        ),
      )
      .returning({ id: workflowBlockAttempts.id });
    if (updated.length > 0) return true;
  }
  throw new RunObservationStoreError(
    409,
    "Concurrent attempt observations exceeded the retry limit",
  );
}

export async function finishWorkflowBlockAttempt(
  input: FinishWorkflowBlockAttemptInput,
): Promise<boolean> {
  if (input.state === "running" || input.state === "waiting_loop") {
    return updateWorkflowBlockAttemptState({
      db: input.db,
      runId: input.runId,
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      state: input.state,
      selectedTransition: input.selectedTransition ?? null,
      observations: input.observations,
      ...(input.completedAt ? { updatedAt: input.completedAt } : {}),
    });
  }
  const completedAt = input.completedAt ?? new Date();
  const outcome = sanitizeReplayAttemptOutcome(input.outcome);
  const selectedTransition = safeSelectedTransition(
    input.selectedTransition,
  );
  for (
    let casAttempt = 0;
    casAttempt < OBSERVATION_CAS_ATTEMPTS;
    casAttempt += 1
  ) {
    const [row] = await input.db
      .select()
      .from(workflowBlockAttempts)
      .where(
        and(
          eq(workflowBlockAttempts.id, input.attemptId),
          eq(workflowBlockAttempts.runId, input.runId),
          eq(workflowBlockAttempts.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!row) return false;
    const durationMs = Math.max(
      0,
      completedAt.getTime() - row.startedAt.getTime(),
    );
    const bounded = enforceReplayAttemptStorageBudget(
      applyReplayAttemptObservations(
        {
          input: row.inputEnvelope,
          output: row.outputEnvelope,
          logs: row.logEnvelope,
          metadata: row.metadataEnvelope,
        },
        input.observations,
      ),
      attemptEnvelopeBudget(outcome, selectedTransition),
    );
    const rows = await input.db
      .update(workflowBlockAttempts)
      .set({
        state: input.state,
        outcome,
        selectedTransition,
        diagnosticId: input.diagnosticId ?? null,
        inputEnvelope: bounded.input,
        outputEnvelope: bounded.output,
        logEnvelope: bounded.logs,
        metadataEnvelope: bounded.metadata,
        observationRevision: row.observationRevision + 1,
        completedAt,
        durationMs,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(workflowBlockAttempts.id, input.attemptId),
          eq(workflowBlockAttempts.runId, input.runId),
          eq(workflowBlockAttempts.organizationId, input.organizationId),
          eq(
            workflowBlockAttempts.observationRevision,
            row.observationRevision,
          ),
        ),
      )
      .returning({ id: workflowBlockAttempts.id });
    if (rows.length > 0) return true;
  }
  throw new RunObservationStoreError(
    409,
    "Concurrent attempt finalization exceeded the retry limit",
  );
}

export async function getRunReplayAvailability(
  input: GetRunReplayAvailabilityInput,
): Promise<ReplayAvailability> {
  const now = input.now ?? new Date();
  const [run] = await input.db
    .select({
      organizationId: workflowRuns.replayOrganizationId,
      capturedAt: workflowRuns.replayCapturedAt,
      expiresAt: workflowRuns.replayExpiresAt,
      failedAt: workflowRuns.replayCaptureFailedAt,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, input.runId))
    .limit(1);
  if (
    !run ||
    (run.organizationId !== null &&
      run.organizationId !== input.organizationId)
  ) {
    return "not_captured";
  }
  if (run.failedAt) return "not_captured";
  if (!run.capturedAt || !run.expiresAt) return "not_captured";
  if (run.expiresAt.getTime() <= now.getTime()) return "expired";

  const [observation] = await input.db
    .select({ captureStatus: workflowRunObservations.captureStatus })
    .from(workflowRunObservations)
    .where(
      and(
        eq(workflowRunObservations.runId, input.runId),
        eq(workflowRunObservations.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  return observation?.captureStatus === "available"
    ? "available"
    : "not_captured";
}

export async function getRunReplay(
  input: GetRunReplayInput,
): Promise<WorkflowRunReplayResponse> {
  const now = input.now ?? new Date();
  const [run] = await input.db
    .select({
      status: workflowRuns.status,
      captureFailedAt: workflowRuns.replayCaptureFailedAt,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.runId, input.runId),
        eq(workflowRuns.replayOrganizationId, input.organizationId),
      ),
    )
    .limit(1);
  const availability = await getRunReplayAvailability({ ...input, now });
  const mayAdvance =
    availability !== "expired" &&
    run !== undefined &&
    (!run?.status ||
      !["success", "failed", "blocked"].includes(run.status));
  if (availability !== "available") {
    return {
      availability,
      mayAdvance,
      snapshot: null,
      attempts: [],
      nextCursor: null,
    };
  }
  const afterId = parseReplayCursor(input.cursor);
  const [observation] =
    afterId === null
      ? await input.db
          .select()
          .from(workflowRunObservations)
          .where(
            and(
              eq(workflowRunObservations.runId, input.runId),
              eq(
                workflowRunObservations.organizationId,
                input.organizationId,
              ),
              gt(workflowRunObservations.expiresAt, now),
            ),
          )
          .limit(1)
      : [];
  if (afterId === null && !observation) {
    return {
      availability: "not_captured",
      mayAdvance: false,
      snapshot: null,
      attempts: [],
      nextCursor: null,
    };
  }

  const limit = normalizePageLimit(input.limit);
  const rows = await input.db
    .select()
    .from(workflowBlockAttempts)
    .where(
      and(
        eq(workflowBlockAttempts.runId, input.runId),
        eq(workflowBlockAttempts.organizationId, input.organizationId),
        ...(afterId === null
          ? []
          : [lt(workflowBlockAttempts.id, afterId)]),
      ),
    )
    .orderBy(desc(workflowBlockAttempts.id))
    .limit(limit + 1);
  const hasNextPage = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    availability: "available",
    mayAdvance,
    snapshot:
      observation === undefined
        ? null
        : {
            runId: observation.runId,
            definitionId: observation.definitionId,
            definitionVersion: observation.definitionVersion,
            definitionSchemaVersion:
              observation.definitionSchemaVersion === 1 ? 1 : 2,
            graph: observation.graph,
            layout: normalizeWorkflowDefinitionLayout(observation.layout),
            runtimeManifest: observation.runtimeManifest,
            captureStatus: observation.captureStatus,
            capturedAt: observation.capturedAt.toISOString(),
            expiresAt: observation.expiresAt.toISOString(),
          },
    attempts: page.map(mapAttemptSummary),
    nextCursor:
      hasNextPage && page.length > 0
        ? replayCursor(page[page.length - 1]!.id)
        : null,
  };
}

export async function getRunReplayAttempt(
  input: GetRunReplayAttemptInput,
): Promise<WorkflowReplayAttemptDetail | null> {
  const availability = await getRunReplayAvailability(input);
  if (availability !== "available") return null;
  const [row] = await input.db
    .select()
    .from(workflowBlockAttempts)
    .where(
      and(
        eq(workflowBlockAttempts.id, input.attemptId),
        eq(workflowBlockAttempts.runId, input.runId),
        eq(workflowBlockAttempts.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  return row ? mapAttemptDetail(row) : null;
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
