import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { workflowRuns } from "../../db/schema.js";
import {
  upsertRunSnapshots,
  recordRunUsage,
  recordBlockStatuses,
  resolveAwaitingRun,
  resolveAwaitingRunsForTicket,
  type RunSnapshot,
  type RunUsage,
  type RunBlockStatusWrite,
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

const blockWrite = (over: Partial<RunBlockStatusWrite> = {}): RunBlockStatusWrite => ({
  runId: "wrun_1",
  ticketKey: "PROJ-1",
  ticketTitle: "Add login",
  ticketUrl: "https://jira/browse/PROJ-1",
  definitionVersion: 3,
  definitionId: 7,
  blockStatuses: { b1: { status: "running" }, b2: { status: "pending" } },
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

describe("recordBlockStatuses", () => {
  it("inserts a row with statuses, version, identity and running status", async () => {
    await recordBlockStatuses(db, blockWrite());
    const r = await row("wrun_1");
    expect(r.blockStatuses).toEqual({
      b1: { status: "running" },
      b2: { status: "pending" },
    });
    expect(r.definitionVersion).toBe(3);
    expect(r.definitionId).toBe(7);
    expect(r.workflowId).toBe("wf_agent");
    expect(r.workflowName).toBe("Agent");
    expect(r.status).toBe("running");
    expect(r.ticketKey).toBe("PROJ-1");
    expect(r.ticketTitle).toBe("Add login");
  });

  it("updates definition_id on conflict", async () => {
    await recordBlockStatuses(db, blockWrite());
    await recordBlockStatuses(db, blockWrite({ definitionId: 9 }));
    expect((await row("wrun_1")).definitionId).toBe(9);
  });

  it("does not write definition_id from the other writers", async () => {
    await upsertRunSnapshots(db, [snapshot()]);
    expect((await row("wrun_1")).definitionId).toBeNull();
    await recordRunUsage(db, usage());
    expect((await row("wrun_1")).definitionId).toBeNull();
  });

  it("leaves block columns intact when a later snapshot lands", async () => {
    await recordBlockStatuses(db, blockWrite());
    await upsertRunSnapshots(db, [
      snapshot({
        status: "success",
        completedAt: new Date("2026-06-15T10:05:00Z"),
        durationSec: 295,
      }),
    ]);
    const r = await row("wrun_1");
    expect(r.blockStatuses).toEqual({
      b1: { status: "running" },
      b2: { status: "pending" },
    });
    expect(r.definitionVersion).toBe(3);
    expect(r.status).toBe("success"); // snapshot owns status
  });

  it("lands the terminal status via recordRunUsage without touching block columns", async () => {
    await recordBlockStatuses(db, blockWrite());
    await recordRunUsage(db, usage({ status: "success" }));
    const r = await row("wrun_1");
    expect(r.blockStatuses).toEqual({
      b1: { status: "running" },
      b2: { status: "pending" },
    });
    expect(r.definitionVersion).toBe(3);
    expect(r.status).toBe("success");
    expect(r.costUsd).toBeCloseTo(1.23);
  });

  it("updates only its own columns on a cron-inserted row", async () => {
    await upsertRunSnapshots(db, [snapshot()]);
    await recordBlockStatuses(
      db,
      blockWrite({ blockStatuses: { b1: { status: "ok" } }, definitionVersion: 5 }),
    );
    const r = await row("wrun_1");
    expect(r.blockStatuses).toEqual({ b1: { status: "ok" } });
    expect(r.definitionVersion).toBe(5);
    // Cron-owned columns untouched.
    expect(r.status).toBe("running");
    expect(r.ticketTitle).toBe("Add login");
    expect(r.sandboxId).toBe("sbx_1");
  });
});

describe("awaiting (clarification park)", () => {
  it("recordRunUsage writes status 'awaiting'", async () => {
    await recordRunUsage(db, usage({ status: "awaiting" }));
    expect((await row("wrun_1")).status).toBe("awaiting");
  });

  it("a later world-derived 'success' snapshot must not flip an awaiting row", async () => {
    // The world reports a parked run as completed→success; the cron must leave
    // awaiting alone so the answer endpoint owns the transition.
    await recordRunUsage(db, usage({ status: "awaiting" }));
    await upsertRunSnapshots(db, [snapshot({ status: "success" })]);
    expect((await row("wrun_1")).status).toBe("awaiting");
  });

  it("resolveAwaitingRun flips awaiting → success and returns true", async () => {
    await recordRunUsage(db, usage({ status: "awaiting" }));
    const flipped = await resolveAwaitingRun(db, "wrun_1");
    expect(flipped).toBe(true);
    expect((await row("wrun_1")).status).toBe("success");
  });

  it("resolveAwaitingRun is a no-op on a non-awaiting row", async () => {
    await recordRunUsage(db, usage({ status: "success" }));
    const flipped = await resolveAwaitingRun(db, "wrun_1");
    expect(flipped).toBe(false);
    expect((await row("wrun_1")).status).toBe("success");
  });

  it("resolveAwaitingRun is a no-op for a missing run", async () => {
    expect(await resolveAwaitingRun(db, "wrun_missing")).toBe(false);
  });

  it("resolveAwaitingRunsForTicket flips other awaiting runs for the ticket, excluding the current run", async () => {
    await recordRunUsage(db, usage({ runId: "wrun_old", status: "awaiting" }));
    await recordRunUsage(db, usage({ runId: "wrun_new", status: "awaiting" }));
    const flipped = await resolveAwaitingRunsForTicket(db, "PROJ-1", "wrun_new");
    expect(flipped).toBe(1);
    expect((await row("wrun_old")).status).toBe("success");
    expect((await row("wrun_new")).status).toBe("awaiting");
  });

  it("resolveAwaitingRunsForTicket ignores other tickets and non-awaiting rows", async () => {
    await recordRunUsage(db, usage({ runId: "wrun_other_ticket", status: "awaiting", ticketKey: "PROJ-2" }));
    await recordRunUsage(db, usage({ runId: "wrun_done", status: "success" }));
    const flipped = await resolveAwaitingRunsForTicket(db, "PROJ-1", "wrun_current");
    expect(flipped).toBe(0);
    expect((await row("wrun_other_ticket")).status).toBe("awaiting");
    expect((await row("wrun_done")).status).toBe("success");
  });
});
