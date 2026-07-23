import { createHmac } from "node:crypto";
import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    MAX_CONCURRENT_AGENTS: 3,
    JIRA_WEBHOOK_SECRET: "secret" as string | undefined,
  },
  createAdapters: vi.fn(),
  dispatch: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  isRunRecordedFailed: vi.fn(),
  isRunRecordedSucceeded: vi.fn(),
}));

vi.mock("../../../env.js", () => ({ env: state.env }));
vi.mock("../../lib/adapters.js", () => ({ createAdapters: state.createAdapters }));
vi.mock("../../lib/dispatch.js", () => ({ dispatchTicket: state.dispatch }));
vi.mock("../../lib/cancel-run.js", () => ({ cancelRun: state.cancel }));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../clarifications/resume-from-comments.js", () => ({
  resumeClarificationFromComments: (...args: unknown[]) => state.resume(...args),
}));
vi.mock("../../db/queries/runs-read.js", () => ({
  isRunRecordedFailed: state.isRunRecordedFailed,
  isRunRecordedSucceeded: state.isRunRecordedSucceeded,
}));

const handler = (await import("./jira.post.js")).default;

function app() {
  const instance = createApp();
  instance.use("/", handler);
  return toWebHandler(instance);
}

function request(input: {
  actor?: string | null;
  status?: string;
  changelog?: boolean;
} = {}) {
  const raw = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    ...(input.actor === null ? {} : { user: { accountId: input.actor ?? "human-account" } }),
    issue: {
      key: "PROJ-42",
      fields: {
        project: { key: "PROJ" },
        status: { id: input.status === "AI" ? "10" : "20", name: input.status ?? "Backlog" },
      },
    },
    changelog: {
      items: input.changelog === false
        ? [{ field: "summary", toString: "Updated" }]
        : [{ field: "status", to: input.status === "AI" ? "10" : "20", toString: input.status ?? "Backlog" }],
    },
  });
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature": `sha256=${createHmac("sha256", state.env.JIRA_WEBHOOK_SECRET!).update(raw).digest("hex")}`,
    },
    body: raw,
  });
}

function adapters(options: { state?: "bound" | "cancelling"; active?: boolean } = {}) {
  const active = options.active === false
    ? null
    : {
        subjectKey: "ticket:jira:PROJ-42",
        ticketKey: "PROJ-42",
        ownerToken: "owner-1",
        runId: "run-1",
        state: options.state ?? "bound",
        kind: "ticket",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
  return {
    issueTracker: {
      getCurrentUserAccountId: vi.fn().mockResolvedValue("workflow-account"),
      fetchTicket: vi.fn().mockResolvedValue({
        identifier: "PROJ-42",
        projectKey: "PROJ",
        trackerStatus: "Backlog",
      }),
    },
    runRegistry: { get: vi.fn().mockResolvedValue(active) },
    messaging: { notifyForTicket: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("POST /webhooks/jira", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.env.JIRA_WEBHOOK_SECRET = "secret";
    state.cancel.mockResolvedValue(true);
    state.dispatch.mockResolvedValue({ started: false, reason: "not_applicable" });
    state.isRunRecordedFailed.mockResolvedValue(false);
    state.isRunRecordedSucceeded.mockResolvedValue(false);
  });

  it("rejects unauthenticated configuration", async () => {
    state.env.JIRA_WEBHOOK_SECRET = undefined;
    const response = await app()(new Request("http://localhost/", { method: "POST", body: "{}" }));
    expect(response.status).toBe(503);
  });

  it("ignores a status transition authored by the workflow Jira account", async () => {
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    const response = await app()(request({ actor: "workflow-account" }));

    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "workflow_actor",
      ticketKey: "PROJ-42",
    });
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("cancels the exact active owner for a human status move", async () => {
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    const response = await app()(request({ actor: "human-account" }));

    await expect(response.json()).resolves.toMatchObject({
      status: "cancelled",
      reason: "left_ai_column",
    });
    expect(state.cancel).toHaveBeenCalledWith(
      "PROJ-42",
      { ownerToken: "owner-1", runId: "run-1" },
      connected.runRegistry,
      connected.issueTracker,
    );
  });

  it("does not cancel a run whose failure is already recorded (its own backlog move)", async () => {
    // The bot's failure handling moved the ticket to the backlog, firing this
    // webhook. The run already recorded 'failed', so cancelling would overwrite
    // that with a 'cancelled' status the errors KPI never counts.
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    state.isRunRecordedFailed.mockResolvedValue(true);

    const response = await app()(request({ actor: "human-account" }));

    await expect(response.json()).resolves.toMatchObject({
      status: "ignored",
      reason: "run_already_failed",
      ticketKey: "PROJ-42",
    });
    expect(state.isRunRecordedFailed).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("does not cancel a run whose success is already recorded (its own AI Review move)", async () => {
    // The bot's success finalization moved the ticket to AI Review, firing this
    // webhook. The run already recorded 'success', so cancelling would
    // overwrite that with a 'blocked' status even though the PR already opened.
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    state.isRunRecordedSucceeded.mockResolvedValue(true);

    const response = await app()(request({ actor: "human-account" }));

    await expect(response.json()).resolves.toMatchObject({
      status: "ignored",
      reason: "run_already_succeeded",
      ticketKey: "PROJ-42",
    });
    expect(state.isRunRecordedSucceeded).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("surfaces a retryable error when the failed-status lookup fails (does not cancel)", async () => {
    // A transient lookup failure must not be read as "not failed": guessing
    // would cancel a genuinely failed run. Return a retryable 503 instead.
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    state.isRunRecordedFailed.mockRejectedValue(new Error("db down"));

    const response = await app()(request({ actor: "human-account" }));

    expect(response.status).toBe(503);
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("surfaces a retryable error when the success-status lookup fails (does not cancel)", async () => {
    // Same fail-closed rule for the success lookup: guessing "not succeeded"
    // would cancel a genuinely finished run. Return a retryable 503 instead.
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    state.isRunRecordedSucceeded.mockRejectedValue(new Error("db down"));

    const response = await app()(request({ actor: "human-account" }));

    expect(response.status).toBe(503);
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["missing actor", null],
    ["different actor", "another-account"],
  ])("fails safe for a %s by treating it as human", async (_label, actor) => {
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    await app()(request({ actor }));
    expect(state.cancel).toHaveBeenCalledOnce();
  });

  it("fails safe when workflow actor lookup is unavailable", async () => {
    const connected = adapters();
    connected.issueTracker.getCurrentUserAccountId.mockRejectedValue(new Error("Jira unavailable"));
    state.createAdapters.mockReturnValue(connected);
    await app()(request({ actor: "workflow-account" }));
    expect(state.cancel).toHaveBeenCalledOnce();
  });

  it("does not cancel an outside-column snapshot without a status changelog item", async () => {
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    const response = await app()(request({ changelog: false }));
    await expect(response.json()).resolves.toMatchObject({ reason: "no_status_change" });
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("continues an already-closing exact owner", async () => {
    const connected = adapters({ state: "cancelling" });
    state.createAdapters.mockReturnValue(connected);
    const response = await app()(request({ status: "AI" }));
    await expect(response.json()).resolves.toMatchObject({
      reason: "human_status_change_during_cancellation",
    });
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("resumes a suspended clarification run instead of dispatching", async () => {
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    state.resume.mockResolvedValue({ status: "resumed", runId: "run-9" });

    const response = await app()(request({ status: "AI" }));

    await expect(response.json()).resolves.toEqual({
      status: "resumed",
      reason: "clarification_resumed",
      ticketKey: "PROJ-42",
    });
    expect(state.resume).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: "PROJ-42", allowNudge: true }),
    );
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches as usual when there is no clarification to resume", async () => {
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    state.resume.mockResolvedValue({ status: "no_clarification" });
    state.dispatch.mockResolvedValue({ started: true, reason: "dispatched" });

    const response = await app()(request({ status: "AI" }));

    await expect(response.json()).resolves.toMatchObject({ status: "dispatched" });
    expect(state.dispatch).toHaveBeenCalledOnce();
  });

  it("only allows nudging when the delivery carries a status changelog item", async () => {
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    state.resume.mockResolvedValue({ status: "no_clarification" });
    state.dispatch.mockResolvedValue({ started: true, reason: "dispatched" });

    await app()(request({ status: "AI", changelog: false }));

    expect(state.resume).toHaveBeenCalledWith(
      expect.objectContaining({ allowNudge: false }),
    );
  });

  it("skips dispatch when the resume helper fails unexpectedly", async () => {
    const connected = adapters();
    state.createAdapters.mockReturnValue(connected);
    state.resume.mockRejectedValue(new Error("db down"));

    const response = await app()(request({ status: "AI" }));

    await expect(response.json()).resolves.toEqual({
      status: "skipped",
      reason: "clarification_resume_error",
      ticketKey: "PROJ-42",
    });
    expect(state.dispatch).not.toHaveBeenCalled();
  });
});
