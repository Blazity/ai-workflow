import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    MAX_CONCURRENT_AGENTS: 3,
    JIRA_WEBHOOK_SECRET: undefined as string | undefined,
  },
  createAdapters: vi.fn(),
}));

vi.mock("../../../env.js", () => ({ env: mocks.env }));

vi.mock("../../lib/adapters.js", () => ({
  createAdapters: (...args: any[]) => mocks.createAdapters(...args),
}));

const mockDispatchTicket = vi.fn();
vi.mock("../../lib/dispatch.js", () => ({
  dispatchTicket: (...args: any[]) => mockDispatchTicket(...args),
}));

const mockCancelRun = vi.fn();
vi.mock("../../lib/cancel-run.js", () => ({
  cancelRun: (...args: any[]) => mockCancelRun(...args),
}));

const mockStopSandboxesByIds = vi.fn();
vi.mock("../../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: (...args: any[]) => mockStopSandboxesByIds(...args),
}));

const jiraHandler = (await import("./jira.post.js")).default;

function makeApp() {
  const app = createApp();
  app.use("/", jiraHandler);
  return toWebHandler(app);
}

function makeRequest(): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      webhookEvent: "jira:issue_updated",
      issue: {
        key: "PROJ-42",
        fields: { project: { key: "PROJ" }, status: { name: "Backlog" } },
      },
    }),
  });
}

function makeAdapters(listAll: Array<{ ticketKey: string; runId: string; kind: string }>) {
  const active = listAll[0]
    ? {
        subjectKey: `ticket:jira:${listAll[0].ticketKey}`,
        ticketKey: listAll[0].ticketKey,
        ownerToken: "owner-a",
        runId: listAll[0].runId,
        state: "bound",
        kind: listAll[0].kind,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    : null;
  return {
    issueTracker: {
      fetchTicket: vi.fn().mockResolvedValue({
        identifier: "PROJ-42",
        projectKey: "PROJ",
        trackerStatus: "Backlog",
      }),
    },
    runRegistry: {
      get: vi.fn().mockResolvedValue(active),
      listAll: vi.fn().mockResolvedValue(active ? [active] : []),
      listSandboxes: vi.fn().mockResolvedValue([]),
      releaseReservation: vi.fn().mockResolvedValue(true),
    },
    messaging: { notifyForTicket: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("POST /webhooks/jira cancel guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStopSandboxesByIds.mockResolvedValue(0);
  });

  it("does NOT cancel a pr_trigger run when the ticket leaves the AI column", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_pr", kind: "pr_trigger" },
    ]);
    mocks.createAdapters.mockReturnValue(adapters);

    const response = await makeApp()(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "left_ai_column",
      ticketKey: "PROJ-42",
    });
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(adapters.runRegistry.releaseReservation).not.toHaveBeenCalled();
    expect(adapters.messaging.notifyForTicket).not.toHaveBeenCalled();
  });

  it("still cancels a ticket-kind run when the ticket leaves the AI column", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_ticket", kind: "ticket" },
    ]);
    mocks.createAdapters.mockReturnValue(adapters);
    mockCancelRun.mockResolvedValue(true);

    const response = await makeApp()(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "cancelled",
      reason: "left_ai_column",
      ticketKey: "PROJ-42",
    });
    expect(mockCancelRun).toHaveBeenCalledWith("PROJ-42", "run_ticket", adapters.runRegistry);
    expect(adapters.messaging.notifyForTicket).toHaveBeenCalled();
  });
});
