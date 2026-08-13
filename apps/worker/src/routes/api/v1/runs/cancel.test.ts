import {
  createApp,
  createError,
  createRouter,
  toWebHandler,
} from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CancelRunForOperatorResult } from "../../../../lib/cancel-run.js";
import type { Db } from "../../../../db/client.js";
import { workflowRuns } from "../../../../db/schema.js";
import { createTestDb } from "../../../../db/test-db.js";

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
  // When set, the wrapped cancelRunForOperator short-circuits to this outcome
  // instead of reading the real db. Used only for the live outcomes (cancelled,
  // unconfirmed) a pglite route test cannot reach; not_found and
  // already_terminal run through the real reverse lookup against the seeded db.
  cancelOverride: null as CancelRunForOperatorResult | null,
  // Exposed by the mock factory so tests can assert the wiring.
  cancelRunForOperator: undefined as unknown as ReturnType<typeof vi.fn>,
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
  const cancelRunForOperator = vi.fn(
    (db: Db, runId: string, opts: { actorLabel: string; runRegistry: unknown }) =>
      state.cancelOverride
        ? Promise.resolve(state.cancelOverride)
        : (actual.cancelRunForOperator as unknown as (
            db: Db,
            runId: string,
            opts: unknown,
          ) => Promise<CancelRunForOperatorResult>)(db, runId, opts),
  );
  state.cancelRunForOperator = cancelRunForOperator;
  return { ...actual, cancelRunForOperator };
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
    expect(state.cancelRunForOperator).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown run id (real reverse lookup)", async () => {
    const res = await cancel("wrun_unknown");
    expect(res.status).toBe(404);
    expect(state.cancelRunForOperator).toHaveBeenCalledWith(
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

  it("maps a confirmed cancel to 200 with the released subject", async () => {
    state.cancelOverride = {
      outcome: "cancelled",
      subjectKey: "schedule:sch_1",
      scheduleOccurrenceSettled: false,
    };
    const res = await cancel("wrun_sched");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "cancelled",
      runId: "wrun_sched",
      subjectKey: "schedule:sch_1",
    });
    // The schedule-ledger settle moved into cancelRunForOperator, so that a second
    // caller (the MCP tool) cannot skip it the way the production bug in AIW-240
    // skipped it. Its behaviour, including the warn on an unsettled occurrence and
    // the swallowed settle failure, is asserted in lib/cancel-run.test.ts. What
    // stays this route's business is the status and the body, and that a settle
    // result of any kind never changes either.
  });

  it("maps an unconfirmed live cancel to 409 with a typed retry body", async () => {
    state.cancelOverride = {
      outcome: "unconfirmed",
      subjectKey: "schedule:sch_3",
      // Nothing was torn down, so no ledger row was touched either.
      scheduleOccurrenceSettled: null,
    };
    const res = await cancel("wrun_unconfirmed");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      outcome: "unconfirmed",
      runId: "wrun_unconfirmed",
    });
  });
});
