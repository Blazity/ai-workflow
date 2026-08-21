import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunAnalysisReport } from "@shared/contracts";
import { createTestDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import {
  buildResearchAnalysisReport,
  usageSnapshot,
  withAnalysisDelivery,
  withAnalysisPublication,
} from "./report.js";
import { finalizeRunAnalysisUsage, getRunAnalysisReport, recordRunAnalysisReport } from "./store.js";

let db: Db;
beforeAll(async () => { db = await createTestDb(); }, 60_000);
beforeEach(async () => { await db.delete(workflowRuns); });

function report(): RunAnalysisReport {
  return buildResearchAnalysisReport({ runId: "store-run", researchResult: { body: "# Plan" }, usage: { costUsd: 1, costKnown: true, tokensInput: 1, tokensCached: 0, tokensOutput: 1, phases: {} } });
}

describe("run analysis report store", () => {
  it("upserts a report and parses the JSONB value", async () => {
    const value = report();
    await recordRunAnalysisReport(db, value);
    expect(await getRunAnalysisReport(db, value.runId)).toEqual(value);
    await recordRunAnalysisReport(db, value);
    expect((await getRunAnalysisReport(db, value.runId))?.jira.research.state).toBe("pending");
  });

  it("finalizes only the final usage slot", async () => {
    const value = report();
    await recordRunAnalysisReport(db, value);
    await finalizeRunAnalysisUsage(db, value.runId, { ...value.usage.research, capturedAt: "final" });
    const stored = await getRunAnalysisReport(db, value.runId);
    expect(stored?.usage.final?.capturedAt).toBe("final");
    expect(stored?.usage.research.capturedAt).toBe(value.usage.research.capturedAt);
  });

  it("never lets a stale replay erase forward lifecycle state", async () => {
    const pending = report();
    const posted = withAnalysisDelivery(pending, "research", {
      state: "posted",
      attemptedAt: "2026-08-20T00:01:00.000Z",
      commentUrl: "https://jira.example/comment/1",
      error: null,
    });
    const published = withAnalysisPublication(
      posted,
      [{ provider: "github", repoPath: "acme/api", id: 1, url: "https://github.example/pr/1" }],
      "Implemented",
      usageSnapshot({ costUsd: 2, costKnown: true, tokensInput: 2, tokensCached: 0, tokensOutput: 2, phases: {} }, "2026-08-20T00:02:00.000Z"),
    );
    await recordRunAnalysisReport(db, published);
    await finalizeRunAnalysisUsage(db, pending.runId, {
      ...pending.usage.research,
      capturedAt: "2026-08-20T00:03:00.000Z",
    });
    const revised = buildResearchAnalysisReport({
      runId: pending.runId,
      researchRevision: 2,
      researchCompletedAt: "2026-08-20T00:04:00.000Z",
      researchResult: {
        body: "# Revised plan",
        repositoryEvidence: ["newer evidence"],
      },
      usage: {
        costUsd: 3,
        costKnown: true,
        tokensInput: 3,
        tokensCached: 0,
        tokensOutput: 3,
        phases: {},
      },
    });
    await recordRunAnalysisReport(db, revised);
    await recordRunAnalysisReport(db, pending);

    const stored = await getRunAnalysisReport(db, pending.runId);
    expect(stored?.researchRevision).toBe(2);
    expect(stored?.planMarkdown).toBe("# Revised plan");
    expect(stored?.evidence).toEqual(["newer evidence"]);
    expect(stored?.usage.research.costUsd).toBe(3);
    expect(stored?.stage).toBe("published");
    expect(stored?.publication?.prs).toHaveLength(1);
    expect(stored?.jira.research.state).toBe("posted");
    expect(stored?.usage.publication).not.toBeNull();
    expect(stored?.usage.final?.capturedAt).toBe("2026-08-20T00:03:00.000Z");
  });

  it("returns null for absent and malformed values", async () => {
    expect(await getRunAnalysisReport(db, "absent")).toBeNull();
  });
});
