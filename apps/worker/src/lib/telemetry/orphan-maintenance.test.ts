import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { activeRuns, workflowRuns } from "../../db/schema.js";
import {
  assertProductionAcknowledged,
  formatCleanupResult,
  listOrphanedRunningRuns,
  parseCleanupArguments,
  runCleanup,
  runCleanupCli,
} from "../../../scripts/cleanup-orphaned-running-runs.js";
import { sweepOrphanedRunningRuns } from "./run-telemetry.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("cleanup-orphaned-running-runs", () => {
  it("defaults to a read-only dry-run and prints only safe candidate fields", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_dry_run",
      subjectKey: "ticket:jira:AIW-271",
      ticketKey: "AIW-271",
      status: "running",
      statusReason: null,
    });
    const output: string[] = [];

    await runCleanupCli([], { getDb: async () => db, write: (text) => output.push(text) });

    expect(output.join("")).toBe("dry-run candidates: 1\nwrun_dry_run\trunning\tAIW-271\n");
    expect(
      (await db.select().from(workflowRuns).where(eq(workflowRuns.runId, "wrun_dry_run")))[0]
        ?.status,
    ).toBe("running");
  });

  it("rejects unknown flags", () => {
    expect(() => parseCleanupArguments(["--poll"])).toThrow("Unknown flag: --poll");
  });

  it("requires production confirmation for apply", () => {
    expect(() =>
      assertProductionAcknowledged(
        parseCleanupArguments(["--apply"]),
        { NODE_ENV: "production" },
      ),
    ).toThrow("--confirm-production");
    expect(() =>
      assertProductionAcknowledged(
        parseCleanupArguments(["--apply", "--confirm-production"]),
        { VERCEL_ENV: "production" },
      ),
    ).not.toThrow();
  });

  it("selects exactly eligible candidates and excludes claims, gates, awaiting, and terminal rows", async () => {
    await db.insert(workflowRuns).values([
      {
        runId: "wrun_eligible",
        subjectKey: "ticket:jira:AIW-271",
        ticketKey: "AIW-271",
        status: "running",
      },
      {
        runId: "wrun_claimed",
        subjectKey: "ticket:jira:AIW-272",
        ticketKey: "AIW-272",
        status: "running",
      },
      { runId: "wrun_gate", workflowId: "wf_post_pr_gate", status: "running" },
      {
        runId: "wrun_awaiting",
        subjectKey: "ticket:jira:AIW-273",
        ticketKey: "AIW-273",
        status: "awaiting",
      },
      {
        runId: "wrun_success",
        subjectKey: "ticket:jira:AIW-274",
        ticketKey: "AIW-274",
        status: "success",
      },
    ]);
    await db.insert(activeRuns).values({
      subjectKey: "ticket:jira:AIW-272",
      ticketKey: "AIW-272",
      ownerToken: "owner-272",
      runId: "wrun_claimed",
      state: "bound",
      runKind: "ticket",
    });

    await expect(listOrphanedRunningRuns(db)).resolves.toEqual([
      { runId: "wrun_eligible", status: "running", ticketKey: "AIW-271" },
    ]);
  });

  it("uses the existing sweep only with --apply and verifies the postcondition", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_apply",
      subjectKey: "ticket:jira:AIW-271",
      ticketKey: "AIW-271",
      status: "running",
    });
    const sweep = vi.fn((candidateDb: Db) => sweepOrphanedRunningRuns(candidateDb));

    const result = await runCleanup(db, parseCleanupArguments(["--apply"]), sweep);

    expect(sweep).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ mode: "apply", remainingCandidates: 0 });
    expect(
      (await db.select().from(workflowRuns).where(eq(workflowRuns.runId, "wrun_apply")))[0]
        ?.status,
    ).toBe("blocked");
  });

  it("fails when eligible candidates remain after apply", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_still_orphaned",
      subjectKey: "ticket:jira:AIW-271",
      ticketKey: "AIW-271",
      status: "running",
    });

    await expect(
      runCleanup(db, parseCleanupArguments(["--apply"]), vi.fn(async () => 0)),
    ).rejects.toThrow("postcondition failed");
  });

  it("propagates update failures", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_update_failure",
      subjectKey: "ticket:jira:AIW-271",
      ticketKey: "AIW-271",
      status: "running",
    });

    await expect(
      runCleanup(
        db,
        parseCleanupArguments(["--apply"]),
        vi.fn(async () => {
          throw new Error("database update failed");
        }),
      ),
    ).rejects.toThrow("database update failed");
  });

  it("propagates database failures as command failures", async () => {
    await expect(
      listOrphanedRunningRuns({
        select: () => {
          throw new Error("database unavailable");
        },
      } as unknown as Db),
    ).rejects.toThrow("database unavailable");
    await expect(
      runCleanupCli([], { getDb: async () => { throw new Error("database unavailable"); } }),
    ).rejects.toThrow("database unavailable");
  });

  it("formats apply output without payloads", () => {
    expect(
      formatCleanupResult({
        mode: "apply",
        candidates: [{ runId: "wrun_1", status: "running", ticketKey: null }],
        remainingCandidates: 0,
      }),
    ).toBe("apply candidates: 1\nwrun_1\trunning\t-\nremaining candidates: 0\n");
  });
});
