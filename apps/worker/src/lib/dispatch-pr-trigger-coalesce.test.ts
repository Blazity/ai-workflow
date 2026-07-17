import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunKind, RunRegistryAdapter } from "../adapters/run-registry/types.js";

// Regression for docs/testing/e2e-findings.md §7b: only the first PR trigger per
// ticket dispatched; every later pr_trigger for the same ticket coalesced.
//
// Confirmed root cause (not verify_claim_after_start, which passes on a clean
// registry): a run that completes WITHOUT traversing a block that unregisters
// (open_pr / finalize_workspace / send_plan_approval / terminate / clarification
// / failure) leaves its active_runs row registered, so the ticket's NEXT
// pr_trigger aborts at claim() (ON CONFLICT DO NOTHING → false) → already_claimed
// → coalesced. agentWorkflow's outer finally now releases the slot on every
// terminal exit, scoped to the run's own workflowRunId (unregisterIfRunId), so a
// finishing run can free its slot without stomping a successor run that reclaimed
// the ticket after a mid-run unregisterBeforePr.

vi.mock("../../env.js", () => ({ env: { JIRA_PROJECT_KEY: "AWT", COLUMN_AI: "AI" } }));
const mockStart = vi.fn();
const mockGetRun = vi.fn();
vi.mock("workflow/api", () => ({
  start: (...a: any[]) => mockStart(...a),
  getRun: (...a: any[]) => mockGetRun(...a),
}));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopTicketSandboxes: vi.fn().mockResolvedValue(0),
}));

/** Faithful in-memory model of PostgresRunRegistry: exactly one row per ticketKey. */
function faithfulRegistry(): RunRegistryAdapter & {
  rows: Map<string, { runId: string; kind: RunKind }>;
} {
  const rows = new Map<string, { runId: string; kind: RunKind }>();
  return {
    rows,
    // INSERT ... ON CONFLICT DO NOTHING
    async claim(ticketKey: string, runId: string, kind: RunKind = "ticket") {
      if (rows.has(ticketKey)) return false;
      rows.set(ticketKey, { runId, kind });
      return true;
    },
    async register(ticketKey: string, runId: string, kind: RunKind = "ticket") {
      rows.set(ticketKey, { runId, kind });
    },
    async getRunId(ticketKey: string) {
      return rows.get(ticketKey)?.runId ?? null;
    },
    // Unconditional delete by ticketKey (DELETE ... WHERE ticketKey = ?).
    async unregister(ticketKey: string) {
      rows.delete(ticketKey);
    },
    // Compare-and-delete (DELETE ... WHERE ticketKey = ? AND runId = ?).
    async unregisterIfRunId(ticketKey: string, runId: string) {
      if (rows.get(ticketKey)?.runId === runId) rows.delete(ticketKey);
    },
    async listAll() {
      return [...rows.entries()].map(([ticketKey, v]) => ({
        ticketKey,
        runId: v.runId,
        kind: v.kind,
      }));
    },
    registerSandbox: vi.fn().mockResolvedValue(undefined),
    getSandboxId: vi.fn().mockResolvedValue(null),
    getEntryCreatedAt: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn().mockResolvedValue(undefined),
    isTicketFailed: vi.fn().mockResolvedValue(false),
    listAllFailed: vi.fn().mockResolvedValue([]),
    clearFailedMark: vi.fn().mockResolvedValue(undefined),
  } as any;
}

async function dispatchPrTrigger(
  reg: RunRegistryAdapter,
  ticketKey: string,
  runId: string,
) {
  const { claimTicketRun } = await import("./dispatch.js");
  return claimTicketRun(ticketKey, reg, 3, {
    kind: "pr_trigger",
    startWorkflow: async () => runId,
  });
}

describe("pr_trigger sequential dispatch (§7b coalesce)", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockGetRun.mockReset();
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
  });

  it("the bug: a lingering row from the prior run coalesces the second pr_trigger at claim()", async () => {
    const reg = faithfulRegistry();

    const first = await dispatchPrTrigger(reg, "AWT-1017", "run1");
    expect(first).toEqual({ started: true, runId: "run1" });
    expect(reg.rows.get("AWT-1017")).toEqual({ runId: "run1", kind: "pr_trigger" });

    // First run completes but leaves its row (a graph without open_pr /
    // finalize_workspace / terminate never unregistered). Registry is NOT empty.
    const second = await dispatchPrTrigger(reg, "AWT-1017", "run2");

    // Aborts at claim(), not at verify_claim_after_start.
    expect(second).toEqual({ started: false, reason: "already_claimed" });
    expect(reg.rows.get("AWT-1017")).toEqual({ runId: "run1", kind: "pr_trigger" });
  });

  it("the fix: once the prior run releases its own slot on completion, the second (and third) pr_trigger dispatch", async () => {
    const reg = faithfulRegistry();

    const first = await dispatchPrTrigger(reg, "AWT-1017", "run1");
    expect(first.started).toBe(true);

    // agentWorkflow's outer finally releases its OWN slot (unregisterIfRunId).
    await reg.unregisterIfRunId("AWT-1017", "run1");
    expect(reg.rows.has("AWT-1017")).toBe(false);

    const second = await dispatchPrTrigger(reg, "AWT-1017", "run2");
    expect(second).toEqual({ started: true, runId: "run2" });
    expect(reg.rows.get("AWT-1017")).toEqual({ runId: "run2", kind: "pr_trigger" });

    // A third one over the same PR's lifetime works too (checks-failed → review).
    await reg.unregisterIfRunId("AWT-1017", "run2");
    const third = await dispatchPrTrigger(reg, "AWT-1017", "run3");
    expect(third).toEqual({ started: true, runId: "run3" });
  });

  it("verify_claim_after_start passes on a clean registry (disproves the suspected cause)", async () => {
    const reg = faithfulRegistry();
    const getRunIdSpy = vi.spyOn(reg, "getRunId");

    const result = await dispatchPrTrigger(reg, "AWT-2000", "runX");

    // The post-start re-read saw the claim sentinel, so the run was NOT aborted.
    expect(result).toEqual({ started: true, runId: "runX" });
    expect(getRunIdSpy).toHaveBeenCalledWith("AWT-2000");
  });

  it("a genuinely concurrent second run for the same ticket still coalesces (one run per ticket preserved)", async () => {
    const reg = faithfulRegistry();

    const first = await dispatchPrTrigger(reg, "AWT-3000", "runA");
    expect(first.started).toBe(true);

    // Prior run is still live (row present): a second dispatch must coalesce.
    const concurrent = await dispatchPrTrigger(reg, "AWT-3000", "runB");
    expect(concurrent).toEqual({ started: false, reason: "already_claimed" });
  });
});

describe("runId-scoped release (successor-stomp guard)", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockGetRun.mockReset();
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
  });

  it("the original run's teardown must NOT delete a successor run's live row", async () => {
    const reg = faithfulRegistry();

    // 1. Original pr_trigger run is dispatched and registered.
    const original = await dispatchPrTrigger(reg, "AWT-1017", "run1");
    expect(original).toEqual({ started: true, runId: "run1" });

    // 2. Original run reaches open_pr/finalize → ctx.unregisterBeforePr() clears
    //    the row mid-run (before creating the PR); it never re-registers.
    await reg.unregister("AWT-1017");
    expect(reg.rows.has("AWT-1017")).toBe(false);

    // 3. Creating that PR fires trigger_pr_created → a successor pr_trigger run
    //    is dispatched for the SAME ticket and claims the now-empty slot.
    const successor = await dispatchPrTrigger(reg, "AWT-1017", "run2");
    expect(successor).toEqual({ started: true, runId: "run2" });
    expect(reg.rows.get("AWT-1017")).toEqual({ runId: "run2", kind: "pr_trigger" });

    // 4. The ORIGINAL run finally reaches its outer finally and releases scoped
    //    to its own id. A bare unregister here would stomp run2; the runId-scoped
    //    release is a no-op because the row now holds run2, not run1.
    await reg.unregisterIfRunId("AWT-1017", "run1");
    expect(reg.rows.get("AWT-1017")).toEqual({ runId: "run2", kind: "pr_trigger" });

    // 5. The successor is still protected: a later same-ticket trigger coalesces
    //    instead of starting a concurrent duplicate run.
    const concurrent = await dispatchPrTrigger(reg, "AWT-1017", "run3");
    expect(concurrent).toEqual({ started: false, reason: "already_claimed" });
  });

  it("a run DOES release its own row when it still owns it, unblocking a later trigger", async () => {
    const reg = faithfulRegistry();

    const run = await dispatchPrTrigger(reg, "AWT-4000", "run1");
    expect(run.started).toBe(true);
    expect(reg.rows.get("AWT-4000")).toEqual({ runId: "run1", kind: "pr_trigger" });

    // Completed while still owning the row → the scoped release deletes it.
    await reg.unregisterIfRunId("AWT-4000", "run1");
    expect(reg.rows.has("AWT-4000")).toBe(false);

    const next = await dispatchPrTrigger(reg, "AWT-4000", "run2");
    expect(next).toEqual({ started: true, runId: "run2" });
  });
});
