/**
 * The recorded replay of one run, as the dashboard reads it.
 *
 * The observation store already refuses what an organization may not see and
 * says so with a status code; this binds the connection and re-declares that
 * refusal as part of this cluster's interface, so the route maps it to HTTP
 * without reaching past the service tier for the class it matches on.
 */
import type {
  ReplayAttemptState,
  ReplayAvailability,
  WorkflowReplayAttemptDetail,
  WorkflowReplayAttemptSummary,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import { normalizeWorkflowDefinitionLayout } from "@shared/contracts";
import type { Db } from "../../db/types.js";
import {
  DEFAULT_REPLAY_PAGE_LIMIT,
  MAX_REPLAY_PAGE_LIMIT,
  RunObservationStoreError,
  listConnectedRunReplayAttemptRows,
  listRunReplayAttemptRows,
  readConnectedRunReplayAttemptRow,
  readConnectedRunReplayObservation,
  readConnectedRunReplayRun,
  readRunReplayAttemptRow,
  readRunReplayObservation,
  readRunReplayRun,
} from "../../db/repositories/runs/run-observability.js";

/**
 * The store's own refusal, re-declared here so the transport can map it to its
 * status code without importing past the service tier.
 */
export { RunObservationStoreError };
export { MAX_REPLAY_PAGE_LIMIT };

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["success", "failed", "blocked"]);
const STALE_LIVE_ATTEMPT_STATES: ReadonlySet<ReplayAttemptState> = new Set([
  "running",
  "waiting_loop",
  "waiting_for_clarification",
]);

type RunRow = NonNullable<Awaited<ReturnType<typeof readRunReplayRun>>>;
type ObservationRow = NonNullable<Awaited<ReturnType<typeof readRunReplayObservation>>>;
type AttemptRow = Awaited<ReturnType<typeof listRunReplayAttemptRows>>[number];

type ReplayReads = {
  run(runId: string, organizationId: string): Promise<RunRow | null>;
  observation(runId: string, organizationId: string, now: Date): Promise<ObservationRow | null>;
  attempts(input: Parameters<typeof listRunReplayAttemptRows>[1]): Promise<AttemptRow[]>;
  attempt(input: Parameters<typeof readRunReplayAttemptRow>[1]): Promise<AttemptRow | null>;
};

function explicitReads(db: Db): ReplayReads {
  return {
    run: (runId, organizationId) => readRunReplayRun(db, runId, organizationId),
    observation: (runId, organizationId, now) => readRunReplayObservation(db, runId, organizationId, now),
    attempts: (input) => listRunReplayAttemptRows(db, input),
    attempt: (input) => readRunReplayAttemptRow(db, input),
  };
}

const connectedReads: ReplayReads = {
  run: readConnectedRunReplayRun,
  observation: readConnectedRunReplayObservation,
  attempts: listConnectedRunReplayAttemptRows,
  attempt: readConnectedRunReplayAttemptRow,
};

function isTerminalRunStatus(status: string | null | undefined): boolean {
  return Boolean(status && TERMINAL_RUN_STATUSES.has(status));
}

function displayAttemptState(state: ReplayAttemptState, runIsTerminal: boolean) {
  return runIsTerminal && STALE_LIVE_ATTEMPT_STATES.has(state) ? "cancelled" : state;
}

function mapAttemptSummary(row: AttemptRow, runIsTerminal: boolean): WorkflowReplayAttemptSummary {
  return {
    id: row.id,
    nodeId: row.nodeId,
    attempt: row.attempt,
    activationScopeId: row.activationScopeId,
    state: displayAttemptState(row.state, runIsTerminal),
    outcome: row.outcome,
    selectedTransition: row.selectedTransition,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    diagnosticId: row.diagnosticId,
  };
}

function mapAttemptDetail(row: AttemptRow, runIsTerminal: boolean): WorkflowReplayAttemptDetail {
  return {
    ...mapAttemptSummary(row, runIsTerminal),
    input: row.inputEnvelope,
    output: row.outputEnvelope,
    logs: row.logEnvelope,
    metadata: row.metadataEnvelope,
  };
}

function normalizePageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_REPLAY_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RunObservationStoreError(400, "limit must be a positive integer");
  }
  return Math.min(limit, MAX_REPLAY_PAGE_LIMIT);
}

function replayCursor(attemptId: number): string {
  return Buffer.from(`attempt:${attemptId}`, "utf8").toString("base64url");
}

function parseReplayCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^attempt:(\d+)$/u.exec(decoded);
    const id = Number(match?.[1]);
    if (!match || !Number.isInteger(id) || id < 1 || id > 2_147_483_647) {
      throw new Error("invalid");
    }
    return id;
  } catch {
    throw new RunObservationStoreError(400, "Invalid replay cursor");
  }
}

async function availabilityWithReads(
  reads: ReplayReads,
  input: { runId: string; organizationId: string; now?: Date },
): Promise<ReplayAvailability> {
  const now = input.now ?? new Date();
  const run = await reads.run(input.runId, input.organizationId);
  if (!run || run.failedAt || !run.capturedAt || !run.expiresAt) return "not_captured";
  if (run.expiresAt.getTime() <= now.getTime()) return "expired";
  const observation = await reads.observation(input.runId, input.organizationId, now);
  return observation?.captureStatus === "available" ? "available" : "not_captured";
}

async function replayWithReads(
  reads: ReplayReads,
  input: { runId: string; organizationId: string; limit?: number; cursor?: string | null; now?: Date },
): Promise<WorkflowRunReplayResponse> {
  const now = input.now ?? new Date();
  const run = await reads.run(input.runId, input.organizationId);
  const availability = await availabilityWithReads(reads, { ...input, now });
  const runIsTerminal = isTerminalRunStatus(run?.status);
  const mayAdvance = availability !== "expired" && run !== null && !runIsTerminal;
  if (availability !== "available") {
    return { availability, mayAdvance, snapshot: null, attempts: [], nextCursor: null };
  }
  const afterId = parseReplayCursor(input.cursor);
  const observation = afterId === null
    ? await reads.observation(input.runId, input.organizationId, now)
    : null;
  if (afterId === null && !observation) {
    return { availability: "not_captured", mayAdvance: false, snapshot: null, attempts: [], nextCursor: null };
  }
  const limit = normalizePageLimit(input.limit);
  const rows = await reads.attempts({
    runId: input.runId,
    organizationId: input.organizationId,
    afterId,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    availability: "available",
    mayAdvance,
    snapshot: observation ? {
      runId: observation.runId,
      definitionId: observation.definitionId,
      definitionVersion: observation.definitionVersion,
      definitionSchemaVersion: observation.definitionSchemaVersion === 1 ? 1 : 2,
      graph: observation.graph,
      layout: normalizeWorkflowDefinitionLayout(observation.layout),
      runtimeManifest: observation.runtimeManifest,
      captureStatus: observation.captureStatus,
      capturedAt: observation.capturedAt.toISOString(),
      expiresAt: observation.expiresAt.toISOString(),
    } : null,
    attempts: page.map((row) => mapAttemptSummary(row, runIsTerminal)),
    nextCursor: rows.length > limit && page.length > 0
      ? replayCursor(page.at(-1)!.id)
      : null,
  };
}

export function getRunReplayAvailability(input: {
  db: Db;
  runId: string;
  organizationId: string;
  now?: Date;
}): Promise<ReplayAvailability> {
  return availabilityWithReads(explicitReads(input.db), input);
}

export function getConnectedRunReplayAvailability(
  input: Omit<Parameters<typeof getRunReplayAvailability>[0], "db">,
) {
  return availabilityWithReads(connectedReads, input);
}

export function getRunReplay(input: {
  db: Db;
  runId: string;
  organizationId: string;
  limit?: number;
  cursor?: string | null;
  now?: Date;
}) {
  return replayWithReads(explicitReads(input.db), input);
}

export function getConnectedRunReplay(input: Omit<Parameters<typeof getRunReplay>[0], "db">) {
  return replayWithReads(connectedReads, input);
}

async function replayAttemptWithReads(
  reads: ReplayReads,
  input: { runId: string; organizationId: string; attemptId: number; now?: Date },
): Promise<WorkflowReplayAttemptDetail | null> {
  const availability = await availabilityWithReads(reads, input);
  if (availability !== "available") return null;
  const [run, row] = await Promise.all([
    reads.run(input.runId, input.organizationId),
    reads.attempt(input),
  ]);
  return row ? mapAttemptDetail(row, isTerminalRunStatus(run?.status)) : null;
}

export function getRunReplayAttempt(input: {
  db: Db;
  runId: string;
  organizationId: string;
  attemptId: number;
  now?: Date;
}) {
  return replayAttemptWithReads(explicitReads(input.db), input);
}

export function getConnectedRunReplayAttempt(
  input: Omit<Parameters<typeof getRunReplayAttempt>[0], "db">,
) {
  return replayAttemptWithReads(connectedReads, input);
}

/** One page of a run's replay. */
export function readRunReplay(options: {
  organizationId: string;
  runId: string;
  limit: number;
  cursor?: string;
}): Promise<WorkflowRunReplayResponse> {
  const { organizationId, runId, limit, cursor } = options;
  return getConnectedRunReplay({
    organizationId,
    runId,
    limit,
    ...(cursor ? { cursor } : {}),
  });
}

/** One attempt of a run's replay, or null when that pair names nothing. */
export function readRunReplayAttempt(options: {
  organizationId: string;
  runId: string;
  attemptId: number;
}): Promise<WorkflowReplayAttemptDetail | null> {
  return getConnectedRunReplayAttempt(options);
}
