import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import type { ResolvedPromptReference } from "@shared/contracts";
import { approvalRequests, clarificationRequests, workflowRuns } from "../../db/schema.js";
import {
  upsertRunSnapshots,
  recordRunUsage,
  recordBlockStatuses,
  recordRunStatusReason,
  resolveAwaitingRun,
  resolveAwaitingRunsForTicket,
  markRunAwaiting,
  markRunBlockedOnCancel,
  markRunBlockedByOperator,
  markRunFailedOnSelfMove,
  markRunResumed,
  markRunSucceededOnSelfMove,
  sweepOrphanedAwaitingRuns,
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
  subjectKey: "ticket:jira:PROJ-1",
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
  subjectKey: "ticket:jira:PROJ-1",
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
  budgetFailure: null,
  prUrl: "https://github.com/o/r/pull/7",
  prNumber: 7,
  prs: [
    { provider: "github", repoPath: "o/r", id: 7, url: "https://github.com/o/r/pull/7" },
  ],
  steps: null,
  ...over,
});

const blockWrite = (over: Partial<RunBlockStatusWrite> = {}): RunBlockStatusWrite => ({
  runId: "wrun_1",
  subjectKey: "ticket:jira:PROJ-1",
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

  it("persists the status reason of a failed run", async () => {
    await recordRunUsage(
      db,
      usage({ status: "failed", statusReason: "Implementation phase timed out" }),
    );
    expect((await row("wrun_1")).statusReason).toBe("Implementation phase timed out");
  });

  it("keeps a recorded reason when a later write has none", async () => {
    await recordRunUsage(
      db,
      usage({ status: "failed", statusReason: "Implementation phase timed out" }),
    );
    await recordRunUsage(db, usage({ status: "failed" }));
    expect((await row("wrun_1")).statusReason).toBe("Implementation phase timed out");
  });

  it("persists structured terminal budget telemetry", async () => {
    const budgetFailure = {
      status: "budget_exceeded" as const,
      metric: "cost" as const,
      limit: 0.3,
      consumed: 0.31,
      reason: "budget_exceeded: cost 0.31 exceeds limit 0.3",
    };

    await recordRunUsage(db, usage({ status: "failed", budgetFailure }));

    expect((await row("wrun_1")).budgetFailure).toEqual(budgetFailure);
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
  it("persists summary-only block state without legacy output values", async () => {
    await recordBlockStatuses(
      db,
      blockWrite({
        blockStatuses: {
          b1: {
            status: "ok",
            attempt: 2,
            output: {
              status: "ok",
              body: "sensitive execution output",
            },
          },
        },
      }),
    );

    expect((await row("wrun_1")).blockStatuses).toEqual({
      b1: { status: "ok", attempt: 2 },
    });
  });

  it("stores the frozen prompt manifest and later writers preserve it", async () => {
    const promptManifest: ResolvedPromptReference[] = [{
      promptId: 42,
      promptName: "research-plan",
      requestedVersion: "latest",
      resolvedVersion: 7,
      bodyHash: "0a1b2c3d",
    }];
    await recordBlockStatuses(db, blockWrite({ promptManifest }));
    expect((await row("wrun_1")).promptManifest).toEqual(promptManifest);

    await recordBlockStatuses(db, blockWrite({ blockStatuses: { b1: { status: "ok" } } }));
    await upsertRunSnapshots(db, [snapshot()]);
    await recordRunUsage(db, usage());
    expect((await row("wrun_1")).promptManifest).toEqual(promptManifest);
  });

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

describe("recordRunStatusReason", () => {
  it("records the cancellation reason on an existing row", async () => {
    await upsertRunSnapshots(db, [snapshot({ status: "blocked" })]);
    await recordRunStatusReason(
      db,
      "wrun_1",
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
    const r = await row("wrun_1");
    expect(r.statusReason).toBe(
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
    expect(r.status).toBe("blocked"); // touches only the reason
  });

  it("inserts a reason-only row when no snapshot exists yet", async () => {
    // A run cancelled before the cron's first snapshot: the reason must survive
    // and the later snapshot fills in the rest of the row.
    await recordRunStatusReason(
      db,
      "wrun_early",
      "Cancelled via Slack /ai-workflow cancel",
    );
    const r = await row("wrun_early");
    expect(r.statusReason).toBe("Cancelled via Slack /ai-workflow cancel");
    expect(r.status).toBeNull();
    expect(r.workflowId).toBeNull();

    await upsertRunSnapshots(db, [
      snapshot({ runId: "wrun_early", status: "blocked" }),
    ]);
    const merged = await row("wrun_early");
    expect(merged.statusReason).toBe("Cancelled via Slack /ai-workflow cancel");
    expect(merged.status).toBe("blocked");
    expect(merged.workflowId).toBe("wf_agent");
  });

  it("lets the concrete failure reason win in either write order", async () => {
    // The trace screen renders this field as the run's error, so a generic
    // cancellation must never mask the concrete cause. The two writers race in
    // both directions: a failing run's own backlog move fires the webhook that
    // cancels the orphan, and the reconciler can retire a run just before its
    // failure lands.
    const failure =
      "The workspace environment could not complete this block. (promoteRepositoryWriteScopeStep failed: Not Found)";
    const cancellation =
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column";

    await recordRunStatusReason(db, "wrun_fail_first", failure, {
      kind: "failure",
    });
    await recordRunStatusReason(db, "wrun_fail_first", cancellation, {
      kind: "cancellation",
    });
    expect((await row("wrun_fail_first")).statusReason).toBe(failure);

    await recordRunStatusReason(db, "wrun_cancel_first", cancellation, {
      kind: "cancellation",
    });
    await recordRunStatusReason(db, "wrun_cancel_first", failure, {
      kind: "failure",
    });
    expect((await row("wrun_cancel_first")).statusReason).toBe(failure);
  });

  it("defaults to filling only a null reason", async () => {
    await recordRunStatusReason(db, "wrun_default", "First bookkeeping note");
    await recordRunStatusReason(db, "wrun_default", "Later bookkeeping note");
    expect((await row("wrun_default")).statusReason).toBe(
      "First bookkeeping note",
    );
  });

  it("leaves a successful run's empty reason empty", async () => {
    // A run that opened its PR and then had its released claim retired by the
    // reconciler is a green run with no reason of its own. Filling that null
    // with the retirement note makes the trace screen state a cancellation for
    // a run that succeeded.
    await recordRunUsage(db, usage({ status: "success" }));
    await recordRunStatusReason(
      db,
      "wrun_1",
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
    const r = await row("wrun_1");
    expect(r.status).toBe("success");
    expect(r.statusReason).toBeNull();
  });

  it("still fills a null reason on failed, blocked and awaiting rows", async () => {
    for (const status of ["failed", "blocked", "awaiting"] as const) {
      const runId = `wrun_reason_${status}`;
      await db.insert(workflowRuns).values({
        runId,
        subjectKey: "ticket:jira:PROJ-1",
        workflowId: "wf_agent",
        workflowName: "Agent",
        status,
      });
      await recordRunStatusReason(db, runId, "Cancelled via Slack /ai-workflow cancel");
      expect((await row(runId)).statusReason).toBe(
        "Cancelled via Slack /ai-workflow cancel",
      );
    }
  });
});

describe("markRunFailedOnSelfMove", () => {
  it("advances an in-flight 'running' row to 'failed'", async () => {
    await recordBlockStatuses(db, blockWrite()); // inserts status 'running'
    await markRunFailedOnSelfMove(db, "wrun_1");
    expect((await row("wrun_1")).status).toBe("failed");
  });

  it("never downgrades an already-frozen outcome", async () => {
    for (const frozen of ["success", "blocked", "awaiting"] as const) {
      const runId = `wrun_${frozen}`;
      await db.insert(workflowRuns).values({
        runId,
        subjectKey: "ticket:jira:PROJ-1",
        workflowId: "wf_agent",
        workflowName: "Agent",
        status: frozen,
      });
      await markRunFailedOnSelfMove(db, runId);
      expect((await row(runId)).status).toBe(frozen);
    }
  });

  it("marks a null-status (in-flight) row as failed", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_null",
      subjectKey: "ticket:jira:PROJ-2",
      workflowId: "wf_agent",
      workflowName: "Agent",
      // status omitted -> stored NULL; must be treated as in-flight, not skipped
    });
    await markRunFailedOnSelfMove(db, "wrun_null");
    expect((await row("wrun_null")).status).toBe("failed");
  });

  it("is a no-op for a missing run", async () => {
    await markRunFailedOnSelfMove(db, "wrun_missing");
    expect(await row("wrun_missing")).toBeUndefined();
  });
});

describe("markRunSucceededOnSelfMove", () => {
  it("advances an in-flight 'running' row to 'success'", async () => {
    await recordBlockStatuses(db, blockWrite()); // inserts status 'running'
    await markRunSucceededOnSelfMove(db, "wrun_1");
    expect((await row("wrun_1")).status).toBe("success");
  });

  it("never downgrades an already-frozen outcome", async () => {
    for (const frozen of ["failed", "blocked", "awaiting"] as const) {
      const runId = `wrun_s_${frozen}`;
      await db.insert(workflowRuns).values({
        runId,
        subjectKey: "ticket:jira:PROJ-1",
        workflowId: "wf_agent",
        workflowName: "Agent",
        status: frozen,
      });
      await markRunSucceededOnSelfMove(db, runId);
      expect((await row(runId)).status).toBe(frozen);
    }
  });

  it("marks a null-status (in-flight) row as success", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_s_null",
      subjectKey: "ticket:jira:PROJ-2",
      workflowId: "wf_agent",
      workflowName: "Agent",
      // status omitted -> stored NULL; must be treated as in-flight, not skipped
    });
    await markRunSucceededOnSelfMove(db, "wrun_s_null");
    expect((await row("wrun_s_null")).status).toBe("success");
  });

  it("is a no-op for a missing run", async () => {
    await markRunSucceededOnSelfMove(db, "wrun_s_missing");
    expect(await row("wrun_s_missing")).toBeUndefined();
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
    // Superseded, never answered: a predecessor is settled, not successful.
    expect((await row("wrun_old")).status).toBe("blocked");
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

/** The park marker of a run that is suspended on its hook, not finished. */
describe("live clarification park status", () => {
  const frozen = ["failed", "blocked", "success"] as const;

  async function seed(runId: string, status: string) {
    await db.insert(workflowRuns).values({
      runId,
      subjectKey: "ticket:jira:PROJ-1",
      workflowId: "wf_agent",
      workflowName: "Agent",
      ticketKey: "PROJ-1",
      status,
    });
  }

  it("markRunAwaiting parks an in-flight 'running' row", async () => {
    await recordBlockStatuses(db, blockWrite()); // inserts status 'running'
    await markRunAwaiting(db, "wrun_1");
    expect((await row("wrun_1")).status).toBe("awaiting");
  });

  it("markRunAwaiting never overwrites a frozen outcome", async () => {
    for (const status of frozen) {
      await seed(`wrun_park_${status}`, status);
      await markRunAwaiting(db, `wrun_park_${status}`);
      expect((await row(`wrun_park_${status}`)).status).toBe(status);
    }
  });

  it("parks a null-status (in-flight) row", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_park_null",
      subjectKey: "ticket:jira:PROJ-1",
      // status omitted -> stored NULL; must be treated as in-flight, not skipped
    });
    await markRunAwaiting(db, "wrun_park_null");
    expect((await row("wrun_park_null")).status).toBe("awaiting");
  });

  it("markRunAwaiting is a no-op for a missing run", async () => {
    await markRunAwaiting(db, "wrun_missing");
    expect(await row("wrun_missing")).toBeUndefined();
  });

  it("markRunResumed flips an awaiting row back to running", async () => {
    await seed("wrun_resume", "awaiting");
    await markRunResumed(db, "wrun_resume");
    expect((await row("wrun_resume")).status).toBe("running");
  });

  it("markRunResumed leaves every non-awaiting row alone", async () => {
    for (const status of [...frozen, "running"]) {
      await seed(`wrun_resume_${status}`, status);
      await markRunResumed(db, `wrun_resume_${status}`);
      expect((await row(`wrun_resume_${status}`)).status).toBe(status);
    }
    await markRunResumed(db, "wrun_missing");
    expect(await row("wrun_missing")).toBeUndefined();
  });

  it("markRunBlockedOnCancel flips an awaiting row to blocked", async () => {
    await seed("wrun_cancelled", "awaiting");
    await markRunBlockedOnCancel(db, "wrun_cancelled");
    expect((await row("wrun_cancelled")).status).toBe("blocked");
  });

  it("markRunBlockedOnCancel leaves every non-awaiting row alone", async () => {
    for (const status of [...frozen, "running"]) {
      await seed(`wrun_cancel_${status}`, status);
      await markRunBlockedOnCancel(db, `wrun_cancel_${status}`);
      expect((await row(`wrun_cancel_${status}`)).status).toBe(status);
    }
    await markRunBlockedOnCancel(db, "wrun_missing");
    expect(await row("wrun_missing")).toBeUndefined();
  });

  // A workflow step can be re-executed after a worker restart, so every writer
  // has to survive being called twice with the same argument.
  it("repeating any of the three writes changes nothing", async () => {
    await seed("wrun_twice", "running");
    await markRunAwaiting(db, "wrun_twice");
    await markRunAwaiting(db, "wrun_twice");
    expect((await row("wrun_twice")).status).toBe("awaiting");

    await markRunResumed(db, "wrun_twice");
    await markRunResumed(db, "wrun_twice");
    expect((await row("wrun_twice")).status).toBe("running");

    await markRunAwaiting(db, "wrun_twice");
    await markRunBlockedOnCancel(db, "wrun_twice");
    await markRunBlockedOnCancel(db, "wrun_twice");
    expect((await row("wrun_twice")).status).toBe("blocked");
  });
});

/** Operator cancel-by-id settle: wider guard than the park-only writer above. */
describe("markRunBlockedByOperator", () => {
  const terminal = ["failed", "blocked", "success"] as const;

  async function seed(runId: string, status: string, statusReason?: string) {
    await db.insert(workflowRuns).values({
      runId,
      subjectKey: "sched:demo:hourly",
      workflowId: "wf_agent",
      workflowName: "Agent",
      status,
      ...(statusReason !== undefined ? { statusReason } : {}),
    });
  }

  it("flips a running run to blocked and stamps the operator reason", async () => {
    await seed("wrun_op_running", "running");
    await markRunBlockedByOperator(db, "wrun_op_running", "cancelled by operator kate");
    const r = await row("wrun_op_running");
    expect(r.status).toBe("blocked");
    expect(r.statusReason).toBe("cancelled by operator kate");
  });

  it("settles a parked (awaiting) run the same way", async () => {
    await seed("wrun_op_awaiting", "awaiting");
    await markRunBlockedByOperator(db, "wrun_op_awaiting", "cancelled by operator kate");
    const r = await row("wrun_op_awaiting");
    expect(r.status).toBe("blocked");
    expect(r.statusReason).toBe("cancelled by operator kate");
  });

  // The F2 race: a run that reached its own terminal outcome between the
  // operator's click and this write must keep that outcome and its reason.
  it("never overwrites a run that already reached a terminal outcome", async () => {
    for (const status of terminal) {
      await seed(`wrun_op_${status}`, status, "prior reason");
      await markRunBlockedByOperator(db, `wrun_op_${status}`, "cancelled by operator kate");
      const r = await row(`wrun_op_${status}`);
      expect(r.status).toBe(status);
      expect(r.statusReason).toBe("prior reason");
    }
  });

  it("is a tolerant no-op for a missing run", async () => {
    await markRunBlockedByOperator(db, "wrun_op_missing", "cancelled by operator kate");
    expect(await row("wrun_op_missing")).toBeUndefined();
  });

  // A workflow step can be re-executed after a worker restart, so the write has
  // to survive being called twice: the second call sees 'blocked' and no-ops.
  it("is idempotent under re-execution", async () => {
    await seed("wrun_op_twice", "running");
    await markRunBlockedByOperator(db, "wrun_op_twice", "cancelled by operator kate");
    await markRunBlockedByOperator(db, "wrun_op_twice", "different reason");
    const r = await row("wrun_op_twice");
    expect(r.status).toBe("blocked");
    expect(r.statusReason).toBe("cancelled by operator kate");
  });
});

describe("sweepOrphanedAwaitingRuns", () => {
  async function parked(runId: string) {
    await db.insert(workflowRuns).values({
      runId,
      subjectKey: "ticket:jira:PROJ-1",
      workflowId: "wf_agent",
      workflowName: "Agent",
      ticketKey: "PROJ-1",
      status: "awaiting",
    });
  }

  async function question(runId: string, status: string) {
    await db.insert(clarificationRequests).values({
      id: `clar_${runId}_${status}`,
      ticketKey: "PROJ-1",
      subjectKey: "ticket:jira:PROJ-1",
      runId,
      questions: ["Which repository?"],
      status,
    });
  }

  async function approval(runId: string, status: string) {
    await db.insert(approvalRequests).values({
      id: `appr_${runId}_${status}`,
      ticketKey: "PROJ-1",
      definitionId: 1,
      runId,
      plan: { markdown: "# Plan" },
      status,
    });
  }

  it("leaves a healthy park alone", async () => {
    await parked("wrun_pending");
    await question("wrun_pending", "pending");
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(0);
    expect((await row("wrun_pending")).status).toBe("awaiting");
  });

  it("leaves an answered question alone: the lost resume is retryable", async () => {
    await parked("wrun_answered");
    await question("wrun_answered", "answered");
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(0);
    expect((await row("wrun_answered")).status).toBe("awaiting");
  });

  it("settles a run whose questions are all superseded", async () => {
    await parked("wrun_superseded");
    await question("wrun_superseded", "superseded");
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(1);
    expect((await row("wrun_superseded")).status).toBe("blocked");
  });

  it("settles a run with no continuation at all", async () => {
    await parked("wrun_orphan");
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(1);
    expect((await row("wrun_orphan")).status).toBe("blocked");
  });

  it("leaves a run waiting on a pending approval alone", async () => {
    await parked("wrun_approval");
    await approval("wrun_approval", "pending");
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(0);
    expect((await row("wrun_approval")).status).toBe("awaiting");
  });

  it("settles a run whose approval was already decided", async () => {
    await parked("wrun_decided");
    await approval("wrun_decided", "approved");
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(1);
    expect((await row("wrun_decided")).status).toBe("blocked");
  });

  it("never touches a row that is not awaiting", async () => {
    for (const status of ["running", "success", "failed", "blocked"]) {
      await db.insert(workflowRuns).values({
        runId: `wrun_sweep_${status}`,
        subjectKey: "ticket:jira:PROJ-1",
        status,
      });
    }
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(0);
    expect((await row("wrun_sweep_running")).status).toBe("running");
  });

  it("is idempotent across cron ticks", async () => {
    await parked("wrun_orphan");
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(1);
    expect(await sweepOrphanedAwaitingRuns(db)).toBe(0);
    expect((await row("wrun_orphan")).status).toBe("blocked");
  });
});
