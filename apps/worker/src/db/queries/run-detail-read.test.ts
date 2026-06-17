import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../test-db.js";
import type { Db } from "../client.js";
import { workflowRuns } from "../schema.js";
import { fetchRunDetailFromDb, fetchRunPr } from "./run-detail-read.js";

const JIRA = "https://blazity.atlassian.net";
let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const base = { jiraBaseUrl: JIRA, modelFallback: "claude-fallback" };

describe("fetchRunDetailFromDb", () => {
  it("returns null for an unknown run id", async () => {
    expect(await fetchRunDetailFromDb({ db, runId: "nope", ...base })).toBeNull();
  });

  it("rebuilds the header from the persisted row", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      workflowId: "wf_agent",
      workflowName: "Agent",
      status: "success",
      ticketKey: "AWT-5",
      ticketTitle: "Do the thing",
      model: "claude-opus-4-8",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      completedAt: new Date("2026-06-16T10:05:00Z"),
      durationSec: 300,
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.status).toBe("success");
    expect(res?.run.ticketTitle).toBe("Do the thing");
    expect(res?.run.ticketUrl).toBe(`${JIRA}/browse/AWT-5`);
    expect(res?.run.durationSec).toBe(300);
  });

  it("surfaces the persisted PR ref", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "success",
      prUrl: "https://github.com/acme/demo/pull/42",
      prNumber: 42,
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.prUrl).toBe("https://github.com/acme/demo/pull/42");
    expect(res?.run.prNumber).toBe(42);
  });

  it("leaves PR null when none is recorded", async () => {
    await db.insert(workflowRuns).values({ runId: "r1", startedAt: new Date() });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.prUrl).toBeNull();
    expect(res?.run.prNumber).toBeNull();
  });

  it("synthesizes an ordered phase waterfall with cumulative offsets", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      // intentionally out of canonical order in the jsonb
      phases: {
        Review: { durationMs: 30_000 },
        Setup: { durationMs: 10_000 },
        Research: { durationMs: 20_000 },
      },
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    const steps = res!.steps;
    expect(steps.map((s) => s.name)).toEqual(["Setup", "Research", "Review"]);
    expect(steps.map((s) => s.startOffsetMs)).toEqual([0, 10_000, 30_000]);
    expect(steps[2].durationMs).toBe(30_000);
  });

  it("returns no steps when phases are absent", async () => {
    await db.insert(workflowRuns).values({ runId: "r1", startedAt: new Date() });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.steps).toEqual([]);
  });
});

describe("fetchRunPr", () => {
  it("returns null for an unknown run id", async () => {
    expect(await fetchRunPr(db, "nope")).toBeNull();
  });

  it("returns the persisted PR ref", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      prUrl: "https://github.com/acme/demo/pull/42",
      prNumber: 42,
    });
    expect(await fetchRunPr(db, "r1")).toEqual({
      prUrl: "https://github.com/acme/demo/pull/42",
      prNumber: 42,
    });
  });
});
