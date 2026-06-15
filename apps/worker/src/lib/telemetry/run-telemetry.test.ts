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
    expect(r.status).toBeNull(); // cron hasn't run yet
  });
});

describe("two writers converge on one row", () => {
  it("merges snapshot then usage", async () => {
    await upsertRunSnapshots(db, [snapshot()]);
    await recordRunUsage(db, usage());
    const r = await row("wrun_1");
    expect(r.status).toBe("running"); // from cron
    expect(r.ticketTitle).toBe("Add login"); // from cron
    expect(r.costUsd).toBeCloseTo(1.23); // from workflow
    expect(r.prNumber).toBe(7); // from workflow
  });

  it("merges usage then snapshot (order independent)", async () => {
    await recordRunUsage(db, usage());
    await upsertRunSnapshots(db, [snapshot()]);
    const r = await row("wrun_1");
    expect(r.status).toBe("running");
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
