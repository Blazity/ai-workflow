import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
};

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => mockRedis),
}));

const mockStart = vi.fn();
const mockGetRun = vi.fn();

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

const handle =
  typeof handler === "function" ? handler : (handler as any).handler;

describe("GET /poll/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a new workflow when none exists", async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockStart.mockResolvedValueOnce({ runId: "run_new" });

    const result = await handle({} as any);

    expect(result).toEqual({ status: "started", runId: "run_new" });
    expect(mockRedis.set).toHaveBeenCalledWith("blazebot:poll-workflow", "run_new");
  });

  it("returns already_running when workflow is active", async () => {
    mockRedis.get.mockResolvedValueOnce("run_existing");
    mockGetRun.mockReturnValueOnce({ status: Promise.resolve("running") });

    const result = await handle({} as any);

    expect(result).toEqual({ status: "already_running", runId: "run_existing" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts a new workflow when existing one is dead", async () => {
    mockRedis.get.mockResolvedValueOnce("run_dead");
    mockGetRun.mockReturnValueOnce({ status: Promise.resolve("completed") });
    mockStart.mockResolvedValueOnce({ runId: "run_replacement" });

    const result = await handle({} as any);

    expect(result).toEqual({ status: "started", runId: "run_replacement" });
  });

  it("starts a new workflow when getRun throws", async () => {
    mockRedis.get.mockResolvedValueOnce("run_gone");
    mockGetRun.mockImplementationOnce(() => { throw new Error("not found"); });
    mockStart.mockResolvedValueOnce({ runId: "run_fresh" });

    const result = await handle({} as any);

    expect(result).toEqual({ status: "started", runId: "run_fresh" });
  });
});
