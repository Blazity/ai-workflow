import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix)
    .sort();
  for (const file of files) await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  return client;
}

describe("0054 run analysis report migration", () => {
  it("preserves existing runs and leaves the new report nullable", async () => {
    const client = await migrateThrough("0053");
    await client.exec(`INSERT INTO workflow_runs (run_id, status) VALUES ('legacy-report-run', 'success')`);
    await client.exec(readFileSync(`${migrationsDir}0054_run_analysis_report.sql`, "utf8"));
    const rows = await client.query<{ run_id: string; status: string; analysis_report: unknown }>(
      `SELECT run_id, status, analysis_report FROM workflow_runs WHERE run_id = 'legacy-report-run'`,
    );
    expect(rows.rows).toEqual([{ run_id: "legacy-report-run", status: "success", analysis_report: null }]);
  });

  it("round-trips a version-1 report on a fresh schema", async () => {
    const client = await migrateThrough("0054");
    const report = {
      version: 1,
      runId: "report-run",
      sourceResearchRunId: "report-run",
      researchRevision: 1,
      stage: "research_complete",
      researchCompletedAt: "2026-08-20T00:00:00.000Z",
      repositories: [],
      expansionRounds: 0,
      repositoryRequests: [],
      writeRepositories: [],
      evidenceStatus: "captured",
      evidence: [],
      planMarkdown: "# Plan",
      noChangeNeeded: false,
      resolutionEvidence: [],
      publication: null,
      usage: {
        research: {
          capturedAt: "2026-08-20T00:00:00.000Z",
          costUsd: 0,
          costKnown: true,
          tokensInput: 0,
          tokensCached: 0,
          tokensOutput: 0,
          phases: {},
        },
        publication: null,
        final: null,
      },
      jira: {
        research: { state: "pending", attemptedAt: null, commentUrl: null, error: null },
        pullRequest: { state: "not_applicable", attemptedAt: null, commentUrl: null, error: null },
      },
      sanitization: {
        redactions: {},
        truncated: false,
        originalBytes: 8,
        storedBytes: 8,
        unavailable: false,
        unavailableReason: null,
      },
    };
    await client.query(`INSERT INTO workflow_runs (run_id, analysis_report) VALUES ($1, $2::jsonb)`, ["report-run", JSON.stringify(report)]);
    const rows = await client.query<{ analysis_report: typeof report }>(
      `SELECT analysis_report FROM workflow_runs WHERE run_id = 'report-run'`,
    );
    expect(rows.rows[0]?.analysis_report).toEqual(report);
  });
});
