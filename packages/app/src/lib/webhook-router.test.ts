import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedEvent } from "@blazebot/shared";

const mockStart = vi.fn();
vi.mock("workflow/api", () => ({
  start: (...args: unknown[]) => mockStart(...args),
}));

const mockTeardownContainer = vi.fn();
vi.mock("../sandbox/manager.js", () => ({
  teardownContainer: (...args: unknown[]) => mockTeardownContainer(...args),
}));

vi.mock("../workflows/implementation.js", () => ({
  implementTicket: { name: "implementTicket" },
}));

vi.mock("../workflows/review-fix.js", () => ({
  reviewFixTicket: { name: "reviewFixTicket" },
}));

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
};

vi.mock("@blazebot/shared", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
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
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    }),
  };
});

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return { ...actual, eq: vi.fn(), and: vi.fn() };
});

describe("routeTicketTransition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  const makeEvent = (from: string, to: string): NormalizedEvent => ({
    type: "ticket_moved",
    ticketId: "PROJ-42",
    fromColumn: from,
    toColumn: to,
    triggeredBy: "Mia",
    triggeredByAccountId: "user-abc123",
  });

  it("creates ticket record and starts implementation workflow for new ticket moved to AI", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

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

    await routeTicketTransition(makeEvent("To Do", "AI"));

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "implementTicket" }),
      ["PROJ-42", "jira", "Mia"],
      expect.objectContaining({ id: expect.stringContaining("PROJ-42") }),
    );
  });

  it("ignores duplicate webhook when concurrent insert loses the race", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "uuid-1", workflowState: "queued" },
          ]),
        }),
      });

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await routeTicketTransition(makeEvent("To Do", "AI"));

    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts implementation workflow when ticket in clarification_pending moves to AI", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
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

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "implementTicket" }),
      expect.arrayContaining(["PROJ-42"]),
      expect.any(Object),
    );
  });

  it("starts review_fix workflow when ticket in awaiting_review moves to AI", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
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

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "reviewFixTicket" }),
      expect.arrayContaining(["PROJ-42"]),
      expect.any(Object),
    );
  });

  it("does not start workflow for transitions not involving AI columns", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

    await routeTicketTransition(makeEvent("To Do", "In Progress"));

    expect(mockStart).not.toHaveBeenCalled();
  });

  it("matches column names case-insensitively", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

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

    await routeTicketTransition(makeEvent("To Do", "ai"));

    expect(mockStart).toHaveBeenCalled();
  });

  it("marks ticket as failed when moved out of AI column", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { id: "uuid-1", workflowState: "implementing", currentRunId: null },
          ]),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await routeTicketTransition(makeEvent("AI", "Cancelled"));

    expect(mockDb.update).toHaveBeenCalled();
  });

  it("calls teardownContainer directly when ticket with active container moves out of AI", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              {
                id: "uuid-1",
                workflowState: "implementing",
                currentRunId: "run-uuid-1",
              },
            ]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "run-uuid-1", containerId: "docker-container-xyz" },
            ]),
        }),
      });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await routeTicketTransition(makeEvent("AI", "Done"));

    expect(mockTeardownContainer).toHaveBeenCalledWith("docker-container-xyz");
  });

  it("carries triggeredBy through when resuming from clarification_pending", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { id: "uuid-1", workflowState: "clarification_pending" },
          ]),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await routeTicketTransition({
      type: "ticket_moved",
      ticketId: "PROJ-42",
      fromColumn: "Backlog",
      toColumn: "AI",
      triggeredBy: "Bob",
      triggeredByAccountId: "user-bob-456",
    });

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "implementTicket" }),
      ["PROJ-42", "jira", "Bob"],
      expect.any(Object),
    );
  });

  it("does nothing when ticket moved out of AI but no DB record exists", async () => {
    const { routeTicketTransition } = await import("./webhook-router.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await routeTicketTransition(makeEvent("AI", "Done"));

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
