import {
  createApp,
  createError,
  createRouter,
  toWebHandler,
} from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowReplayAttemptDetail,
  WorkflowRunReplayResponse,
} from "@shared/contracts";

const state = vi.hoisted(() => ({
  actor: {
    organizationId: "org_aiw",
    organizationName: "AI Workflow",
    memberId: "member_1",
    userId: "user_1",
    role: "member" as const,
  } as {
    organizationId: string;
    organizationName: string;
    memberId: string;
    userId: string;
    role: "member";
  } | null,
  getRunReplay: vi.fn(),
  getRunReplayAttempt: vi.fn(),
}));

vi.mock("../../../../db/client.js", () => ({ getDb: () => ({}) }));
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
vi.mock("../../../../run-observability/store.js", () => ({
  RunObservationStoreError: class RunObservationStoreError extends Error {
    constructor(
      readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  },
  getRunReplay: state.getRunReplay,
  getRunReplayAttempt: state.getRunReplayAttempt,
}));

const { RunObservationStoreError } = await import(
  "../../../../run-observability/store.js"
);
const replayGet = (await import("./[runId]/replay.get.js")).default;
const attemptGet = (
  await import("./[runId]/attempts/[attemptId].get.js")
).default;

function handler() {
  const app = createApp();
  const router = createRouter();
  router.get("/runs/:runId/replay", replayGet);
  router.get("/runs/:runId/attempts/:attemptId", attemptGet);
  app.use(router);
  return toWebHandler(app);
}

const NOT_CAPTURED: WorkflowRunReplayResponse = {
  availability: "not_captured",
  mayAdvance: false,
  snapshot: null,
  attempts: [],
  nextCursor: null,
};

const ATTEMPT: WorkflowReplayAttemptDetail = {
  id: 42,
  nodeId: "review",
  attempt: 2,
  activationScopeId: "scope-1",
  state: "completed",
  outcome: { kind: "completed", status: "approve" },
  selectedTransition: { port: "out", edgeIds: ["edge-2"] },
  startedAt: "2026-07-23T10:00:00.000Z",
  completedAt: "2026-07-23T10:00:01.000Z",
  durationMs: 1000,
  diagnosticId: null,
  input: null,
  output: null,
  logs: null,
  metadata: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.actor = {
    organizationId: "org_aiw",
    organizationName: "AI Workflow",
    memberId: "member_1",
    userId: "user_1",
    role: "member",
  };
  state.getRunReplay.mockResolvedValue(NOT_CAPTURED);
  state.getRunReplayAttempt.mockResolvedValue(ATTEMPT);
});

describe("run replay API", () => {
  it("is authenticated and private no-store", async () => {
    state.actor = null;
    const response = await handler()(
      new Request("http://worker.test/runs/wrun_1/replay"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.getRunReplay).not.toHaveBeenCalled();
  });

  it("scopes replay pagination to the authenticated organization", async () => {
    const response = await handler()(
      new Request(
        "http://worker.test/runs/wrun_1/replay?limit=500&cursor=older%2F42",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(NOT_CAPTURED);
    expect(state.getRunReplay).toHaveBeenCalledWith({
      db: {},
      organizationId: "org_aiw",
      runId: "wrun_1",
      limit: 200,
      cursor: "older/42",
    });
  });

  it("rejects invalid run identifiers before querying observations", async () => {
    const response = await handler()(
      new Request("http://worker.test/runs/not%2Fsafe/replay"),
    );

    expect(response.status).toBe(404);
    expect(state.getRunReplay).not.toHaveBeenCalled();
  });

  it("returns typed pagination errors as safe client errors", async () => {
    state.getRunReplay.mockRejectedValue(
      new RunObservationStoreError(400, "Invalid replay cursor"),
    );
    const response = await handler()(
      new Request(
        "http://worker.test/runs/wrun_1/replay?cursor=not-a-cursor",
      ),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.stack).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("RunObservationStoreError");
  });

  it("returns a lazy attempt detail in the same organization scope", async () => {
    const response = await handler()(
      new Request("http://worker.test/runs/wrun_1/attempts/42"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(ATTEMPT);
    expect(state.getRunReplayAttempt).toHaveBeenCalledWith({
      db: {},
      organizationId: "org_aiw",
      runId: "wrun_1",
      attemptId: 42,
    });
  });

  it("uses the same 404 for missing, expired, and cross-organization attempts", async () => {
    state.getRunReplayAttempt.mockResolvedValue(null);
    const response = await handler()(
      new Request("http://worker.test/runs/wrun_1/attempts/42"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("organizationId");
  });

  it.each(["0", "-1", "abc", "2147483648", "9007199254740992"])(
    "rejects invalid attempt id %s",
    async (attemptId) => {
      const response = await handler()(
        new Request(
          `http://worker.test/runs/wrun_1/attempts/${attemptId}`,
        ),
      );
      expect(response.status).toBe(404);
      expect(state.getRunReplayAttempt).not.toHaveBeenCalled();
    },
  );
});
