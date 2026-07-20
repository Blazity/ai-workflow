import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { activeRunSandboxes, activeRuns, gateCurrent } from "../../db/schema.js";
import type {
  RunsLister,
  WorkflowRunRecord,
} from "../overview/collect-runs.js";
import { collectSnapshots } from "./collect-snapshots.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

function listerOf(runs: WorkflowRunRecord[]): RunsLister {
  return { list: async () => ({ data: runs }) };
}

const run = (over: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord => ({
  runId: "wrun_1",
  status: "running",
  workflowName: "agentWorkflow",
  createdAt: new Date("2026-06-15T10:00:00Z"),
  startedAt: new Date("2026-06-15T10:00:05Z"),
  ...over,
});

describe("collectSnapshots", () => {
  it("returns [] when the world has no runs", async () => {
    expect(await collectSnapshots({ runsLister: listerOf([]), db })).toEqual([]);
  });

  it("maps world fields and the domain status", async () => {
    const [s] = await collectSnapshots({
      runsLister: listerOf([run({ status: "completed", completedAt: new Date("2026-06-15T10:05:05Z") })]),
      db,
    });
    expect(s.runId).toBe("wrun_1");
    expect(s.workflowId).toBe("wf_agent");
    expect(s.workflowName).toBe("Agent");
    expect(s.status).toBe("success");
    expect(s.durationSec).toBe(300);
  });

  it("leaves durationSec null while running", async () => {
    const [s] = await collectSnapshots({ runsLister: listerOf([run()]), db });
    expect(s.durationSec).toBeNull();
  });

  it("resolves subject, ticket, and every-owner sandbox metadata without Jira", async () => {
    await db.insert(activeRuns).values({
      subjectKey: "ticket:jira:PROJ-9",
      ticketKey: "PROJ-9",
      ownerToken: "owner-9",
      runId: "wrun_1",
      state: "bound",
    });
    await db.insert(activeRunSandboxes).values({
      subjectKey: "ticket:jira:PROJ-9",
      ownerToken: "owner-9",
      sandboxId: "sbx_9",
    });
    const [s] = await collectSnapshots({ runsLister: listerOf([run()]), db });
    expect(s.subjectKey).toBe("ticket:jira:PROJ-9");
    expect(s.ticketKey).toBe("PROJ-9");
    expect(s.sandboxId).toBe("sbx_9");
    expect(s.ticketTitle).toBeNull(); // workflow-owned
  });

  it("resolves the gate PR from gate_current", async () => {
    await db.insert(gateCurrent).values({
      repo: "o/r",
      pr: 42,
      runId: "wrun_g",
      headSha: "abc",
      expiresAt: new Date("2026-07-01T00:00:00Z"),
    });
    const [s] = await collectSnapshots({
      runsLister: listerOf([run({ runId: "wrun_g", workflowName: "postPrGateWorkflow" })]),
      db,
    });
    expect(s.workflowId).toBe("wf_post_pr_gate");
    expect(s.prRepo).toBe("o/r");
    expect(s.prNumber).toBe(42);
  });

  it("leaves registry fields null for a completed (unregistered) run", async () => {
    const [s] = await collectSnapshots({
      runsLister: listerOf([run({ status: "completed", completedAt: new Date("2026-06-15T10:01:05Z") })]),
      db,
    });
    expect(s.ticketKey).toBeNull();
    expect(s.sandboxId).toBeNull();
  });
});
