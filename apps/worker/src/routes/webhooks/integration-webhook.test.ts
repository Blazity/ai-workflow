/**
 * The one webhook route every integration answers at, through the real Slack
 * package.
 *
 * What is tested here is the part core owns: the bytes reach the integration
 * unparsed, the provider gets its acknowledgement inside its own deadline, the
 * command runs afterwards, and its outcome comes back even when it failed. The
 * signature algorithm and the wording belong to the package and are tested
 * there (`integrations/slack/slash-command.test.ts`).
 *
 * `/webhooks/slack` is the address Slack already calls, and it still answers
 * here: the static route was deleted, so this dynamic one takes it.
 */
import { createHmac } from "node:crypto";
import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

const state = vi.hoisted(() => ({
  usable: [] as unknown[],
  readable: true,
  states: new Map<string, unknown>(),
  execute: undefined as unknown,
}));

vi.mock("../../services/integrations/runtime.js", () => ({
  resolveUsableIntegrations: async () =>
    state.readable
      ? { readable: true, usable: state.usable, states: state.states }
      : { readable: false, reason: "the settings read timed out" },
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

const handler = (await import("./[id].post.js")).default;
const { integrationRuntime } = await import("@integrations/registry/worker");
// The real Slack runtime out of the registry, which is exactly what the route
// reaches for: a hand-written double here would prove the double works.
const runtime = integrationRuntime("slack")!;

/** The Slack context the resolver would have built for a connected deployment. */
function connectedSlack(): unknown {
  return {
    manifest: { id: "slack", name: "Slack" },
    runtime,
    ctx: {
      connection: {
        botToken: "xoxb-test",
        channelId: "C1",
        signingSecret: SIGNING_SECRET,
        allowedUserIds: undefined,
      },
      signal: new AbortController().signal,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: { fetch: globalThis.fetch },
    },
  };
}

function request(id: string, text: string): Request {
  const body = new URLSearchParams({
    user_id: "U2147483697",
    command: "/ai-workflow",
    text,
    response_url: "https://hooks.slack.com/commands/T0001/1/abc",
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(`http://localhost/webhooks/${id}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`,
    },
    body,
  });
}

function app() {
  // A router, not `use`: the route reads `event.context.params.id`, which is
  // what the file name `[id].post.ts` gives it in the worker.
  const router = createRouter().post("/webhooks/:id", handler);
  return toWebHandler(createApp().use(router));
}

let posted: { url: string; body: unknown }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  posted = [];
  state.usable = [connectedSlack()];
  state.readable = true;
  state.states = new Map([["slack", { enabled: true }]]);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

describe("POST /webhooks/:id", () => {
  it("answers inside the provider's deadline and delivers the result afterwards", async () => {
    // Slack gives about three seconds. The work here never finishes until this
    // test lets it, so a route that waited for it would hang.
    let finish: (answer: unknown) => void = () => {};
    executeRunControlCommand.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const response = await app()(request("slack", "list"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: "Working on `/ai-workflow list`...",
    });
    expect(posted).toHaveLength(0);

    finish({ kind: "runs", runs: [] });
    await Promise.all(deferred);

    expect(executeRunControlCommand).toHaveBeenCalledWith({ kind: "list" }, {});
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://hooks.slack.com/commands/T0001/1/abc");
  });

  it("delivers a failure instead of leaving the person reading \"Working on ...\"", async () => {
    executeRunControlCommand.mockRejectedValue(new Error("the database refused"));

    const response = await app()(request("slack", "list"));
    await Promise.all(deferred);

    expect(response.status).toBe(200);
    expect(posted[0]!.body).toEqual({
      response_type: "in_channel",
      text: ":warning: That command failed: the database refused",
    });
  });

  it("answers help itself, without running anything or deferring work", async () => {
    const response = await app()(request("slack", "help"));

    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(0);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("refuses a request the integration did not recognise as genuine", async () => {
    const tampered = new Request("http://localhost/webhooks/slack", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
      body: "text=list",
    });

    expect((await app()(tampered)).status).toBe(401);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("says a disabled integration is disabled, and runs nothing", async () => {
    // An admin switched it off. Answering 401 or 500 would send whoever
    // registered the command to Slack's own settings.
    state.usable = [];
    state.states = new Map([["slack", { enabled: false }]]);

    const response = await app()(request("slack", "list"));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("disabled");
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("does not act on a request it cannot check, and says why", async () => {
    // Settings unreadable: this deployment cannot tell an allowed sender from
    // anybody else, so it fails closed and loudly rather than silently.
    state.readable = false;

    const response = await app()(request("slack", "cancel AWT-42"));

    expect(response.status).toBe(503);
    expect(executeRunControlCommand).not.toHaveBeenCalled();
  });

  it("404s an id no integration in this build claims", async () => {
    expect((await app()(request("nosuchprovider", "list"))).status).toBe(404);
  });
});
