import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { TicketJobData } from "./queue.js";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
const mockWorkerEventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function WorkerMock(
    _name: string,
    handler: (job: unknown) => Promise<void>,
    _opts?: unknown,
  ) {
    Object.keys(mockWorkerEventHandlers).forEach((k) => delete mockWorkerEventHandlers[k]);
    return {
      handler,
      close: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!mockWorkerEventHandlers[event]) mockWorkerEventHandlers[event] = [];
        mockWorkerEventHandlers[event].push(cb);
      }),
    };
  }),
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "ticket-uuid" }]),
        }),
        returning: vi.fn().mockResolvedValue([{ id: "run-uuid" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "ticket-uuid" }]),
      }),
    }),
  }),
}));
vi.mock("postgres", () => ({ default: vi.fn() }));

const mockReadFile = vi.fn().mockResolvedValue("You are an agent prompt content");
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

const mockRunSandbox = vi.fn();
const mockPushBranch = vi.fn();
const mockTeardownContainer = vi.fn();
vi.mock("./sandbox/manager.js", () => ({
  runSandbox: (...args: unknown[]) => mockRunSandbox(...args),
  pushBranchFromContainer: (...args: unknown[]) => mockPushBranch(...args),
  teardownContainer: (...args: unknown[]) => mockTeardownContainer(...args),
}));

const mockLogFn = vi.fn();
const mockChildLogger = { info: mockLogFn, warn: mockLogFn, error: mockLogFn, child: vi.fn() };
mockChildLogger.child.mockReturnValue(mockChildLogger);
vi.mock("./logger.js", () => ({
  createLogger: () => ({
    info: mockLogFn,
    warn: mockLogFn,
    error: mockLogFn,
    child: () => mockChildLogger,
  }),
  createTicketLogger: () => mockChildLogger,
  createRunLogger: () => mockChildLogger,
}));

const mockGitHub = {
  createBranch: vi.fn(),
  createPR: vi.fn().mockResolvedValue({
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
  }),
  getPRComments: vi.fn(),
  getPRConflictStatus: vi.fn(),
  getFileContent: vi.fn().mockResolvedValue("You are an agent. Use TDD."),
};
vi.mock("./adapters/github-client.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function (this: unknown) {
    return mockGitHub;
  }),
}));

const mockJira = {
  fetchTicket: vi.fn(),
  postComment: vi.fn(),
  moveTicket: vi.fn(),
  parseWebhook: vi.fn(),
};
vi.mock("./adapters/jira-client.js", () => ({
  JiraClient: vi.fn().mockImplementation(function (this: unknown) {
    return mockJira;
  }),
}));

const mockMessaging = {
  notify: vi.fn(),
  ping: vi.fn(),
};
vi.mock("./adapters/messaging-factory.js", () => ({
  createMessagingAdapter: vi.fn().mockReturnValue(mockMessaging),
}));

const defaultTicket = {
  externalId: "PROJ-42",
  identifier: "PROJ-42",
  title: "Add dark mode",
  description: "Implement dark mode across all pages",
  acceptanceCriteria: null,
  comments: [
    { author: "Alice", body: "Use CSS variables", createdAt: new Date("2026-03-10") },
  ],
  labels: ["frontend"],
  trackerStatus: "AI",
};

describe("worker handler", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("JIRA_BASE_URL", "https://team.atlassian.net");
    vi.stubEnv("JIRA_USER_EMAIL", "bot@team.com");
    vi.stubEnv("JIRA_API_TOKEN", "jira-token");
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("GITHUB_REPO_OWNER", "owner");
    vi.stubEnv("GITHUB_REPO_NAME", "repo");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue("You are an agent prompt content");
  });

  const makeJob = (data: TicketJobData): Job<TicketJobData> =>
    ({ data, name: data.type }) as Job<TicketJobData>;

  it("fetches ticket, creates branch, runs sandbox, creates PR on success", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Implemented dark mode",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockJira.fetchTicket).toHaveBeenCalledWith("PROJ-42");
    expect(mockGitHub.createBranch).toHaveBeenCalledWith(
      "owner", "repo", "blazebot/PROJ-42", "main",
    );
    expect(mockRunSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "blazebot/PROJ-42",
        requirementsMd: expect.stringContaining("## Ticket"),
      }),
    );
    expect(mockGitHub.createPR).toHaveBeenCalled();
    expect(mockJira.moveTicket).toHaveBeenCalledWith("PROJ-42", "AI Review");
  });

  it("sends notification after PR creation", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Implemented dark mode",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockMessaging.notify).toHaveBeenCalledWith(
      "Mia",
      expect.stringContaining("PR ready for review"),
    );
  });

  it("posts questions, moves to backlog, and notifies on clarification", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockRunSandbox.mockResolvedValue({
      exitCode: 2,
      status: "clarification_needed",
      questions: ["What color scheme?"],
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockJira.postComment).toHaveBeenCalledWith(
      "PROJ-42",
      expect.stringContaining("What color scheme?"),
    );
    expect(mockJira.moveTicket).toHaveBeenCalledWith("PROJ-42", "Backlog");
    expect(mockMessaging.notify).toHaveBeenCalledWith(
      "Mia",
      expect.stringContaining("needs clarification"),
    );
  });

  it("throws on failure so BullMQ retries", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockRunSandbox.mockResolvedValue({
      exitCode: 1,
      status: "failed",
      error: "Tests failed to compile",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await expect(
      handler(
        makeJob({
          type: "implementation",
          ticketId: "PROJ-42",
          source: "jira",
          triggeredBy: "Mia",
        }),
      ),
    ).rejects.toThrow();

    expect(mockGitHub.createPR).not.toHaveBeenCalled();
  });

  it("skips job when ticket is no longer in AI column (stale job protection)", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      ...defaultTicket,
      trackerStatus: "Done",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockRunSandbox).not.toHaveBeenCalled();
    expect(mockGitHub.createBranch).not.toHaveBeenCalled();
    expect(mockGitHub.createPR).not.toHaveBeenCalled();
  });

  it("includes Q&A comments in context when resuming after clarification", async () => {
    const ticketWithAnswers = {
      ...defaultTicket,
      comments: [
        { author: "Alice", body: "Use CSS variables", createdAt: new Date("2026-03-10") },
        { author: "Blazebot", body: "What color scheme should be used?", createdAt: new Date("2026-03-11") },
        { author: "Alice", body: "Use the Material Design dark palette", createdAt: new Date("2026-03-12") },
      ],
    };

    mockJira.fetchTicket.mockResolvedValue(ticketWithAnswers);
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Implemented with Material Design palette",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockRunSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementsMd: expect.stringContaining("What color scheme should be used?"),
      }),
    );
    expect(mockRunSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementsMd: expect.stringContaining("Use the Material Design dark palette"),
      }),
    );
  });

  it("calls createBranch on resume from clarification (adapter handles 422)", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockGitHub.createBranch.mockResolvedValue(undefined);
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Done after resume",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockGitHub.createBranch).toHaveBeenCalledWith(
      "owner", "repo", "blazebot/PROJ-42", "main",
    );
    expect(mockRunSandbox).toHaveBeenCalled();
    expect(mockGitHub.createPR).toHaveBeenCalled();
  });

  it("proceeds when ticket tracker status matches AI column", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket, trackerStatus: "AI" });
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Done",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockRunSandbox).toHaveBeenCalled();
  });

  it("uses createMessagingAdapter factory for notifications", async () => {
    const { createMessagingAdapter } = await import("./adapters/messaging-factory.js");

    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Done",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(createMessagingAdapter).toHaveBeenCalled();
    expect(mockMessaging.notify).toHaveBeenCalled();
  });

  describe("review_fix handler", () => {
    it("fetches ticket, PR comments, conflict status, runs sandbox, and moves to AI Review on success", async () => {
      mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
      mockGitHub.getPRComments.mockResolvedValue([
        { author: "bob", body: "Add tests", path: "src/index.ts", line: 10, fromApprovedReview: false },
      ]);
      mockGitHub.getPRConflictStatus.mockResolvedValue(false);
      mockRunSandbox.mockResolvedValue({
        exitCode: 0,
        status: "complete",
        summary: "Fixed review feedback",
        containerId: "container-xyz",
      });

      const { db } = await import("./db.js");
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: "ticket-uuid",
            prId: "42",
            branchName: "blazebot/PROJ-42",
          }]),
        }),
      } as ReturnType<typeof db.select>);

      const { createWorker } = await import("./worker.js");
      const worker = createWorker();
      const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

      await handler(
        makeJob({
          type: "review_fix",
          ticketId: "PROJ-42",
          source: "jira",
          triggeredBy: "Mia",
        }),
      );

      expect(mockJira.fetchTicket).toHaveBeenCalledWith("PROJ-42");
      expect(mockGitHub.getPRComments).toHaveBeenCalledWith("owner", "repo", 42);
      expect(mockGitHub.getPRConflictStatus).toHaveBeenCalledWith("owner", "repo", 42);
      expect(mockRunSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "blazebot/PROJ-42",
          requirementsMd: expect.stringContaining("## PR Review Feedback"),
        }),
      );
      expect(mockJira.moveTicket).toHaveBeenCalledWith("PROJ-42", "AI Review");
    });

    it("throws on failure so BullMQ retries (review_fix)", async () => {
      mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
      mockGitHub.getPRComments.mockResolvedValue([]);
      mockGitHub.getPRConflictStatus.mockResolvedValue(false);
      mockRunSandbox.mockResolvedValue({
        exitCode: 1,
        status: "failed",
        error: "Merge conflict unresolvable",
        containerId: "container-fail",
      });

      const { db } = await import("./db.js");
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: "ticket-uuid",
            prId: "42",
            branchName: "blazebot/PROJ-42",
          }]),
        }),
      } as ReturnType<typeof db.select>);

      const { createWorker } = await import("./worker.js");
      const worker = createWorker();
      const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

      await expect(
        handler(
          makeJob({
            type: "review_fix",
            ticketId: "PROJ-42",
            source: "jira",
            triggeredBy: "Mia",
          }),
        ),
      ).rejects.toThrow();

      expect(mockGitHub.createPR).not.toHaveBeenCalled();
    });

    it("skips review_fix when ticket is no longer in AI column", async () => {
      mockJira.fetchTicket.mockResolvedValue({
        ...defaultTicket,
        trackerStatus: "Done",
      });

      const { createWorker } = await import("./worker.js");
      const worker = createWorker();
      const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

      await handler(
        makeJob({
          type: "review_fix",
          ticketId: "PROJ-42",
          source: "jira",
          triggeredBy: "Mia",
        }),
      );

      expect(mockRunSandbox).not.toHaveBeenCalled();
    });

    it("sends notification after review fix completes", async () => {
      mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
      mockGitHub.getPRComments.mockResolvedValue([]);
      mockGitHub.getPRConflictStatus.mockResolvedValue(false);
      mockRunSandbox.mockResolvedValue({
        exitCode: 0,
        status: "complete",
        summary: "Fixed",
        containerId: "container-notif",
      });

      const { db } = await import("./db.js");
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: "ticket-uuid",
            prId: "42",
            branchName: "blazebot/PROJ-42",
          }]),
        }),
      } as ReturnType<typeof db.select>);

      const { createWorker } = await import("./worker.js");
      const worker = createWorker();
      const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

      await handler(
        makeJob({
          type: "review_fix",
          ticketId: "PROJ-42",
          source: "jira",
          triggeredBy: "Mia",
        }),
      );

      expect(mockMessaging.notify).toHaveBeenCalledWith(
        "Mia",
        expect.stringContaining("fixes applied"),
      );
    });
  });

  describe("prompt file error handling", () => {
    it("throws a clear error when implement.md is missing", async () => {
      mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
      mockReadFile.mockRejectedValueOnce(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      );

      const { createWorker } = await import("./worker.js");
      const worker = createWorker();
      const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

      await expect(
        handler(
          makeJob({
            type: "implementation",
            ticketId: "PROJ-42",
            source: "jira",
            triggeredBy: "Mia",
          }),
        ),
      ).rejects.toThrow(/Prompt file not found/);
    });

    it("throws a clear error when review-fix.md is missing", async () => {
      mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });

      const { db } = await import("./db.js");
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: "ticket-uuid",
            prId: "42",
            branchName: "blazebot/PROJ-42",
          }]),
        }),
      } as ReturnType<typeof db.select>);

      mockReadFile.mockRejectedValueOnce(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      );

      const { createWorker } = await import("./worker.js");
      const worker = createWorker();
      const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

      await expect(
        handler(
          makeJob({
            type: "review_fix",
            ticketId: "PROJ-42",
            source: "jira",
            triggeredBy: "Mia",
          }),
        ),
      ).rejects.toThrow(/Prompt file not found/);
    });
  });

  describe("failed event handler (retries exhausted)", () => {
    it("registers a 'failed' event listener", async () => {
      const { createWorker } = await import("./worker.js");
      createWorker();

      expect(mockWorkerEventHandlers["failed"]).toBeDefined();
      expect(mockWorkerEventHandlers["failed"].length).toBe(1);
    });

    it("transitions ticket to failed and notifies when retries are exhausted", async () => {
      const { createWorker } = await import("./worker.js");
      createWorker();

      const failedHandler = mockWorkerEventHandlers["failed"][0]!;
      const fakeJob = {
        data: { type: "implementation", ticketId: "PROJ-42", source: "jira", triggeredBy: "Mia" },
        attemptsMade: 4,
        opts: { attempts: 4 },
      };

      await failedHandler(fakeJob, new Error("Docker failed to start"));

      const { db } = await import("./db.js");
      expect(db.update).toHaveBeenCalled();
      expect(mockMessaging.notify).toHaveBeenCalledWith(
        "Mia",
        expect.stringContaining("failed permanently"),
      );
      expect(mockMessaging.notify).toHaveBeenCalledWith(
        "Mia",
        expect.stringContaining("4 attempts"),
      );
    });

    it("does not transition or notify when retries remain", async () => {
      const { createWorker } = await import("./worker.js");
      createWorker();

      const { db } = await import("./db.js");
      vi.mocked(db.update).mockClear();
      mockMessaging.notify.mockClear();

      const failedHandler = mockWorkerEventHandlers["failed"][0]!;
      const fakeJob = {
        data: { type: "implementation", ticketId: "PROJ-42", source: "jira", triggeredBy: "Mia" },
        attemptsMade: 1,
        opts: { attempts: 4 },
      };

      await failedHandler(fakeJob, new Error("Transient error"));

      expect(db.update).not.toHaveBeenCalled();
      expect(mockMessaging.notify).not.toHaveBeenCalled();
    });

    it("handles null job gracefully", async () => {
      const { createWorker } = await import("./worker.js");
      createWorker();

      const failedHandler = mockWorkerEventHandlers["failed"][0]!;
      await failedHandler(null, new Error("Unknown"));
    });
  });
});
