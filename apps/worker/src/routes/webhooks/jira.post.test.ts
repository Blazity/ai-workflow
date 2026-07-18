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

vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));

const mockConsumeTicketTransitionIntent = vi.fn();
vi.mock("../../lib/ticket-transition-intent-store.js", () => ({
  consumeTicketTransitionIntent: (...args: any[]) =>
    mockConsumeTicketTransitionIntent(...args),
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

function makeRequest(options: {
  webhookIdentifier?: string | null;
  actorAccountId?: string;
  changelogItems?: Array<Record<string, unknown>>;
} = {}): Request {
  const webhookIdentifier =
    options.webhookIdentifier === undefined ? "jira-delivery-1" : options.webhookIdentifier;
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(webhookIdentifier
        ? { "x-atlassian-webhook-identifier": webhookIdentifier }
        : {}),
    },
    body: JSON.stringify({
      webhookEvent: "jira:issue_updated",
      user: { accountId: options.actorAccountId ?? "jira-bot-account" },
      issue: {
        key: "PROJ-42",
        fields: { project: { key: "PROJ" }, status: { id: "10001", name: "Backlog" } },
      },
      changelog: {
        items:
          options.changelogItems ??
          [{ field: "status", to: "10001", toString: "Backlog" }],
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
    mockConsumeTicketTransitionIntent.mockReset().mockResolvedValue(false);
  });

  it("cancels a pr_trigger run when an unmatched human move takes the ticket out of AI", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_pr", kind: "pr_trigger" },
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
    expect(mockCancelRun).toHaveBeenCalledWith("PROJ-42", "run_pr", adapters.runRegistry);
    expect(adapters.messaging.notifyForTicket).toHaveBeenCalled();
  });

  it("consumes a matching workflow transition echo without cancelling or dispatching", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_pr", kind: "pr_trigger" },
    ]);
    mocks.createAdapters.mockReturnValue(adapters);
    mockConsumeTicketTransitionIntent.mockResolvedValueOnce(true);

    const response = await makeApp()(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "workflow_transition_intent",
      ticketKey: "PROJ-42",
    });
    expect(mockConsumeTicketTransitionIntent).toHaveBeenCalledWith(
      {},
      "PROJ-42",
      { id: "10001", name: "Backlog" },
      {
        actorAccountId: "jira-bot-account",
        webhookIdentifier: "jira-delivery-1",
      },
    );
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockDispatchTicket).not.toHaveBeenCalled();
  });

  it("does not let a non-status update consume an intent from the issue snapshot", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_pr", kind: "pr_trigger" },
    ]);
    mocks.createAdapters.mockReturnValue(adapters);
    mockCancelRun.mockResolvedValue(true);
    mockConsumeTicketTransitionIntent.mockResolvedValueOnce(true);

    const response = await makeApp()(
      makeRequest({ changelogItems: [{ field: "summary", toString: "New title" }] }),
    );

    await expect(response.json()).resolves.toEqual({
      status: "cancelled",
      reason: "left_ai_column",
      ticketKey: "PROJ-42",
    });
    expect(mockConsumeTicketTransitionIntent).not.toHaveBeenCalled();
    expect(mockCancelRun).toHaveBeenCalled();
  });

  it("does not consume an intent without Jira's stable webhook identifier", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_pr", kind: "pr_trigger" },
    ]);
    mocks.createAdapters.mockReturnValue(adapters);
    mockCancelRun.mockResolvedValue(true);
    mockConsumeTicketTransitionIntent.mockResolvedValueOnce(true);

    const response = await makeApp()(makeRequest({ webhookIdentifier: null }));

    await expect(response.json()).resolves.toEqual({
      status: "cancelled",
      reason: "left_ai_column",
      ticketKey: "PROJ-42",
    });
    expect(mockConsumeTicketTransitionIntent).not.toHaveBeenCalled();
    expect(mockCancelRun).toHaveBeenCalled();
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

  it("retains a reserved claim when sandbox cleanup is unconfirmed", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_ticket", kind: "ticket" },
    ]);
    const reserved = {
      ...(await adapters.runRegistry.get("ticket:jira:PROJ-42")),
      state: "reserved",
      runId: null,
    };
    adapters.runRegistry.get.mockResolvedValue(reserved);
    adapters.runRegistry.listSandboxes.mockResolvedValue(["sbx-1"]);
    mockStopSandboxesByIds.mockRejectedValue(new Error("sandbox API unavailable"));
    mocks.createAdapters.mockReturnValue(adapters);

    const response = await makeApp()(makeRequest());

    expect(response.status).toBe(200);
    expect(adapters.runRegistry.releaseReservation).not.toHaveBeenCalled();
    expect(adapters.messaging.notifyForTicket).not.toHaveBeenCalled();
  });
});
