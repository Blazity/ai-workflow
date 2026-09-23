/**
 * `/webhooks/slack` on a deployment that set `SLACK_SIGNING_SECRET` and
 * nothing else of Slack's, through the route, the real resolver, the real
 * settings snapshot and Slack's own package.
 *
 * On `main` such a deployment answered the slash command: the answer goes to
 * Slack's `response_url` and needs no bot token or channel. What decides that
 * here is the resolver serving a webhook on its declared `webhook.requires`,
 * and a double of the resolver (as `integration-webhook.test.ts` has) would
 * only prove the double. So only the database is replaced: the integration
 * connection rows and the settings rows are read as empty, which is what a
 * deployment on environment variables has. Running the command itself is
 * replaced too: which runs exist is not what is under test.
 */
import { createHmac } from "node:crypto";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

vi.mock("../../db/repositories/integrations.js", () => ({
  readConnectedIntegrationConnections: async () => new Map(),
}));
vi.mock("../../db/repositories/settings.js", () => ({
  readAllConnectedSettings: async () => [],
  readAllSettings: async () => [],
}));
// The parsed environment is core's own and not what is under test; the
// signing secret and every integration setting are read off process.env.
vi.mock("../../infra/vcs-config.js", () => ({
  env: {},
  getConfiguredVcsProviders: vi.fn(() => []),
}));

const executeRunControlCommand = vi.fn();
vi.mock("../../services/run-control/index.js", () => ({
  executeRunControlCommand,
  runControlDeps: async () => ({}),
}));

const deferred: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    deferred.push(promise);
  },
}));
vi.mock("../../services/system/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../services/system/observations.js", () => ({
  recordWebhookDelivery: async () => {},
}));

const handler = (await import("./[id].post.js")).default;

function app() {
  const router = createRouter().post("/webhooks/:id", handler);
  return toWebHandler(createApp().use(router));
}

/** `/ai-workflow <text>`, signed with `secret` unless it is null. */
function command(text: string, secret: string | null = SIGNING_SECRET): Request {
  const body = new URLSearchParams({
    user_id: "U2147483697",
    command: "/ai-workflow",
    text,
    response_url: "https://hooks.slack.com/commands/T0001/1/abc",
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature: Record<string, string> =
    secret === null
      ? {}
      : {
          "x-slack-signature": `v0=${createHmac("sha256", secret)
            .update(`v0:${timestamp}:${body}`)
            .digest("hex")}`,
        };
  return new Request("http://localhost/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      ...signature,
    },
    body,
  });
}

let posted: { url: string; body: unknown }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  posted = [];
  // Nothing of Slack's but what each case sets, whatever the shell running
  // this has exported.
  for (const variable of [
    "SLACK_SIGNING_SECRET",
    "CHAT_SDK_SLACK_TOKEN",
    "CHAT_SDK_CHANNEL_ID",
    "SLACK_ALLOWED_USER_IDS",
  ]) {
    vi.stubEnv(variable, undefined);
  }
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /webhooks/slack with only the signing secret set", () => {
  it("acknowledges a signed command inside Slack's deadline and delivers the answer", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
    executeRunControlCommand.mockResolvedValue({ kind: "runs", runs: [] });

    const response = await app()(command("list"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: "Working on `/ai-workflow list`...",
    });
    await Promise.all(deferred);
    expect(executeRunControlCommand).toHaveBeenCalledWith({ kind: "list" }, {});
    expect(posted.map((post) => post.url)).toEqual(["https://hooks.slack.com/commands/T0001/1/abc"]);
  });

  it("refuses an unsigned request and runs nothing", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);

    const response = await app()(command("cancel AWT-42", null));

    expect(response.status).toBe(401);
    await Promise.all(deferred);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("answers 503 naming the signing secret when the deployment has none", async () => {
    // Nothing to verify the request with, so nothing is acted on, and the
    // answer says which value is missing rather than "not connected".
    vi.stubEnv("CHAT_SDK_SLACK_TOKEN", "xoxb-env");
    vi.stubEnv("CHAT_SDK_CHANNEL_ID", "C0ENV");

    const response = await app()(command("cancel AWT-42"));

    expect(response.status).toBe(503);
    expect(response.statusText).toBe(
      "Slack's webhook needs its Signing secret on this deployment, and it is not set or cannot be read.",
    );
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });
});
