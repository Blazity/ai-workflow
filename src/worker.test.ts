import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { TicketJobData } from "./queue.js";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function WorkerMock(
    _name: string,
    handler: (job: unknown) => Promise<void>,
    _opts?: unknown,
  ) {
    return { handler, close: vi.fn() };
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

const mockRunSandbox = vi.fn();
vi.mock("./sandbox/manager.js", () => ({
  runSandbox: (...args: unknown[]) => mockRunSandbox(...args),
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
  });

  const makeJob = (data: TicketJobData): Job<TicketJobData> =>
    ({ data, name: data.type }) as Job<TicketJobData>;

  it("fetches ticket, creates branch, runs sandbox, creates PR on exit 0", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      externalId: "PROJ-42",
      identifier: "PROJ-42",
      title: "Add dark mode",
      description: "Implement dark mode across all pages",
      acceptanceCriteria: null,
      comments: [
        { author: "Alice", body: "Use CSS variables", createdAt: new Date("2026-03-10") },
      ],
      labels: ["frontend"],
    });
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
    expect(mockGitHub.getFileContent).toHaveBeenCalledWith(
      "owner", "repo", ".blazebot/implement.md", "main",
    );
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

  it("posts questions and moves to backlog on exit 2", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      externalId: "PROJ-42",
      identifier: "PROJ-42",
      title: "Add dark mode",
      description: "Implement dark mode",
      acceptanceCriteria: null,
      comments: [],
      labels: [],
    });
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
  });

  it("throws on exit 1 so BullMQ retries", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      externalId: "PROJ-42",
      identifier: "PROJ-42",
      title: "Add dark mode",
      description: "Implement dark mode",
      acceptanceCriteria: null,
      comments: [],
      labels: [],
    });
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

  it("fails immediately when .blazebot/implement.md is missing", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      externalId: "PROJ-42",
      identifier: "PROJ-42",
      title: "T",
      description: "D",
      acceptanceCriteria: null,
      comments: [],
      labels: [],
    });
    mockGitHub.getFileContent.mockResolvedValue(null);

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
    ).rejects.toThrow(".blazebot/implement.md");

    expect(mockRunSandbox).not.toHaveBeenCalled();
  });
});
