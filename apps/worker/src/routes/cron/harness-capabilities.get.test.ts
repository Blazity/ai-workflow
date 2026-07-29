import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prewarm: vi.fn(),
}));

vi.mock("../../../env.js", () => ({
  env: { CRON_SECRET: "cron-secret" },
}));
vi.mock("../../db/client.js", () => ({
  getDb: () => ({ db: true }),
}));
vi.mock("../../harness-profiles/capability-catalog.js", () => ({
  prewarmHarnessCapabilityCatalogs: (...args: unknown[]) =>
    mocks.prewarm(...args),
}));
vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn() },
}));

const handler = (await import("./harness-capabilities.get.js")).default;

function request(authorization?: string) {
  const app = createApp();
  app.use("/", handler);
  return toWebHandler(app)(
    new Request("http://worker.test/", {
      headers: authorization ? { authorization } : undefined,
    }),
  );
}

describe("capability prewarm cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prewarm.mockResolvedValue({
      organizations: 1,
      attempted: 2,
      ready: 2,
      stale: 0,
      failed: 0,
    });
  });

  it("requires cron auth and returns bounded refresh metrics", async () => {
    expect((await request()).status).toBe(401);

    const response = await request("Bearer cron-secret");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      organizations: 1,
      attempted: 2,
      ready: 2,
      stale: 0,
      failed: 0,
    });
    expect(mocks.prewarm).toHaveBeenCalledWith({ db: true });
  });
});
