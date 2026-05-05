import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp, toWebHandler } from "h3";
import { createHmac } from "node:crypto";

const SIGNING_SECRET = "shhhh-do-not-tell";
const JIRA_BASE_URL = "https://example.atlassian.net";

// Mock env BEFORE importing anything that pulls it in transitively.
vi.mock("../../../env.js", () => ({
  env: {
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_ALLOWED_USER_IDS: undefined as string | undefined,
    JIRA_BASE_URL,
  },
}));

// Adapters: only runRegistry matters for these tests.
const runRegistry = {
  claim: vi.fn(),
  register: vi.fn(),
  getRunId: vi.fn(),
  unregister: vi.fn().mockResolvedValue(undefined),
  listAll: vi.fn(),
  registerSandbox: vi.fn(),
  getSandboxId: vi.fn().mockResolvedValue(null),
  getEntryCreatedAt: vi.fn(),
  markFailed: vi.fn(),
  isTicketFailed: vi.fn(),
  listAllFailed: vi.fn(),
  clearFailedMark: vi.fn(),
};
vi.mock("../../lib/adapters.js", () => ({
  createAdapters: () => ({
    runRegistry,
    issueTracker: {},
    vcs: {},
    messaging: {},
  }),
}));

const cancelRunFn = vi.fn();
vi.mock("../../lib/cancel-run.js", () => ({
  cancelRun: (...args: any[]) => cancelRunFn(...args),
}));

const stopTicketSandboxesFn = vi.fn();
vi.mock("../../sandbox/stop-ticket-sandboxes.js", () => ({
  stopTicketSandboxes: (...args: any[]) => stopTicketSandboxesFn(...args),
}));

let postedToResponseUrl: Array<{ url: string; payload: any }> = [];
vi.mock("../../lib/slack/respond.js", () => ({
  postToResponseUrl: vi.fn(async (url: string, payload: any) => {
    postedToResponseUrl.push({ url, payload });
  }),
}));

const slackHandler = (await import("./slack.post.js")).default;

function makeApp() {
  const app = createApp();
  app.use("/", slackHandler);
  return toWebHandler(app);
}

function sign(rawBody: string, timestamp: string): string {
  const mac = createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return `v0=${mac}`;
}

function makeRequest(
  body: string,
  opts: { signed?: boolean; timestamp?: string } = {},
): Request {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.signed !== false) {
    headers["x-slack-request-timestamp"] = timestamp;
    headers["x-slack-signature"] = sign(body, timestamp);
  }
  return new Request("http://localhost/", {
    method: "POST",
    headers,
    body,
  });
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function flushDeferred(): Promise<void> {
  // event.waitUntil is not available on the bare h3 app, so the route falls
  // back to fire-and-forget. Yield to the microtask queue so the deferred
  // postToResponseUrl call lands before assertions.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("POST /webhooks/slack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postedToResponseUrl = [];
    runRegistry.listAll.mockResolvedValue([]);
    runRegistry.getRunId.mockResolvedValue(null);
    runRegistry.getSandboxId.mockResolvedValue(null);
  });

  it("returns 401 on a tampered body", async () => {
    const handler = makeApp();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": sign("original", timestamp),
    };
    const res = await handler(
      new Request("http://localhost/", {
        method: "POST",
        headers,
        body: "tampered",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature headers are missing", async () => {
    const handler = makeApp();
    const res = await handler(makeRequest(form({ text: "list" }), { signed: false }));
    expect(res.status).toBe(401);
  });

  it("acks /ai-workflow list within 200 and posts the formatted list to response_url", async () => {
    runRegistry.listAll.mockResolvedValue([
      { ticketKey: "AWT-1", runId: "run_real" },
      { ticketKey: "AWT-2", runId: "claiming:1700000000000" },
    ]);

    const handler = makeApp();
    const body = form({
      command: "/ai-workflow",
      text: "list",
      user_id: "U999",
      response_url: "https://hooks.slack.com/commands/T1/abc",
    });
    const res = await handler(makeRequest(body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Working on");

    await flushDeferred();
    expect(postedToResponseUrl).toHaveLength(1);
    expect(postedToResponseUrl[0]!.url).toBe(
      "https://hooks.slack.com/commands/T1/abc",
    );
    expect(postedToResponseUrl[0]!.payload.response_type).toBe("in_channel");
    expect(postedToResponseUrl[0]!.payload.text).toContain("AWT-1");
    expect(postedToResponseUrl[0]!.payload.text).toContain("run_real");
    expect(postedToResponseUrl[0]!.payload.text).not.toContain("AWT-2");
  });

  it("returns ephemeral 'Not authorized.' when user is not in the allowlist", async () => {
    const { env } = await import("../../../env.js");
    (env as any).SLACK_ALLOWED_USER_IDS = "UALLOWED1,UALLOWED2";
    try {
      const handler = makeApp();
      const body = form({
        command: "/ai-workflow",
        text: "list",
        user_id: "UDENIED",
        response_url: "https://hooks.slack.com/commands/T1/abc",
      });
      const res = await handler(makeRequest(body));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.response_type).toBe("ephemeral");
      expect(json.text).toBe("Not authorized.");
      await flushDeferred();
      expect(postedToResponseUrl).toHaveLength(0);
    } finally {
      (env as any).SLACK_ALLOWED_USER_IDS = undefined;
    }
  });

  it("/ai-workflow cancel AWT-1 with no entry posts 'No active run' to response_url", async () => {
    runRegistry.getRunId.mockResolvedValue(null);
    const handler = makeApp();
    const body = form({
      command: "/ai-workflow",
      text: "cancel AWT-1",
      user_id: "U1",
      response_url: "https://hooks.slack.com/commands/T1/abc",
    });
    await handler(makeRequest(body));
    await flushDeferred();
    expect(cancelRunFn).not.toHaveBeenCalled();
    expect(postedToResponseUrl).toHaveLength(1);
    expect(postedToResponseUrl[0]!.payload.text).toContain("No active run for AWT-1");
  });

  it("/ai-workflow cancel AWT-1 with a real entry calls cancelRun once with the right args", async () => {
    runRegistry.getRunId.mockResolvedValue("run_a");
    cancelRunFn.mockResolvedValue(true);

    const handler = makeApp();
    const body = form({
      command: "/ai-workflow",
      text: "cancel AWT-1",
      user_id: "U1",
      response_url: "https://hooks.slack.com/commands/T1/abc",
    });
    await handler(makeRequest(body));
    await flushDeferred();

    expect(cancelRunFn).toHaveBeenCalledTimes(1);
    expect(cancelRunFn).toHaveBeenCalledWith("AWT-1", "run_a", runRegistry);
    expect(postedToResponseUrl).toHaveLength(1);
    expect(postedToResponseUrl[0]!.payload.text).toContain("Cancelled AWT-1");
  });

  it("an empty /ai-workflow returns the help text synchronously", async () => {
    const handler = makeApp();
    const res = await handler(
      makeRequest(
        form({
          command: "/ai-workflow",
          text: "",
          user_id: "U1",
          response_url: "https://hooks.slack.com/commands/T1/abc",
        }),
      ),
    );
    const json = await res.json();
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Blazebot commands");
  });
});
