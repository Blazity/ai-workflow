import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { workflowRuns } from "../../db/schema.js";
import {
  upsertRunSnapshots,
  recordRunUsage,
  type RunSnapshot,
  type RunUsage,
} from "./run-telemetry.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

function row(runId: string) {
  return db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .then((r) => r[0]);
}

const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  runId: "wrun_1",
  workflowId: "wf_agent",
  workflowName: "Agent",
  status: "running",
  ticketKey: "PROJ-1",
  ticketTitle: "Add login",
  ticketUrl: "https://jira/browse/PROJ-1",
  sandboxId: "sbx_1",
  createdAt: new Date("2026-06-15T10:00:00Z"),
  startedAt: new Date("2026-06-15T10:00:05Z"),
  completedAt: null,
  durationSec: null,
  prRepo: null,
  prNumber: null,
  ...over,
});

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  runId: "wrun_1",
  workflowId: "wf_agent",
  workflowName: "Agent",
  status: "success",
  ticketKey: "PROJ-1",
  ticketTitle: "Add login",
  ticketUrl: "https://jira/browse/PROJ-1",
  model: "claude-opus-4-6",
  costUsd: 1.23,
  costKnown: true,
  tokensInput: 1000,
  tokensCached: 200,
  tokensOutput: 500,
  phases: { Research: { costUsd: 0.5, tokens: null, durationMs: 60000, numTurns: 3 } },
  prUrl: "https://github.com/o/r/pull/7",
  prNumber: 7,
  steps: null,
  ...over,
});

describe("upsertRunSnapshots", () => {
  it("inserts a row", async () => {
    await upsertRunSnapshots(db, [snapshot()]);
    const r = await row("wrun_1");
    expect(r.status).toBe("running");
    expect(r.ticketKey).toBe("PROJ-1");
    expect(r.ticketTitle).toBe("Add login");
  });

  it("is a no-op for an empty batch", async () => {
    await upsertRunSnapshots(db, []);
    expect(await db.select().from(workflowRuns)).toHaveLength(0);
  });

  it("updates status/timing on re-snapshot", async () => {
    await upsertRunSnapshots(db, [snapshot()]);
    await upsertRunSnapshots(db, [
      snapshot({
        status: "success",
        completedAt: new Date("2026-06-15T10:05:00Z"),
        durationSec: 295,
      }),
    ]);
    const r = await row("wrun_1");
    expect(r.status).toBe("success");
    expect(r.durationSec).toBe(295);
  });

  it("never downgrades a terminal status back to running", async () => {
    // The world reports a finished run as 'completed'→'success', and there's a
    // brief post-completion window where it still reads 'running'. Once a row is
    // terminal, a re-snapshot must leave it alone.
    await upsertRunSnapshots(db, [snapshot({ status: "success" })]);
    await upsertRunSnapshots(db, [snapshot({ status: "running" })]);
    expect((await row("wrun_1")).status).toBe("success");

    await upsertRunSnapshots(db, [snapshot({ runId: "wrun_2", status: "failed" })]);
    await upsertRunSnapshots(db, [snapshot({ runId: "wrun_2", status: "running" })]);
    expect((await row("wrun_2")).status).toBe("failed");
  });

  it("still advances a running row to a terminal status", async () => {
    await upsertRunSnapshots(db, [snapshot({ status: "running" })]);
    await upsertRunSnapshots(db, [snapshot({ status: "success" })]);
    expect((await row("wrun_1")).status).toBe("success");
  });

  it("does not erase a known ticket title when a later snapshot lacks it", async () => {
    await upsertRunSnapshots(db, [snapshot()]);
    await upsertRunSnapshots(db, [snapshot({ ticketTitle: null, ticketKey: null })]);
    const r = await row("wrun_1");
    expect(r.ticketTitle).toBe("Add login");
    expect(r.ticketKey).toBe("PROJ-1");
  });
});

describe("recordRunUsage", () => {
  it("inserts cost when no snapshot exists yet", async () => {
    await recordRunUsage(db, usage());
    const r = await row("wrun_1");
    expect(r.costUsd).toBeCloseTo(1.23);
    expect(r.tokensOutput).toBe(500);
    expect(r.prNumber).toBe(7);
    // The workflow writes its own terminal status — no longer waits on the cron.
    expect(r.status).toBe("success");
    expect(r.completedAt).not.toBeNull();
  });

  it("records a failed outcome", async () => {
    await recordRunUsage(db, usage({ status: "failed" }));
    const r = await row("wrun_1");
    expect(r.status).toBe("failed");
  });

  it("records the workflow identity so a cron-less run is attributable to its workflow", async () => {
    // No prior snapshot (the cron never observed this run). The workflow knows
    // its own identity, so the row must still carry workflowId/workflowName —
    // otherwise it reads as wf_unknown in the runs list and is counted under no
    // workflow in the workflows table.
    await recordRunUsage(db, usage());
    const r = await row("wrun_1");
    expect(r.workflowId).toBe("wf_agent");
    expect(r.workflowName).toBe("Agent");
  });

  it("persists the captured step waterfall", async () => {
    const steps = [
      {
        stepId: "s1",
        name: "provisionSandbox",
        rawName: "step//provisionSandbox",
        status: "completed" as const,
        attempt: 1,
        createdAt: "2026-06-15T10:00:00Z",
        startedAt: "2026-06-15T10:00:00Z",
        completedAt: "2026-06-15T10:00:15Z",
        startOffsetMs: 0,
        durationMs: 15_000,
        error: null,
      },
    ];
    await recordRunUsage(db, usage({ steps }));
    expect((await row("wrun_1")).steps).toEqual(steps);
  });

  it("does not erase a captured waterfall when a later write has null steps", async () => {
    const steps = [
      {
        stepId: "s1",
        name: "doThing",
        rawName: "step//doThing",
        status: "completed" as const,
        attempt: 1,
        createdAt: "2026-06-15T10:00:00Z",
        startedAt: "2026-06-15T10:00:00Z",
        completedAt: "2026-06-15T10:00:05Z",
        startOffsetMs: 0,
        durationMs: 5_000,
        error: null,
      },
    ];
    await recordRunUsage(db, usage({ steps }));
    await recordRunUsage(db, usage({ steps: null }));
    expect((await row("wrun_1")).steps).toEqual(steps);
  });

  it("overwrites the cron's in-flight 'running' and fills duration from the start", async () => {
    // Cron snapshotted the run mid-flight: running, started, no completion.
    await upsertRunSnapshots(db, [
      snapshot({
        status: "running",
        startedAt: new Date("2026-06-15T10:00:05Z"),
        completedAt: null,
        durationSec: null,
      }),
    ]);
    await recordRunUsage(db, usage({ status: "failed" }));
    const r = await row("wrun_1");
    expect(r.status).toBe("failed"); // workflow truth beats the stale 'running'
    expect(r.completedAt).not.toBeNull();
    expect(r.durationSec).not.toBeNull();
    expect(r.durationSec!).toBeGreaterThan(0); // now() - startedAt
  });
});

describe("two writers converge on one row", () => {
  it("merges snapshot then usage", async () => {
    await upsertRunSnapshots(db, [snapshot()]);
    await recordRunUsage(db, usage());
    const r = await row("wrun_1");
    expect(r.status).toBe("success"); // workflow finalizes the cron's 'running'
    expect(r.ticketTitle).toBe("Add login"); // from cron
    expect(r.costUsd).toBeCloseTo(1.23); // from workflow
    expect(r.prNumber).toBe(7); // from workflow
  });

  it("merges usage then snapshot (order independent)", async () => {
    await recordRunUsage(db, usage());
    // A later cron snapshot must NOT downgrade the workflow's terminal status.
    await upsertRunSnapshots(db, [snapshot()]);
    const r = await row("wrun_1");
    expect(r.status).toBe("success");
    expect(r.costUsd).toBeCloseTo(1.23);
    expect(r.prNumber).toBe(7);
  });

  it("a later cron snapshot does not clobber the agent PR", async () => {
    await recordRunUsage(db, usage());
    await upsertRunSnapshots(db, [snapshot()]); // snapshot has no PR
    await upsertRunSnapshots(db, [snapshot({ status: "success" })]);
    const r = await row("wrun_1");
    expect(r.prNumber).toBe(7); // preserved
    expect(r.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(r.status).toBe("success");
  });

  it("keeps a gate PR from the cron when the workflow has none", async () => {
    await upsertRunSnapshots(db, [snapshot({ prRepo: "o/r", prNumber: 42 })]);
    await recordRunUsage(db, usage({ prUrl: null, prNumber: null }));
    const r = await row("wrun_1");
    expect(r.prNumber).toBe(42);
    expect(r.prRepo).toBe("o/r");
  });
});
