import { createHmac } from "node:crypto";
import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    MAX_CONCURRENT_AGENTS: 3,
    JIRA_WEBHOOK_SECRET: "jira-webhook-secret" as string | undefined,
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
const mockRecordTicketCancellationFence = vi.fn();
vi.mock("../../lib/ticket-transition-intent-store.js", () => ({
  consumeTicketTransitionIntent: (...args: any[]) =>
    mockConsumeTicketTransitionIntent(...args),
  recordTicketCancellationFenceOwner: (...args: any[]) =>
    mockRecordTicketCancellationFence(...args),
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
  status?: { id: string; name: string };
  timestamp?: number;
} = {}): Request {
  const webhookIdentifier =
    options.webhookIdentifier === undefined ? "jira-delivery-1" : options.webhookIdentifier;
  const rawBody = JSON.stringify({
      webhookEvent: "jira:issue_updated",
      timestamp: options.timestamp ?? Date.parse("2026-07-18T12:00:00.000Z"),
      user: { accountId: options.actorAccountId ?? "jira-bot-account" },
      issue: {
        key: "PROJ-42",
        fields: {
          project: { key: "PROJ" },
          status: options.status ?? { id: "10001", name: "Backlog" },
        },
    },
    changelog: {
      items:
        options.changelogItems ??
        [{ field: "status", to: "10001", toString: "Backlog" }],
    },
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(webhookIdentifier
      ? { "x-atlassian-webhook-identifier": webhookIdentifier }
      : {}),
  };
  if (mocks.env.JIRA_WEBHOOK_SECRET) {
    headers["x-hub-signature"] = `sha256=${createHmac(
      "sha256",
      mocks.env.JIRA_WEBHOOK_SECRET,
    )
      .update(rawBody, "utf8")
      .digest("hex")}`;
  }
  return new Request("http://localhost/", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

function makeAdapters(
  listAll: Array<{
    ticketKey: string;
    runId: string;
    kind: string;
    state?: "bound" | "cancelling";
  }>,
) {
  const active = listAll[0]
    ? {
        subjectKey: `ticket:jira:${listAll[0].ticketKey}`,
        ticketKey: listAll[0].ticketKey,
        ownerToken: "owner-a",
        runId: listAll[0].runId,
        state: listAll[0].state ?? "bound",
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

describe("POST /webhooks/jira authentication", () => {
  it("rejects requests when Jira webhook authentication is not configured", async () => {
    mocks.env.JIRA_WEBHOOK_SECRET = undefined;

    const response = await makeApp()(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.createAdapters).not.toHaveBeenCalled();
    expect(mockDispatchTicket).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/jira cancel guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.JIRA_WEBHOOK_SECRET = "jira-webhook-secret";
    mockStopSandboxesByIds.mockResolvedValue(0);
    mockConsumeTicketTransitionIntent.mockReset().mockResolvedValue(false);
    mockRecordTicketCancellationFence
      .mockReset()
      .mockImplementation(async (_db, input) => ({
        ownerToken: input.ownerToken,
        runId: input.runId,
      }));
  });

  it("cancels a pr_trigger run when an unmatched human move takes the ticket out of AI", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_pr", kind: "pr_trigger" },
    ]);
    mocks.createAdapters.mockReturnValue(adapters);
    const order: string[] = [];
    mockRecordTicketCancellationFence.mockImplementation(async () => {
      order.push("fence");
      return { ownerToken: "owner-a", runId: "run_pr" };
    });
    mockCancelRun.mockImplementation(async () => {
      order.push("cancel");
      return true;
    });

    const response = await makeApp()(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "cancelled",
      reason: "left_ai_column",
      ticketKey: "PROJ-42",
    });
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-42",
      { ownerToken: "owner-a", runId: "run_pr" },
      adapters.runRegistry,
      adapters.issueTracker,
    );
    expect(mockRecordTicketCancellationFence).toHaveBeenCalledWith({}, {
      ticketKey: "PROJ-42",
      subjectKey: "ticket:jira:PROJ-42",
      ownerToken: "owner-a",
      runId: "run_pr",
      target: { name: "Backlog", statusId: "10001" },
      webhookIdentifier: "jira-delivery-1",
      occurredAt: new Date("2026-07-18T12:00:00.000Z"),
    });
    expect(order).toEqual(["fence", "cancel"]);
    expect(adapters.messaging.notifyForTicket).toHaveBeenCalled();
  });

  it("cancels the exact clarification successor closed by fence acquisition", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run-predecessor", kind: "ticket" },
    ]);
    mocks.createAdapters.mockReturnValue(adapters);
    mockRecordTicketCancellationFence.mockResolvedValue({
      ownerToken: "owner-successor",
      runId: "run-successor",
    });
    mockCancelRun.mockResolvedValue(true);

    const response = await makeApp()(makeRequest());

    expect(response.status).toBe(200);
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-42",
      { ownerToken: "owner-successor", runId: "run-successor" },
      adapters.runRegistry,
      adapters.issueTracker,
    );
  });

  it("updates the durable human destination and finishes an existing cancellation instead of dispatching", async () => {
    const adapters = makeAdapters([
      {
        ticketKey: "PROJ-42",
        runId: "run_ticket",
        kind: "ticket",
        state: "cancelling",
      },
    ]);
    adapters.issueTracker.fetchTicket.mockResolvedValue({
      identifier: "PROJ-42",
      projectKey: "PROJ",
      trackerStatus: "AI",
      trackerStatusId: "10010",
      labels: [],
    });
    mocks.createAdapters.mockReturnValue(adapters);
    mockCancelRun.mockResolvedValue(true);

    const response = await makeApp()(
      makeRequest({
        status: { id: "10010", name: "AI" },
        changelogItems: [{ field: "status", to: "10010", toString: "AI" }],
        timestamp: Date.parse("2026-07-18T12:00:02.000Z"),
      }),
    );

    await expect(response.json()).resolves.toEqual({
      status: "cancelled",
      reason: "human_status_change_during_cancellation",
      ticketKey: "PROJ-42",
    });
    expect(mockRecordTicketCancellationFence).toHaveBeenCalledWith({}, {
      ticketKey: "PROJ-42",
      subjectKey: "ticket:jira:PROJ-42",
      ownerToken: "owner-a",
      runId: "run_ticket",
      target: { name: "AI", statusId: "10010" },
      webhookIdentifier: "jira-delivery-1",
      occurredAt: new Date("2026-07-18T12:00:02.000Z"),
    });
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-42",
      { ownerToken: "owner-a", runId: "run_ticket" },
      adapters.runRegistry,
      adapters.issueTracker,
    );
    expect(mockDispatchTicket).not.toHaveBeenCalled();
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

  it("does not cancel a PR-trigger run for a non-status update outside the AI column", async () => {
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
      status: "ignored",
      reason: "no_status_change",
      ticketKey: "PROJ-42",
    });
    expect(mockConsumeTicketTransitionIntent).not.toHaveBeenCalled();
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockDispatchTicket).not.toHaveBeenCalled();
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
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-42",
      { ownerToken: "owner-a", runId: "run_ticket" },
      adapters.runRegistry,
      adapters.issueTracker,
    );
    expect(adapters.messaging.notifyForTicket).toHaveBeenCalled();
  });

  it("acknowledges an outside-column webhook when no active claim exists", async () => {
    const adapters = makeAdapters([]);
    mocks.createAdapters.mockReturnValue(adapters);

    const response = await makeApp()(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "left_ai_column",
      ticketKey: "PROJ-42",
    });
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("returns a retryable provider failure when reserved cancellation is unconfirmed", async () => {
    const adapters = makeAdapters([
      { ticketKey: "PROJ-42", runId: "run_ticket", kind: "ticket" },
    ]);
    const reserved = {
      ...(await adapters.runRegistry.get("ticket:jira:PROJ-42")),
      state: "reserved",
      runId: null,
    };
    adapters.runRegistry.get.mockResolvedValue(reserved);
    mockCancelRun.mockResolvedValue(false);
    mocks.createAdapters.mockReturnValue(adapters);

    const response = await makeApp()(makeRequest());

    expect(response.status).toBe(503);
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-42",
      { ownerToken: "owner-a", runId: null },
      adapters.runRegistry,
      adapters.issueTracker,
    );
    expect(adapters.messaging.notifyForTicket).not.toHaveBeenCalled();
  });
});
