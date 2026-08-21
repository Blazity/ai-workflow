import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../test-db.js";
import type { Db } from "../client.js";
import { workflowRuns } from "../schema.js";
import type { HarnessRunManifestRecord } from "@shared/contracts";
import { fetchRunDetailFromDb, fetchRunRefs } from "./run-detail-read.js";
import { buildResearchAnalysisReport } from "../../run-analysis/report.js";

/** Minimal fixture: attributeRunModel only reads `.nodeId` / `.manifest.model.id`. */
function harnessManifest(nodeId: string, modelId: string): HarnessRunManifestRecord {
  return {
    nodeId,
    manifest: { model: { id: modelId } },
  } as unknown as HarnessRunManifestRecord;
}

const JIRA = "https://blazity.atlassian.net";
let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const base = { jiraBaseUrl: JIRA };

describe("fetchRunDetailFromDb", () => {
  it("returns null for an unknown run id", async () => {
    expect(await fetchRunDetailFromDb({ db, runId: "nope", ...base })).toBeNull();
  });

  it("round-trips a valid report and treats legacy JSON as null", async () => {
    const report = buildResearchAnalysisReport({
      runId: "r-report",
      researchResult: { body: "# Plan" },
      usage: { costUsd: 0, costKnown: true, tokensInput: 0, tokensCached: 0, tokensOutput: 0, phases: {} },
    });
    await db.insert(workflowRuns).values({ runId: "r-report", analysisReport: report, startedAt: new Date() });
    const result = await fetchRunDetailFromDb({ db, runId: "r-report", ...base });
    expect(result?.analysisReport).toEqual(report);
    await db.insert(workflowRuns).values({ runId: "r-legacy", startedAt: new Date() });
    expect((await fetchRunDetailFromDb({ db, runId: "r-legacy", ...base }))?.analysisReport).toBeNull();
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

  it("prefers the live per-block model while a run is still in flight", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "running",
      model: null,
      harnessManifests: [harnessManifest("planning", "gpt-5.6-sol")],
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.model).toBe("gpt-5.6-sol");
  });

  it("attributes the failing first phase's harness model, not the org default", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "failed",
      // The org default the run never used: recordRunUsage persisted it from
      // activeModel's prepare_workspace seeding.
      model: "claude-opus-4-8",
      harnessManifests: [
        harnessManifest("planning-1", "gpt-5.6-sol"),
        harnessManifest("review-1", "claude-opus-4-8"),
      ],
      blockStatuses: {
        "planning-1": { status: "fail" },
        "review-1": { status: "pending" },
      },
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.model).toBe("gpt-5.6-sol");
  });

  it("keeps the persisted terminal model of a completed mixed-profile run", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "success",
      model: "gpt-5.6-luna",
      harnessManifests: [
        harnessManifest("planning-1", "gpt-5.6-sol"),
        harnessManifest("implementation-1", "gpt-5.6-luna"),
      ],
      blockStatuses: {
        "planning-1": { status: "ok" },
        "implementation-1": { status: "ok" },
      },
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.model).toBe("gpt-5.6-luna");
  });

  it("keeps the persisted terminal model when a finished run has no manifest", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "success",
      model: "gpt-5.6-luna",
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.model).toBe("gpt-5.6-luna");
  });

  it("reports no model when the run has neither a persisted one nor a manifest", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "failed",
      model: null,
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.model).toBeNull();
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

  it("surfaces the persisted status reason as the error for a blocked run", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "blocked",
      statusReason: "Orphaned run cancelled by reconciler",
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.statusReason).toBe("Orphaned run cancelled by reconciler");
    expect(res?.run.error).toEqual({
      message: "Orphaned run cancelled by reconciler",
    });
  });

  it("surfaces the persisted status reason as the error for a failed run", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "failed",
      statusReason: "Implementation phase timed out",
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.error).toEqual({ message: "Implementation phase timed out" });
  });

  it("keeps error null when the run has no reason or is not blocked/failed", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "success",
      statusReason: "stale reason",
      startedAt: new Date(),
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.statusReason).toBe("stale reason");
    expect(res?.run.error).toBeNull();

    await db.insert(workflowRuns).values({
      runId: "r2",
      status: "blocked",
      startedAt: new Date(),
    });
    const res2 = await fetchRunDetailFromDb({ db, runId: "r2", ...base });
    expect(res2?.run.statusReason).toBeNull();
    expect(res2?.run.error).toBeNull();
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

  it("prefers persisted real steps over phase synthesis", async () => {
    const steps = [
      {
        stepId: "s1",
        name: "provisionSandbox",
        rawName: "step//provisionSandbox",
        status: "completed",
        attempt: 1,
        createdAt: "2026-06-16T10:00:00Z",
        startedAt: "2026-06-16T10:00:00Z",
        completedAt: "2026-06-16T10:00:15Z",
        startOffsetMs: 0,
        durationMs: 15_000,
        error: null,
      },
    ];
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "success",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      completedAt: new Date("2026-06-16T10:05:00Z"),
      steps,
      phases: { Setup: { durationMs: 10_000 } }, // present but must be ignored
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.hasRealSteps).toBe(true);
    expect(res?.steps.map((s) => s.name)).toEqual(["provisionSandbox"]);
  });

  it("sanitizes historical persisted step errors before returning them", async () => {
    await db.insert(workflowRuns).values({
      runId: "legacy-errors",
      status: "failed",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      steps: [
        {
          stepId: "s1",
          name: "legacyStep",
          rawName: "step//legacyStep",
          status: "failed",
          attempt: 1,
          createdAt: "2026-06-16T10:00:00Z",
          startedAt: "2026-06-16T10:00:00Z",
          completedAt: "2026-06-16T10:00:01Z",
          startOffsetMs: 0,
          durationMs: 1_000,
          error: {
            message: "Error: legacy provider failure",
            code: "INTERNAL_PROVIDER_CODE",
            stack: "SECRET_STACK at /srv/provider.ts:7:3",
          },
        },
      ],
    });

    const result = await fetchRunDetailFromDb({
      db,
      runId: "legacy-errors",
      ...base,
    });

    expect(result?.steps[0]?.error).toEqual({
      message: "legacy provider failure",
    });
    expect(JSON.stringify(result?.steps)).not.toContain("SECRET_STACK");
    expect(JSON.stringify(result?.steps)).not.toContain("/srv/provider.ts");
  });

  it("normalizes a still-running step in a finished run to completed", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "success",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      completedAt: new Date("2026-06-16T10:05:00Z"),
      steps: [
        {
          stepId: "s1",
          name: "recordRunTelemetry",
          rawName: "step//recordRunTelemetry",
          status: "running",
          attempt: 1,
          createdAt: "2026-06-16T10:04:50Z",
          startedAt: "2026-06-16T10:04:50Z",
          completedAt: null,
          startOffsetMs: 290_000,
          durationMs: null,
          error: null,
        },
      ],
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.steps[0].status).toBe("completed");
    expect(res?.steps[0].completedAt).toBe("2026-06-16T10:05:00.000Z");
    expect(res?.steps[0].durationMs).toBe(10_000);
  });

  it("normalizes a still-running telemetry step in a parked (awaiting) run", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "awaiting",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      steps: [
        {
          stepId: "s1",
          name: "recordRunTelemetry",
          rawName: "step//recordRunTelemetry",
          status: "running",
          attempt: 1,
          createdAt: "2026-06-16T10:04:50Z",
          startedAt: "2026-06-16T10:04:50Z",
          completedAt: null,
          startOffsetMs: 290_000,
          durationMs: null,
          error: null,
        },
      ],
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.run.status).toBe("awaiting");
    expect(res?.steps[0].status).toBe("completed");
  });

  it("reports hasRealSteps=false when falling back to phase synthesis", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      phases: { Setup: { durationMs: 10_000 } },
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.hasRealSteps).toBe(false);
    expect(res?.steps.map((s) => s.name)).toEqual(["Setup"]);
  });
});

describe("fetchRunRefs", () => {
  it("returns null for an unknown run id", async () => {
    expect(await fetchRunRefs(db, "nope", JIRA)).toBeNull();
  });

  it("returns the persisted ticket + PR refs", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      ticketKey: "AWT-981",
      ticketTitle: "Add greeting endpoint",
      prUrl: "https://github.com/acme/demo/pull/42",
      prNumber: 42,
    });
    expect(await fetchRunRefs(db, "r1", JIRA)).toEqual({
      ticketKey: "AWT-981",
      ticketUrl: "https://blazity.atlassian.net/browse/AWT-981",
      ticketTitle: "Add greeting endpoint",
      prUrl: "https://github.com/acme/demo/pull/42",
      prNumber: 42,
      prs: null,
      statusReason: null,
    });
  });

  it("returns every PR/MR of a multi-repo run", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      ticketKey: "AWT-981",
      prUrl: "https://github.com/acme/backend/pull/12",
      prNumber: 12,
      prs: [
        {
          provider: "github",
          repoPath: "acme/backend",
          id: 12,
          url: "https://github.com/acme/backend/pull/12",
        },
        {
          provider: "gitlab",
          repoPath: "acme/infra",
          id: 3,
          url: "https://gitlab.com/acme/infra/-/merge_requests/3",
        },
      ],
    });
    expect((await fetchRunRefs(db, "r1", JIRA))?.prs).toEqual([
      {
        provider: "github",
        repoPath: "acme/backend",
        id: 12,
        url: "https://github.com/acme/backend/pull/12",
      },
      {
        provider: "gitlab",
        repoPath: "acme/infra",
        id: 3,
        url: "https://gitlab.com/acme/infra/-/merge_requests/3",
      },
    ]);
  });

  it("returns the persisted status reason", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "blocked",
      statusReason: "Cancelled via Slack /ai-workflow cancel",
    });
    const refs = await fetchRunRefs(db, "r1", JIRA);
    expect(refs?.statusReason).toBe("Cancelled via Slack /ai-workflow cancel");
  });

  it("derives the ticket url from the key when none is stored", async () => {
    await db.insert(workflowRuns).values({ runId: "r1", ticketKey: "AWT-5" });
    const refs = await fetchRunRefs(db, "r1", JIRA);
    expect(refs?.ticketUrl).toBe("https://blazity.atlassian.net/browse/AWT-5");
  });
});
