import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));

const mockQueueAdd = vi.fn();
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
    on: vi.fn(),
  })),
  Queue: vi.fn().mockImplementation(function QueueMock() {
    return { add: mockQueueAdd };
  }),
}));

const mockDbInsertReturning = vi.fn().mockResolvedValue([{ id: "new-ticket-uuid" }]);
const mockDbUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockDbSelectWhere = vi.fn();

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: mockDbInsertReturning,
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: mockDbUpdateWhere,
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockDbSelectWhere,
      }),
    }),
  }),
}));
vi.mock("postgres", () => ({ default: vi.fn() }));

const mockLogFn = vi.fn();
vi.mock("./logger.js", () => ({
  createLogger: () => ({
    info: mockLogFn,
    warn: mockLogFn,
    error: mockLogFn,
  }),
}));

const mockSearchTickets = vi.fn();
vi.mock("./adapters/jira-client.js", () => ({
  JiraClient: vi.fn().mockImplementation(function JiraClientMock() {
    return { searchTickets: mockSearchTickets };
  }),
}));

const mockNotify = vi.fn();
vi.mock("./adapters/messaging-factory.js", () => ({
  createMessagingAdapter: vi.fn().mockReturnValue({ notify: mockNotify }),
}));

const mockTeardownContainer = vi.fn();
vi.mock("./sandbox/manager.js", () => ({
  teardownContainer: (...args: unknown[]) => mockTeardownContainer(...args),
}));

describe("runMaintenancePoll", () => {
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
    vi.stubEnv("JIRA_PROJECT_KEY", "PROJ");
    vi.clearAllMocks();
    mockDbSelectWhere.mockResolvedValue([]);
  });

  describe("missed webhook detection", () => {
    it("discovers tickets in AI column not in DB and enqueues them", async () => {
      mockSearchTickets.mockResolvedValue(["PROJ-10"]);
      mockDbSelectWhere.mockResolvedValue([]);

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockSearchTickets).toHaveBeenCalledWith(
        expect.stringContaining("PROJ"),
      );
      expect(mockDbInsertReturning).toHaveBeenCalled();
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "implementation",
        expect.objectContaining({
          type: "implementation",
          ticketId: "PROJ-10",
          triggeredBy: "poller",
        }),
        expect.objectContaining({
          jobId: expect.stringContaining("impl-PROJ-10"),
        }),
      );
    });

    it("re-enqueues tickets in failed state", async () => {
      mockSearchTickets.mockResolvedValue(["PROJ-20"]);
      mockDbSelectWhere.mockResolvedValue([{
        id: "ticket-uuid",
        externalId: "PROJ-20",
        workflowState: "failed",
        assignee: "Mia",
      }]);

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockDbUpdateWhere).toHaveBeenCalled();
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "implementation",
        expect.objectContaining({
          type: "implementation",
          ticketId: "PROJ-20",
          triggeredBy: "Mia",
        }),
        expect.objectContaining({
          jobId: expect.stringContaining("impl-PROJ-20"),
        }),
      );
    });

    it("skips tickets already queued or implementing", async () => {
      mockSearchTickets.mockResolvedValue(["PROJ-30"]);

      let selectCallCount = 0;
      mockDbSelectWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{
          id: "ticket-uuid",
          externalId: "PROJ-30",
          workflowState: "implementing",
          assignee: "Mia",
          updatedAt: new Date(),
        }]);
      });

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("skips when JIRA_PROJECT_KEY is not set", async () => {
      delete process.env.JIRA_PROJECT_KEY;

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockSearchTickets).not.toHaveBeenCalled();
    });

    it("handles Jira API errors gracefully", async () => {
      mockSearchTickets.mockRejectedValue(new Error("Jira API error: 503"));

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockLogFn).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Jira API error: 503" }),
        "poll_jira_error",
      );
    });

    it("does nothing when Jira returns no tickets", async () => {
      mockSearchTickets.mockResolvedValue([]);

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe("stuck job detection", () => {
    it("tears down container, marks timed_out, and re-enqueues stuck job", async () => {
      mockSearchTickets.mockResolvedValue([]);

      // First select: missed webhooks (no results)
      // Second select: stuck tickets query
      // Third select: runAttempts lookup
      // Fourth select: attempt count
      let selectCallCount = 0;
      mockDbSelectWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // stuck tickets query
          return Promise.resolve([{
            id: "ticket-uuid",
            externalId: "PROJ-40",
            workflowState: "implementing",
            currentRunId: "run-uuid",
            assignee: "Mia",
            updatedAt: new Date(Date.now() - 9999999),
          }]);
        }
        if (selectCallCount === 2) {
          // runAttempts lookup for container
          return Promise.resolve([{
            id: "run-uuid",
            containerId: "container-abc",
          }]);
        }
        if (selectCallCount === 3) {
          // attempt count (1 attempt, under limit)
          return Promise.resolve([{ id: "run-uuid" }]);
        }
        return Promise.resolve([]);
      });

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockTeardownContainer).toHaveBeenCalledWith("container-abc");
      expect(mockDbUpdateWhere).toHaveBeenCalled();
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "implementation",
        expect.objectContaining({
          type: "implementation",
          ticketId: "PROJ-40",
        }),
        expect.anything(),
      );
      expect(mockNotify).toHaveBeenCalledWith(
        "Mia",
        expect.stringContaining("re-enqueued"),
      );
    });

    it("transitions to failed when retry limit exhausted", async () => {
      mockSearchTickets.mockResolvedValue([]);

      let selectCallCount = 0;
      mockDbSelectWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve([{
            id: "ticket-uuid",
            externalId: "PROJ-50",
            workflowState: "implementing",
            currentRunId: "run-uuid",
            assignee: "Mia",
            updatedAt: new Date(Date.now() - 9999999),
          }]);
        }
        if (selectCallCount === 2) {
          // runAttempts lookup
          return Promise.resolve([{
            id: "run-uuid",
            containerId: null,
          }]);
        }
        if (selectCallCount === 3) {
          // 4 attempts (JOB_MAX_RETRIES default=3, so limit=4)
          return Promise.resolve([
            { id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" },
          ]);
        }
        return Promise.resolve([]);
      });

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledWith(
        "Mia",
        expect.stringContaining("retries exhausted"),
      );
    });

    it("re-enqueues review_fix for stuck fixing_feedback tickets", async () => {
      mockSearchTickets.mockResolvedValue([]);

      let selectCallCount = 0;
      mockDbSelectWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve([{
            id: "ticket-uuid",
            externalId: "PROJ-60",
            workflowState: "fixing_feedback",
            currentRunId: null,
            assignee: "Mia",
            updatedAt: new Date(Date.now() - 9999999),
          }]);
        }
        if (selectCallCount === 2) {
          // attempt count (under limit)
          return Promise.resolve([{ id: "r1" }]);
        }
        return Promise.resolve([]);
      });

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "review_fix",
        expect.objectContaining({
          type: "review_fix",
          ticketId: "PROJ-60",
        }),
        expect.anything(),
      );
    });

    it("continues recovery when container teardown fails", async () => {
      mockSearchTickets.mockResolvedValue([]);
      mockTeardownContainer.mockRejectedValue(new Error("container not found"));

      let selectCallCount = 0;
      mockDbSelectWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve([{
            id: "ticket-uuid",
            externalId: "PROJ-70",
            workflowState: "implementing",
            currentRunId: "run-uuid",
            assignee: "Mia",
            updatedAt: new Date(Date.now() - 9999999),
          }]);
        }
        if (selectCallCount === 2) {
          return Promise.resolve([{
            id: "run-uuid",
            containerId: "container-dead",
          }]);
        }
        if (selectCallCount === 3) {
          return Promise.resolve([{ id: "r1" }]);
        }
        return Promise.resolve([]);
      });

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockTeardownContainer).toHaveBeenCalledWith("container-dead");
      expect(mockDbUpdateWhere).toHaveBeenCalled();
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "implementation",
        expect.objectContaining({ ticketId: "PROJ-70" }),
        expect.anything(),
      );
      expect(mockNotify).toHaveBeenCalledWith(
        "Mia",
        expect.stringContaining("re-enqueued"),
      );
    });

    it("does nothing when no stuck tickets exist", async () => {
      mockSearchTickets.mockResolvedValue([]);
      mockDbSelectWhere.mockResolvedValue([]);

      const { runMaintenancePoll } = await import("./poller.js");
      await runMaintenancePoll();

      expect(mockTeardownContainer).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });
});
