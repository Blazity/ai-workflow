import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedis, mockStart, mockGetRun } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  mockStart: vi.fn(),
  mockGetRun: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => mockRedis),
}));

vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mockStart(...args),
  getRun: (...args: any[]) => mockGetRun(...args),
}));

vi.mock("../../workflows/poll.js", () => ({
  pollWorkflow: vi.fn(),
}));

vi.mock("../../../env.js", () => ({
  env: {
    AI_WORKFLOW_KV_REST_API_URL: "https://fake.upstash.io",
    AI_WORKFLOW_KV_REST_API_TOKEN: "fake-token",
  },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import handler from "./start.get.js";
import { env } from "../../../env.js";

const handle =
  typeof handler === "function" ? handler : (handler as any).handler;

describe("GET /poll/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a new workflow when none exists", async () => {
    mockRedis.set.mockResolvedValueOnce("OK");
    mockRedis.get.mockResolvedValueOnce(null);
    mockStart.mockResolvedValueOnce({ runId: "run_new" });
    mockRedis.set.mockResolvedValueOnce("OK");

    const result = await handle({} as any);

    expect(result).toEqual({
      status: "restarted",
      runId: "run_new",
      cancelledRunId: null,
    });
    expect(mockRedis.set).toHaveBeenCalledWith(
      "blazebot:poll-workflow",
      "run_new",
    );
    expect(mockRedis.del).toHaveBeenCalledWith("blazebot:poll-workflow:lock");
  });

  it("cancels existing workflow and starts a new one", async () => {
    mockRedis.set.mockResolvedValueOnce("OK");
    mockRedis.get.mockResolvedValueOnce("run_old");
    const mockCancel = vi.fn().mockResolvedValueOnce(undefined);
    mockGetRun.mockReturnValueOnce({ cancel: mockCancel });
    mockRedis.del.mockResolvedValueOnce(1);
    mockStart.mockResolvedValueOnce({ runId: "run_new" });
    mockRedis.set.mockResolvedValueOnce("OK");

    const result = await handle({} as any);

    expect(result).toEqual({
      status: "restarted",
      runId: "run_new",
      cancelledRunId: "run_old",
    });
    expect(mockCancel).toHaveBeenCalled();
  });

  it("starts new workflow even when cancel of existing throws", async () => {
    mockRedis.set.mockResolvedValueOnce("OK");
    mockRedis.get.mockResolvedValueOnce("run_gone");
    mockGetRun.mockImplementationOnce(() => {
      throw new Error("not found");
    });
    mockRedis.del.mockResolvedValueOnce(1);
    mockStart.mockResolvedValueOnce({ runId: "run_fresh" });
    mockRedis.set.mockResolvedValueOnce("OK");

    const result = await handle({} as any);

    expect(result).toEqual({
      status: "restarted",
      runId: "run_fresh",
      cancelledRunId: "run_gone",
    });
  });

  it("returns lock_contention when another start is in progress", async () => {
    mockRedis.set.mockResolvedValueOnce(null);

    const result = await handle({} as any);

    expect(result).toEqual({
      status: "lock_contention",
      message: "Another start request is in progress",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("rejects requests with wrong bearer token when DEPLOY_HOOK_SECRET is set", async () => {
    (env as any).DEPLOY_HOOK_SECRET = "real-secret";

    const mockEvent = {
      node: {
        req: {
          headers: {
            authorization: "Bearer wrong-secret",
          },
        },
      },
    };

    try {
      await expect(handle(mockEvent as any)).rejects.toMatchObject({
        statusCode: 401,
      });
    } finally {
      delete (env as any).DEPLOY_HOOK_SECRET;
    }
  });
});
