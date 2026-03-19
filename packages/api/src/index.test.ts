import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn();
    getJob = vi.fn();
  },
}));

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
};

function parseJiraWebhookImpl(body: unknown) {
  if (
    body &&
    typeof body === "object" &&
    "changelog" in body &&
    "issue" in body &&
    "user" in body
  ) {
    const b = body as {
      user: { displayName: string; accountId: string };
      issue: { key: string };
      changelog: {
        items: { field: string; fromString: string; toString: string }[];
      };
    };
    const statusChange = b.changelog.items.find(
      (item) => item.field === "status",
    );
    if (!statusChange) return null;
    return {
      type: "ticket_moved" as const,
      ticketId: b.issue.key,
      fromColumn: statusChange.fromString ?? "",
      toColumn: statusChange.toString,
      triggeredBy: b.user.displayName,
      triggeredByAccountId: b.user.accountId,
    };
  }
  return null;
}

vi.mock("@blazebot/shared", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  env: {
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    REDIS_URL: "redis://localhost:6379",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    JIRA_PROJECT_KEY: "PROJ",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
    JOB_MAX_RETRIES: 3,
    JOB_BACKOFF_MS: 1000,
    POLL_INTERVAL_MS: 60000,
  },
  db: new Proxy(mockDb, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
  tickets: {
    externalId: "externalId",
    source: "source",
    id: "id",
  },
  runAttempts: {
    id: "id",
  },
  ticketQueue: {
    add: vi.fn(),
    getJob: vi.fn(),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
  parseJiraWebhook: vi
    .fn()
    .mockImplementation((body: unknown) => parseJiraWebhookImpl(body)),
}));

vi.mock("./env.js", () => ({
  apiEnv: {
    PORT: 0,
    JIRA_WEBHOOK_SECRET: "test-webhook-secret",
  },
}));

describe("GET /health", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
    vi.clearAllMocks();
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "uuid-1" }]),
        }),
      }),
    });
  });

  function sign(body: string): string {
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
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
