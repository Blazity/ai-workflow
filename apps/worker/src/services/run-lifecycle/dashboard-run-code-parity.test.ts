import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { workflowRuns } from "../../db/schema.js";
import { listRuns } from "./dashboard-run-data.js";

vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));

/**
 * The runs list the dashboard renders, for a failure that carries no code.
 *
 * That is every failure the product produces today and every run that failed
 * before the column existed. Adding a column to `workflow_runs` is only safe
 * for them because two layers name what they want: the query selects an
 * explicit column list, and `mapRun` builds the row the dashboard renders field
 * by field. The mapper is the one that decides, and the day someone spreads the
 * database row into it the list grows a field nobody designed. This is what
 * says so.
 */

const now = new Date("2026-09-19T12:00:00Z");
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

function list() {
  return listRuns({
    db,
    window: "all",
    q: null,
    now,
    ticketOrigin: "https://jira.example",
  });
}

describe("the dashboard runs list", () => {
  it("shows a failure with no code exactly as it always did", async () => {
    await db.insert(workflowRuns).values({
      runId: "r-nocode",
      workflowId: "wf_agent",
      workflowName: "Agent",
      status: "failed",
      statusReason: "Implementation phase timed out",
      startedAt: new Date("2026-09-19T10:00:00Z"),
      firstSeenAt: new Date("2026-09-19T10:00:00Z"),
    });

    const { rows } = await list();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.statusReason).toBe("Implementation phase timed out");
    expect(Object.keys(rows[0] ?? {})).not.toContain("statusReasonCode");
  });

  it("does not hand the list a code even when the run has one", async () => {
    // The code is for the durable record and for S3, which reads the column.
    // It is not part of this payload until somebody decides it is.
    await db.insert(workflowRuns).values({
      runId: "r-code",
      workflowId: "wf_agent",
      workflowName: "Agent",
      status: "failed",
      statusReason: "Acme Notify is disabled.",
      statusReasonCode: "integration_unavailable.disabled",
      startedAt: new Date("2026-09-19T10:00:00Z"),
      firstSeenAt: new Date("2026-09-19T10:00:00Z"),
    });

    const { rows } = await list();

    expect(rows[0]?.statusReason).toBe("Acme Notify is disabled.");
    expect(Object.keys(rows[0] ?? {})).not.toContain("statusReasonCode");
  });
});
