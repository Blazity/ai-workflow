import { and, asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  WorkflowReplayGraphSnapshot,
  WorkflowReplayLayoutSnapshot,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  organization,
  workflowBlockAttempts,
  workflowDefinitionVersions,
  workflowDefinitions,
  workflowRunObservations,
  workflowRuns,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  captureRunObservationStart,
  deleteExpiredRunObservations,
  finishWorkflowBlockAttempt,
  getRunReplay,
  getRunReplayAttempt,
  getRunReplayAvailability,
  markRunReplayCaptureUnavailable,
  recordWorkflowBlockAttemptObservation,
  RunObservationStoreError,
  startWorkflowBlockAttempt,
  updateWorkflowBlockAttemptState,
} from "./store.js";
import { sanitizeReplayValue } from "./sanitizer.js";
import { MAX_REPLAY_ATTEMPTS_PER_RUN } from "./limits.js";

let db: Db;
let definitionId: number;

const graph: WorkflowReplayGraphSnapshot = {
  nodes: [
    {
      id: "agent",
      type: "generic_agent",
      name: "Implement",
      x: 100,
      y: 200,
    },
  ],
  edges: [],
};
const layout: WorkflowReplayLayoutSnapshot = {
  nodes: { agent: { x: 100, y: 200 } },
  edges: {},
};
const capturedAt = new Date("2026-07-23T10:00:00.000Z");

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values([
    { id: "org-replay", name: "Replay", slug: "replay-store" },
    { id: "org-other", name: "Other", slug: "replay-other" },
  ]);
  const [definition] = await db
    .insert(workflowDefinitions)
    .values({
      name: "Replay workflow",
      createdById: "admin",
      createdByLabel: "Admin",
    })
    .returning({ id: workflowDefinitions.id });
  definitionId = definition!.id;
  await db.insert(workflowDefinitionVersions).values({
    definitionId,
    version: 1,
    definition: { schemaVersion: 2, nodes: [], edges: [] },
    createdById: "admin",
    createdByLabel: "Admin",
  });
});

function capture(
  runId: string,
  overrides: Partial<Parameters<typeof captureRunObservationStart>[0]> = {},
) {
  return captureRunObservationStart({
    db,
    runId,
    organizationId: "org-replay",
    definitionId,
    definitionVersion: 1,
    definitionSchemaVersion: 2,
    graph,
    layout,
    runtimeManifest: sanitizeReplayValue({
        profile: "system-codex",
        authorization: "must-not-survive",
      }),
    now: capturedAt,
    ...overrides,
  });
}

describe("captureRunObservationStart", () => {
  it("atomically captures one immutable sanitized snapshot and durable markers", async () => {
    const created = await capture("run-capture");
    expect(created).toEqual({
      captureStatus: "available",
      capturedAt,
      expiresAt: new Date("2026-08-22T10:00:00.000Z"),
    });

    const [observation] = await db
      .select()
      .from(workflowRunObservations)
      .where(eq(workflowRunObservations.runId, "run-capture"));
    expect(observation?.graph).toEqual(graph);
    expect(observation?.runtimeManifest.value).toEqual({
      profile: "system-codex",
      authorization: "[REDACTED:hard_exclusion]",
    });
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, "run-capture"));
    expect(run).toMatchObject({
      replayOrganizationId: "org-replay",
      replayCapturedAt: capturedAt,
      replayExpiresAt: new Date("2026-08-22T10:00:00.000Z"),
    });

    const retried = await capture("run-capture", {
      now: new Date("2026-07-24T10:00:00.000Z"),
    });
    expect(retried).toEqual(created);
    expect(
      await db
        .select()
        .from(workflowRunObservations)
        .where(eq(workflowRunObservations.runId, "run-capture")),
    ).toHaveLength(1);
  });

  it("rejects snapshot drift and cross-organization claims without mutation", async () => {
    await capture("run-drift");
    await expect(
      capture("run-drift", {
        graph: {
          ...graph,
          nodes: [{ ...graph.nodes[0]!, name: "Changed" }],
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<RunObservationStoreError>);
    await expect(
      capture("run-drift", { organizationId: "org-other" }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<RunObservationStoreError>);

    const [observation] = await db
      .select()
      .from(workflowRunObservations)
      .where(eq(workflowRunObservations.runId, "run-drift"));
    expect(observation?.organizationId).toBe("org-replay");
    expect(observation?.graph.nodes[0]?.name).toBe("Implement");
  });

  it("keeps a failed capture unavailable even when a snapshot write lands", async () => {
    await capture("run-capture-failed");
    await startWorkflowBlockAttempt({
      db,
      runId: "run-capture-failed",
      organizationId: "org-replay",
      nodeId: "agent",
      attempt: 1,
      activationScopeId: "root",
    });
    const firstFailure = new Date("2026-07-23T10:00:05.000Z");
    await markRunReplayCaptureUnavailable({
      db,
      runId: "run-capture-failed",
      organizationId: "org-replay",
      failedAt: firstFailure,
    });
    await markRunReplayCaptureUnavailable({
      db,
      runId: "run-capture-failed",
      organizationId: "org-replay",
      failedAt: new Date("2026-07-23T10:00:10.000Z"),
    });
    await db
      .update(workflowRuns)
      .set({ status: "failed" })
      .where(eq(workflowRuns.runId, "run-capture-failed"));

    await expect(
      capture("run-capture-failed", {
        now: new Date("2026-07-23T10:00:20.000Z"),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<RunObservationStoreError>);
    expect(
      await getRunReplay({
        db,
        runId: "run-capture-failed",
        organizationId: "org-replay",
      }),
    ).toEqual({
      availability: "not_captured",
      mayAdvance: false,
      snapshot: null,
      attempts: [],
      nextCursor: null,
    });
    const [run] = await db
      .select({
        captureFailedAt: workflowRuns.replayCaptureFailedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, "run-capture-failed"));
    expect(run?.captureFailedAt).toEqual(firstFailure);
  });
});

describe("attempt lifecycle", () => {
  it("caps attempts across activation scopes and makes an over-limit replay unavailable", async () => {
    await capture("run-attempt-cap");
    await db.insert(workflowBlockAttempts).values(
      Array.from(
        { length: MAX_REPLAY_ATTEMPTS_PER_RUN - 1 },
        (_, index) => ({
          runId: "run-attempt-cap",
          organizationId: "org-replay",
          nodeId: `captured-${index}`,
          attempt: 1,
          activationScopeId: `root/resume:${Math.floor(index / 100)}`,
          state: "running" as const,
          startedAt: new Date(capturedAt.getTime() + index),
        }),
      ),
    );
    const finalAllowed = await startWorkflowBlockAttempt({
      db,
      runId: "run-attempt-cap",
      organizationId: "org-replay",
      nodeId: "skipped-at-cap",
      attempt: 1,
      activationScopeId: "root/resume:final",
      startedAt: new Date("2026-07-23T10:01:00.000Z"),
    });
    await finishWorkflowBlockAttempt({
      db,
      runId: "run-attempt-cap",
      organizationId: "org-replay",
      attemptId: finalAllowed.attemptId,
      state: "skipped",
      outcome: { kind: "skipped", status: "skipped" },
      completedAt: new Date("2026-07-23T10:01:00.000Z"),
    });

    await expect(
      startWorkflowBlockAttempt({
        db,
        runId: "run-attempt-cap",
        organizationId: "org-replay",
        nodeId: "over-limit",
        attempt: 1,
        activationScopeId: "root/resume:final",
        startedAt: new Date("2026-07-23T10:01:01.000Z"),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<RunObservationStoreError>);

    await expect(
      startWorkflowBlockAttempt({
        db,
        runId: "run-attempt-cap",
        organizationId: "org-replay",
        nodeId: "skipped-at-cap",
        attempt: 1,
        activationScopeId: "root/resume:final",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
    } satisfies Partial<RunObservationStoreError>);
    expect(
      await getRunReplayAvailability({
        db,
        runId: "run-attempt-cap",
        organizationId: "org-replay",
      }),
    ).toBe("not_captured");
    const [count] = await db
      .select({ value: sql<number>`count(*)::integer` })
      .from(workflowBlockAttempts)
      .where(eq(workflowBlockAttempts.runId, "run-attempt-cap"));
    expect(Number(count?.value)).toBe(MAX_REPLAY_ATTEMPTS_PER_RUN);
  });

  it("records states, sanitized envelopes, typed outcome, transition, and timing", async () => {
    await capture("run-attempt");
    const startedAt = new Date("2026-07-23T10:00:01.000Z");
    const first = await startWorkflowBlockAttempt({
      db,
      runId: "run-attempt",
      organizationId: "org-replay",
      nodeId: "agent",
      attempt: 1,
      activationScopeId: "root",
      startedAt,
    });
    expect(
      await startWorkflowBlockAttempt({
        db,
        runId: "run-attempt",
        organizationId: "org-replay",
        nodeId: "agent",
        attempt: 1,
        activationScopeId: "root",
        startedAt,
      }),
    ).toEqual(first);

    await recordWorkflowBlockAttemptObservation({
      db,
      runId: "run-attempt",
      organizationId: "org-replay",
      attemptId: first.attemptId,
      kind: "input",
      envelope: sanitizeReplayValue(
        { plan: "secret plan value" },
        { secrets: ["secret plan value"] },
      ),
    });
    await recordWorkflowBlockAttemptObservation({
      db,
      runId: "run-attempt",
      organizationId: "org-replay",
      attemptId: first.attemptId,
      kind: "log",
      envelope: sanitizeReplayValue("first safe log", { retain: "tail" }),
    });
    await recordWorkflowBlockAttemptObservation({
      db,
      runId: "run-attempt",
      organizationId: "org-replay",
      attemptId: first.attemptId,
      kind: "output",
      envelope: sanitizeReplayValue({
        status: "ok",
        email: "person@example.com",
      }),
    });
    await recordWorkflowBlockAttemptObservation({
      db,
      runId: "run-attempt",
      organizationId: "org-replay",
      attemptId: first.attemptId,
      kind: "metadata",
      envelope: sanitizeReplayValue({ model: "codex" }),
    });
    expect(
      await updateWorkflowBlockAttemptState({
        db,
        runId: "run-attempt",
        organizationId: "org-replay",
        attemptId: first.attemptId,
        state: "waiting_loop",
        selectedTransition: {
          port: "continue",
          edgeIds: ["loop-body"],
        },
      }),
    ).toBe(true);
    expect(
      await getRunReplayAttempt({
        db,
        runId: "run-attempt",
        organizationId: "org-replay",
        attemptId: first.attemptId,
        now: new Date("2026-07-23T10:00:02.500Z"),
      }),
    ).toMatchObject({
      state: "waiting_loop",
      selectedTransition: {
        port: "continue",
        edgeIds: ["loop-body"],
      },
    });
    expect(
      await finishWorkflowBlockAttempt({
        db,
        runId: "run-attempt",
        organizationId: "org-replay",
        attemptId: first.attemptId,
        state: "completed",
        outcome: {
          kind: "completed",
          status: "ok",
          details: { payment: "pi_1234567890abcdef" },
        },
        selectedTransition: { port: "success", edgeIds: ["edge-1", "edge-2"] },
        completedAt: new Date("2026-07-23T10:00:03.250Z"),
      }),
    ).toBe(true);

    const detail = await getRunReplayAttempt({
      db,
      runId: "run-attempt",
      organizationId: "org-replay",
      attemptId: first.attemptId,
      now: new Date("2026-07-23T10:01:00.000Z"),
    });
    expect(detail).toMatchObject({
      id: first.attemptId,
      nodeId: "agent",
      state: "completed",
      durationMs: 2_250,
      selectedTransition: {
        port: "success",
        edgeIds: ["edge-1", "edge-2"],
      },
      outcome: {
        kind: "completed",
        status: "ok",
        details: { payment: "[REDACTED:payment_identifier]" },
      },
    });
    expect(JSON.stringify(detail?.input)).not.toContain("secret plan value");
    expect(JSON.stringify(detail?.output)).not.toContain("person@example.com");
    expect(detail?.logs?.value).toBe("first safe log");
    expect(detail?.metadata?.value).toEqual({ model: "codex" });
  });

  it("applies pending observations and the terminal state in one finalization", async () => {
    await capture("run-atomic-finish");
    const { attemptId } = await startWorkflowBlockAttempt({
      db,
      runId: "run-atomic-finish",
      organizationId: "org-replay",
      nodeId: "agent",
      attempt: 1,
      activationScopeId: "root",
      startedAt: new Date("2026-07-23T10:00:01.000Z"),
    });

    await finishWorkflowBlockAttempt({
      db,
      runId: "run-atomic-finish",
      organizationId: "org-replay",
      attemptId,
      state: "failed",
      outcome: { kind: "failed", status: "timeout" },
      diagnosticId: "diag-timeout",
      observations: [
        {
          kind: "input",
          envelope: sanitizeReplayValue({ task: "safe input" }),
        },
        {
          kind: "log",
          envelope: sanitizeReplayValue("partial stdout", {
            retain: "tail",
          }),
        },
        {
          kind: "log",
          envelope: sanitizeReplayValue("partial stderr", {
            retain: "tail",
          }),
        },
        {
          kind: "metadata",
          envelope: sanitizeReplayValue({ protocol: "timeout" }),
        },
      ],
      completedAt: new Date("2026-07-23T10:00:02.000Z"),
    });

    const detail = await getRunReplayAttempt({
      db,
      runId: "run-atomic-finish",
      organizationId: "org-replay",
      attemptId,
      now: new Date("2026-07-23T10:01:00.000Z"),
    });
    expect(detail).toMatchObject({
      state: "failed",
      durationMs: 1_000,
      diagnosticId: "diag-timeout",
      outcome: { kind: "failed", status: "timeout" },
      input: { value: { task: "safe input" } },
      metadata: { value: { protocol: "timeout" } },
    });
    expect(JSON.stringify(detail?.logs?.value)).toContain("partial stdout");
    expect(JSON.stringify(detail?.logs?.value)).toContain("partial stderr");
  });

  it("forwards pending observations when finish delegates a waiting state update", async () => {
    await capture("run-waiting-finish");
    const { attemptId } = await startWorkflowBlockAttempt({
      db,
      runId: "run-waiting-finish",
      organizationId: "org-replay",
      nodeId: "loop",
      attempt: 1,
      activationScopeId: "root",
    });

    await finishWorkflowBlockAttempt({
      db,
      runId: "run-waiting-finish",
      organizationId: "org-replay",
      attemptId,
      state: "waiting_loop",
      selectedTransition: { port: "continue", edgeIds: ["loop-body"] },
      observations: [
        {
          kind: "log",
          envelope: sanitizeReplayValue("waiting observation", {
            retain: "tail",
          }),
        },
      ],
    });

    const detail = await getRunReplayAttempt({
      db,
      runId: "run-waiting-finish",
      organizationId: "org-replay",
      attemptId,
    });
    expect(detail).toMatchObject({
      state: "waiting_loop",
      selectedTransition: {
        port: "continue",
        edgeIds: ["loop-body"],
      },
    });
    expect(JSON.stringify(detail?.logs?.value)).toContain(
      "waiting observation",
    );
  });

  it("uses optimistic CAS so concurrent log events are not lost", async () => {
    await capture("run-concurrent");
    const { attemptId } = await startWorkflowBlockAttempt({
      db,
      runId: "run-concurrent",
      organizationId: "org-replay",
      nodeId: "agent",
      attempt: 1,
      activationScopeId: "root",
      startedAt: new Date("2026-07-23T10:00:01.000Z"),
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recordWorkflowBlockAttemptObservation({
          db,
          runId: "run-concurrent",
          organizationId: "org-replay",
          attemptId,
          kind: "log",
          envelope: sanitizeReplayValue(`concurrent-log-${index}`, {
            retain: "tail",
          }),
        }),
      ),
    );
    const detail = await getRunReplayAttempt({
      db,
      runId: "run-concurrent",
      organizationId: "org-replay",
      attemptId,
      now: new Date("2026-07-23T10:01:00.000Z"),
    });
    const text = JSON.stringify(detail?.logs?.value);
    for (let index = 0; index < 20; index += 1) {
      expect(text).toContain(`concurrent-log-${index}`);
    }
  });

  it("caps the complete persisted diagnostic payload at 256 KiB", async () => {
    await capture("run-row-budget");
    const { attemptId } = await startWorkflowBlockAttempt({
      db,
      runId: "run-row-budget",
      organizationId: "org-replay",
      nodeId: "agent",
      attempt: 1,
      activationScopeId: "root",
      startedAt: new Date("2026-07-23T10:00:01.000Z"),
    });
    for (const kind of ["input", "output", "log", "metadata"] as const) {
      await recordWorkflowBlockAttemptObservation({
        db,
        runId: "run-row-budget",
        organizationId: "org-replay",
        attemptId,
        kind,
        envelope: sanitizeReplayValue(
          `${kind}:${"x".repeat(80 * 1024)}`,
          { retain: kind === "log" ? "tail" : "head" },
        ),
      });
    }
    const largeTransition = {
      port: "continue",
      edgeIds: Array.from(
        { length: 400 },
        (_, index) =>
          `e${String(index).padStart(3, "0")}-${"z".repeat(195)}`,
      ),
    };
    await updateWorkflowBlockAttemptState({
      db,
      runId: "run-row-budget",
      organizationId: "org-replay",
      attemptId,
      state: "waiting_loop",
      selectedTransition: largeTransition,
    });

    const [waitingRow] = await db
      .select()
      .from(workflowBlockAttempts)
      .where(eq(workflowBlockAttempts.id, attemptId));
    expect(
      Buffer.byteLength(
        JSON.stringify({
          input: waitingRow!.inputEnvelope,
          output: waitingRow!.outputEnvelope,
          logs: waitingRow!.logEnvelope,
          metadata: waitingRow!.metadataEnvelope,
          outcome: waitingRow!.outcome,
          selectedTransition: waitingRow!.selectedTransition,
        }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(256 * 1024);

    await finishWorkflowBlockAttempt({
      db,
      runId: "run-row-budget",
      organizationId: "org-replay",
      attemptId,
      state: "completed",
      outcome: {
        kind: "completed",
        status: "ok",
        details: `outcome:${"o".repeat(80 * 1024)}`,
      },
      selectedTransition: largeTransition,
      completedAt: new Date("2026-07-23T10:00:02.000Z"),
    });

    const [row] = await db
      .select()
      .from(workflowBlockAttempts)
      .where(eq(workflowBlockAttempts.id, attemptId));
    const diagnosticBytes = Buffer.byteLength(
      JSON.stringify({
        input: row!.inputEnvelope,
        output: row!.outputEnvelope,
        logs: row!.logEnvelope,
        metadata: row!.metadataEnvelope,
        outcome: row!.outcome,
        selectedTransition: row!.selectedTransition,
      }),
      "utf8",
    );
    expect(diagnosticBytes).toBeLessThanOrEqual(256 * 1024);
    expect(row!.logEnvelope?.metadata.truncated).toBe(true);
  });
});

describe("replay queries and retention", () => {
  it("normalizes historical node-only replay layouts", async () => {
    await capture("run-legacy-replay-layout");
    await db.execute(sql`
      UPDATE workflow_run_observations
      SET layout = ${JSON.stringify({
        nodes: { agent: { x: 20, y: 30 } },
      })}::jsonb
      WHERE run_id = 'run-legacy-replay-layout'
    `);

    const replay = await getRunReplay({
      db,
      runId: "run-legacy-replay-layout",
      organizationId: "org-replay",
    });
    expect(replay.snapshot?.layout).toEqual({
      nodes: { agent: { x: 20, y: 30 } },
      edges: {},
    });
  });

  it("returns the latest 100 envelope-free summaries before older pages", async () => {
    await capture("run-pagination");
    await db.insert(workflowBlockAttempts).values(
      Array.from({ length: 125 }, (_, index) => ({
        runId: "run-pagination",
        organizationId: "org-replay",
        nodeId: `node-${index + 1}`,
        attempt: 1,
        activationScopeId: "root",
        state: "running" as const,
        startedAt: new Date(capturedAt.getTime() + index),
        inputEnvelope: {
          value: { private: `input-${index + 1}` },
          metadata: {
            redactions: {},
            truncated: false,
            originalBytes: 10,
            storedBytes: 10,
            unavailable: false,
            unavailableReason: null,
          },
        },
      })),
    );

    const first = await getRunReplay({
      db,
      runId: "run-pagination",
      organizationId: "org-replay",
      now: new Date("2026-07-23T11:00:00.000Z"),
    });
    expect(first.attempts).toHaveLength(100);
    expect(first.mayAdvance).toBe(true);
    expect(first.snapshot).not.toBeNull();
    expect(first.attempts[0]?.nodeId).toBe("node-125");
    expect(first.attempts[99]?.nodeId).toBe("node-26");
    expect(first.nextCursor).not.toBeNull();
    expect("input" in first.attempts[0]!).toBe(false);

    const older = await getRunReplay({
      db,
      runId: "run-pagination",
      organizationId: "org-replay",
      cursor: first.nextCursor,
      now: new Date("2026-07-23T11:00:00.000Z"),
    });
    expect(older.attempts).toHaveLength(25);
    expect(older.snapshot).toBeNull();
    expect(older.attempts[0]?.nodeId).toBe("node-25");
    expect(older.attempts[24]?.nodeId).toBe("node-1");
    expect(older.nextCursor).toBeNull();

    await db
      .update(workflowRuns)
      .set({ status: "awaiting" })
      .where(eq(workflowRuns.runId, "run-pagination"));
    expect(
      (
        await getRunReplay({
          db,
          runId: "run-pagination",
          organizationId: "org-replay",
        })
      ).mayAdvance,
    ).toBe(true);

    await db
      .update(workflowRuns)
      .set({ status: "success" })
      .where(eq(workflowRuns.runId, "run-pagination"));
    expect(
      (
        await getRunReplay({
          db,
          runId: "run-pagination",
          organizationId: "org-replay",
        })
      ).mayAdvance,
    ).toBe(false);
  });

  it("enforces tenant scope and reports not captured, expired, and cleanup state", async () => {
    await db.insert(workflowRuns).values({ runId: "historical" });
    expect(
      await getRunReplayAvailability({
        db,
        runId: "historical",
        organizationId: "org-replay",
        now: capturedAt,
      }),
    ).toBe("not_captured");

    await capture("run-expired", { retentionDays: 1 });
    const { attemptId } = await startWorkflowBlockAttempt({
      db,
      runId: "run-expired",
      organizationId: "org-replay",
      nodeId: "agent",
      attempt: 1,
      activationScopeId: "root",
      startedAt: new Date("2026-07-23T10:00:01.000Z"),
    });
    expect(
      await getRunReplay({
        db,
        runId: "run-expired",
        organizationId: "org-other",
        now: capturedAt,
      }),
    ).toEqual({
      availability: "not_captured",
      mayAdvance: false,
      snapshot: null,
      attempts: [],
      nextCursor: null,
    });

    const afterExpiry = new Date("2026-07-25T10:00:00.000Z");
    expect(
      await getRunReplayAvailability({
        db,
        runId: "run-expired",
        organizationId: "org-replay",
        now: afterExpiry,
      }),
    ).toBe("expired");
    const cleaned = await deleteExpiredRunObservations({
      db,
      now: afterExpiry,
      limit: 1,
    });
    expect(cleaned).toEqual({ deleted: 1, runIds: ["run-expired"] });
    expect(
      await getRunReplayAttempt({
        db,
        runId: "run-expired",
        organizationId: "org-replay",
        attemptId,
        now: afterExpiry,
      }),
    ).toBeNull();
    expect(
      await getRunReplayAvailability({
        db,
        runId: "run-expired",
        organizationId: "org-replay",
        now: afterExpiry,
      }),
    ).toBe("expired");
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, "run-expired"));
    expect(run?.replayCapturedAt).toEqual(capturedAt);
  });

  it("deletes expiry rows in deterministic bounded batches", async () => {
    await Promise.all([
      capture("run-expired-a", { retentionDays: 1 }),
      capture("run-expired-b", { retentionDays: 1 }),
      capture("run-expired-c", { retentionDays: 1 }),
    ]);
    const now = new Date("2026-07-25T10:00:00.000Z");
    const first = await deleteExpiredRunObservations({ db, now, limit: 2 });
    expect(first.deleted).toBe(2);
    const second = await deleteExpiredRunObservations({ db, now, limit: 2 });
    expect(second.deleted).toBe(1);
    const rows = await db
      .select({ runId: workflowRunObservations.runId })
      .from(workflowRunObservations)
      .where(
        and(
          eq(workflowRunObservations.organizationId, "org-replay"),
          eq(workflowRunObservations.captureStatus, "available"),
        ),
      )
      .orderBy(asc(workflowRunObservations.runId));
    expect(rows).toEqual([]);
  });
});
