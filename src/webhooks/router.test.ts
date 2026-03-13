import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedEvent } from "./types.js";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn();
  },
}));

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
};
vi.mock("../db.js", () => ({
  db: new Proxy(mockDb, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return { ...actual, eq: vi.fn(), and: vi.fn() };
});

describe("routeTicketTransition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
  });

  const makeEvent = (from: string, to: string): NormalizedEvent => ({
    type: "ticket_moved",
    ticketId: "PROJ-42",
    fromColumn: from,
    toColumn: to,
    triggeredBy: "Mia",
  });

  it("creates ticket record and enqueues implementation job for new ticket moved to AI", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

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

    await routeTicketTransition(makeEvent("To Do", "AI"));

    expect(ticketQueue.add).toHaveBeenCalledWith(
      "implementation",
      expect.objectContaining({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
      expect.objectContaining({ jobId: expect.stringContaining("PROJ-42") }),
    );
  });

  it("enqueues implementation job when ticket in clarification_pending moves to AI", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: "uuid-1", workflowState: "clarification_pending" },
        ]),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await routeTicketTransition(makeEvent("Backlog", "AI"));

    expect(ticketQueue.add).toHaveBeenCalledWith(
      "implementation",
      expect.objectContaining({ type: "implementation" }),
      expect.any(Object),
    );
  });

  it("enqueues review_fix job when ticket in awaiting_review moves to AI", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: "uuid-1", workflowState: "awaiting_review" },
        ]),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await routeTicketTransition(makeEvent("AI Review", "AI"));

    expect(ticketQueue.add).toHaveBeenCalledWith(
      "review_fix",
      expect.objectContaining({ type: "review_fix" }),
      expect.any(Object),
    );
  });

  it("does not enqueue for transitions not targeting AI column", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    await routeTicketTransition(makeEvent("To Do", "In Progress"));

    expect(ticketQueue.add).not.toHaveBeenCalled();
  });

  it("matches column names case-insensitively", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

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

    await routeTicketTransition(makeEvent("To Do", "ai"));

    expect(ticketQueue.add).toHaveBeenCalled();
  });
});
