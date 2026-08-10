import {
  createApp,
  createError,
  createRouter,
  toWebHandler,
} from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CancelRunByIdResult } from "../../../../lib/cancel-run.js";
import type { Db } from "../../../../db/client.js";
import { workflowRuns } from "../../../../db/schema.js";
import { createTestDb } from "../../../../db/test-db.js";

type SettleMode = "real" | "throw";

const state = vi.hoisted(() => ({
  actor: {
    organizationId: "org_aiw",
    organizationName: "AI Workflow",
    memberId: "member_1",
    userId: "user_1",
    role: "admin" as "owner" | "admin" | "member",
  } as {
    organizationId: string;
    organizationName: string;
    memberId: string;
    userId: string;
    role: "owner" | "admin" | "member";
  } | null,
  db: undefined as unknown,
  // When set, the wrapped cancelRunById short-circuits to this outcome instead
  // of reading the real db. Used only for the live outcomes (cancelled,
  // unconfirmed) a pglite route test cannot reach; not_found and
  // already_terminal run through the real reverse lookup against the seeded db.
  cancelOverride: null as CancelRunByIdResult | null,
  settleMode: "real" as SettleMode,
  // Exposed by the mock factories so tests can assert the wiring.
  cancelRunById: undefined as unknown as ReturnType<typeof vi.fn>,
  settle: undefined as unknown as ReturnType<typeof vi.fn>,
  warn: vi.fn(),
}));

// Static deps of the real cancel-run.ts import graph that do not load under
// vitest, mirroring cancel-run.test.ts. They are never invoked on the read-only
// not_found/already_terminal paths, so a bare stub is enough to load the module.
vi.mock("workflow/api", () => ({ getRun: vi.fn() }));
vi.mock("../../../../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: vi.fn(),
}));

vi.mock("../../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../../lib/auth/request-context.js", () => ({
  requireDashboardActor: vi.fn(async () => {
    if (!state.actor) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
    return state.actor;
  }),
  toHttpError: (error: unknown) => {
    throw error;
  },
}));
vi.mock("../../../../lib/adapters.js", () => ({
  createAdapters: () => ({ runRegistry: {} }),
}));
vi.mock("../../../../pre-pr-checks/store.js", () => ({
  dashboardUserLabel: vi.fn(async () => "Operator"),
}));
vi.mock("../../../../lib/logger.js", () => ({
  logger: { warn: state.warn, info: vi.fn(), error: vi.fn() },
}));

// Hybrid seams: delegate to the real implementation by default (so not_found and
// already_terminal are exercised end to end against pglite) and short-circuit
// only when a test sets an override for a live outcome.
vi.mock("../../../../lib/cancel-run.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../lib/cancel-run.js")>();
  const cancelRunById = vi.fn(
    (db: Db, runId: string, opts: { actorLabel: string; runRegistry: unknown }) =>
      state.cancelOverride
        ? Promise.resolve(state.cancelOverride)
        : (actual.cancelRunById as unknown as (
            db: Db,
            runId: string,
            opts: unknown,
          ) => Promise<CancelRunByIdResult>)(db, runId, opts),
  );
  state.cancelRunById = cancelRunById;
  return { ...actual, cancelRunById };
});
vi.mock("../../../../schedule-trigger/occurrence-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../schedule-trigger/occurrence-store.js")
    >();
  const settleScheduleOccurrenceOnCancel = vi.fn((db: Db, runId: string) =>
    state.settleMode === "throw"
      ? Promise.reject(new Error("settle boom"))
      : actual.settleScheduleOccurrenceOnCancel(db, runId),
  );
  state.settle = settleScheduleOccurrenceOnCancel;
  return { ...actual, settleScheduleOccurrenceOnCancel };
});

const cancelPost = (await import("./[runId]/cancel.post.js")).default;

let db: Db;

function handler() {
  const app = createApp();
  const router = createRouter();
  router.post("/runs/:runId/cancel", cancelPost);
  app.use(router);
  return toWebHandler(app);
}

function cancel(runId: string): Promise<Response> {
  return handler()(
    new Request(`http://worker.test/runs/${runId}/cancel`, { method: "POST" }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;
  state.actor = {
    organizationId: "org_aiw",
    organizationName: "AI Workflow",
    memberId: "member_1",
    userId: "user_1",
    role: "admin",
  };
  state.cancelOverride = null;
  state.settleMode = "real";
});

describe("POST /api/v1/runs/:runId/cancel", () => {
  it("rejects a member actor with 403 and never touches cancellation", async () => {
    state.actor = {
      organizationId: "org_aiw",
      organizationName: "AI Workflow",
      memberId: "member_1",
      userId: "user_1",
      role: "member",
    };
    const res = await cancel("wrun_live");
    expect(res.status).toBe(403);
    expect(state.cancelRunById).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown run id (real reverse lookup)", async () => {
    const res = await cancel("wrun_unknown");
    expect(res.status).toBe(404);
    expect(state.cancelRunById).toHaveBeenCalledWith(
      db,
      "wrun_unknown",
      expect.objectContaining({ actorLabel: "Operator" }),
    );
  });

  it("reports already_terminal with the recorded status (real workflow_runs fallback)", async () => {
    await db.insert(workflowRuns).values({ runId: "wrun_failed", status: "failed" });
    const res = await cancel("wrun_failed");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "already_terminal",
      runId: "wrun_failed",
      runStatus: "failed",
    });
  });

  it("does not render a lagging non-terminal status as a false success", async () => {
    // workflow_runs can lag the registry: a run that already left active_runs may
    // still read 'running'. The route must report that honestly, not as success.
    await db.insert(workflowRuns).values({ runId: "wrun_lag", status: "running" });
    const res = await cancel("wrun_lag");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "already_terminal",
      runId: "wrun_lag",
      runStatus: "running",
    });
  });

  it("maps a confirmed schedule cancel to 200 and warns when the occurrence is unsettled", async () => {
    state.cancelOverride = {
      outcome: "cancelled",
      subjectKey: "schedule:sch_1",
    };
    const res = await cancel("wrun_sched");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "cancelled",
      runId: "wrun_sched",
      subjectKey: "schedule:sch_1",
    });
    // Best-effort settle ran (no started occurrence -> false) and the schedule
    // subject miss was warn-logged so the bind-to-started window is observed.
    expect(state.settle).toHaveBeenCalledWith(db, "wrun_sched");
    expect(state.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "wrun_sched", subjectKey: "schedule:sch_1" }),
      "schedule_run_cancel_occurrence_unsettled",
    );
  });

  it("swallows a settle failure without changing the cancelled outcome", async () => {
    state.cancelOverride = {
      outcome: "cancelled",
      subjectKey: "schedule:sch_2",
    };
    state.settleMode = "throw";
    const res = await cancel("wrun_throw");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "cancelled",
      runId: "wrun_throw",
      subjectKey: "schedule:sch_2",
    });
    expect(state.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "wrun_throw" }),
      "schedule_run_cancel_occurrence_unsettled",
    );
  });

  it("does not warn for a non-schedule subject whose settle no-ops", async () => {
    state.cancelOverride = {
      outcome: "cancelled",
      subjectKey: "ticket:jira:PROJ-1",
    };
    const res = await cancel("wrun_ticket");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "cancelled",
      runId: "wrun_ticket",
      subjectKey: "ticket:jira:PROJ-1",
    });
    expect(state.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "schedule_run_cancel_occurrence_unsettled",
    );
  });

  it("maps an unconfirmed live cancel to 409 with a typed retry body", async () => {
    state.cancelOverride = {
      outcome: "unconfirmed",
      subjectKey: "schedule:sch_3",
    };
    const res = await cancel("wrun_unconfirmed");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      outcome: "unconfirmed",
      runId: "wrun_unconfirmed",
    });
  });
});
