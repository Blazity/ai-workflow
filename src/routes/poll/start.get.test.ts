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
    mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockRedis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce("OK");
    mockStart.mockResolvedValueOnce({ runId: "run_new" });

    const result = await handle({} as any);

    expect(result).toEqual({ status: "started", runId: "run_new" });
    expect(mockRedis.set).toHaveBeenCalledWith(
      "blazebot:poll-workflow",
      "run_new",
    );
    expect(mockRedis.del).toHaveBeenCalledWith("blazebot:poll-workflow:lock");
  });

  it("returns already_running when workflow is active", async () => {
    mockRedis.get.mockResolvedValueOnce("run_existing");
    mockGetRun.mockReturnValueOnce({ status: Promise.resolve("running") });

    const result = await handle({} as any);

    expect(result).toEqual({
      status: "already_running",
      runId: "run_existing",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts a new workflow when existing one is dead", async () => {
    mockRedis.get.mockResolvedValueOnce("run_dead").mockResolvedValueOnce(null);
    mockGetRun.mockReturnValueOnce({ status: Promise.resolve("completed") });
    mockRedis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce("OK");
    mockStart.mockResolvedValueOnce({ runId: "run_replacement" });

    const result = await handle({} as any);

    expect(result).toEqual({ status: "started", runId: "run_replacement" });
    expect(mockRedis.del).toHaveBeenCalledWith("blazebot:poll-workflow:lock");
  });

  it("starts a new workflow when getRun throws", async () => {
    mockRedis.get.mockResolvedValueOnce("run_gone").mockResolvedValueOnce(null);
    mockGetRun.mockImplementationOnce(() => {
      throw new Error("not found");
    });
    mockRedis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce("OK");
    mockStart.mockResolvedValueOnce({ runId: "run_fresh" });

    const result = await handle({} as any);

    expect(result).toEqual({ status: "started", runId: "run_fresh" });
    expect(mockRedis.del).toHaveBeenCalledWith("blazebot:poll-workflow:lock");
  });

  it("returns lock_contention when another start is in progress", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.set.mockResolvedValueOnce(null);

    const result = await handle({} as any);

    expect(result).toEqual({
      status: "lock_contention",
      message: "Another start request is in progress",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("rejects requests with wrong bearer token when CRON_SECRET is set", async () => {
    (env as any).CRON_SECRET = "real-secret";

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
      delete (env as any).CRON_SECRET;
    }
  });

  it("returns already_running when workflow is pending", async () => {
    mockRedis.get.mockResolvedValueOnce("run_pending");
    mockGetRun.mockReturnValueOnce({ status: Promise.resolve("pending") });

    const result = await handle({} as any);

    expect(result).toEqual({
      status: "already_running",
      runId: "run_pending",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns already_running after lock when another request started workflow", async () => {
    mockRedis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("run_raced");
    mockRedis.set.mockResolvedValueOnce("OK");
    mockGetRun.mockReturnValueOnce({ status: Promise.resolve("running") });

    const result = await handle({} as any);

    expect(result).toEqual({ status: "already_running", runId: "run_raced" });
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockRedis.del).toHaveBeenCalledWith("blazebot:poll-workflow:lock");
  });
});
