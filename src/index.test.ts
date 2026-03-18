import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function WorkerMock() {
    return { close: vi.fn(), on: vi.fn() };
  }),
  Queue: class {
    add = vi.fn();
  },
}));

const mockCleanupOrphans = vi.fn().mockResolvedValue(undefined);
vi.mock("./sandbox/manager.js", () => ({
  cleanupOrphanContainers: (...args: unknown[]) => mockCleanupOrphans(...args),
  runSandbox: vi.fn(),
  pushBranchFromContainer: vi.fn(),
  teardownContainer: vi.fn(),
}));

const mockWorkerClose = vi.fn();
vi.mock("./worker.js", () => ({
  createWorker: vi.fn().mockReturnValue({
    close: mockWorkerClose,
    on: vi.fn(),
  }),
}));

vi.mock("./poller.js", () => ({
  runMaintenancePoll: vi.fn().mockResolvedValue(undefined),
}));

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
};
vi.mock("./db.js", () => ({
  db: new Proxy(mockDb, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));
vi.mock("postgres", () => ({ default: vi.fn() }));

describe("GET /health", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
    vi.stubEnv("PORT", "0");
  });

  it("returns status ok", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});

describe("POST /webhooks/jira", () => {
  const secret = "test-webhook-secret";

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("PORT", "0");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", secret);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "uuid-1" }]),
      }),
    });
  });

  function sign(body: string): string {
    return (
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function signedInject(app: any, payload: unknown) {
    const body = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": sign(body),
      },
      body,
    });
  }

  it("returns 200 for a valid status transition", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await signedInject(app, {
      user: { accountId: "abc", displayName: "Mia" },
      issue: { key: "PROJ-1" },
      changelog: {
        items: [
          {
            field: "status",
            fieldtype: "jira",
            fromString: "To Do",
            toString: "AI",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it("returns 200 for a non-status-change webhook", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await signedInject(app, {
      user: { accountId: "abc", displayName: "Mia" },
      issue: { key: "PROJ-1" },
      changelog: {
        items: [
          {
            field: "summary",
            fieldtype: "jira",
            fromString: "Old",
            toString: "New",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it("returns 200 for a malformed payload", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await signedInject(app, { garbage: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it("returns 401 with an invalid signature", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": "sha256=invalid",
      },
      body: JSON.stringify({ test: true }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid signature" });

    await app.close();
  });

  it("returns 401 when signature header is missing", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid signature" });

    await app.close();
  });
});

describe("startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
    vi.stubEnv("PORT", "0");
    vi.clearAllMocks();
    mockCleanupOrphans.mockResolvedValue(undefined);
  });

  it("runs orphan container cleanup before starting", async () => {
    const { main } = await import("./index.js");

    await main();

    expect(mockCleanupOrphans).toHaveBeenCalled();
  });
});
