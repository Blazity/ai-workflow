import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

/**
 * An admin presses Test on a working, environment-configured Jira while Jira
 * is down or cannot be reached.
 *
 * The outage says nothing about the credential, so the card has to stay
 * Connected and say the test failed because Jira could not be reached. It used
 * to go Failing, which stops every run that needs Jira until somebody presses
 * Test again, because the Jira package caught the network error and answered
 * "refused". A refusal Jira actually gave still turns it Failing.
 *
 * The real registry, the real Jira package and the real context; `fetch` is
 * replaced at the edge of the process, and the database is pglite.
 */
vi.mock("../../db/client.js", () => ({ getDb: () => db }));

const { listIntegrations, testIntegrationConnection } = await import("./authoring.js");
const { buildIntegrationContext } = await import("./context.js");
const { secretValuesOf } = await import("./connection-values.js");
const { integrationManifest } = await import("@integrations/registry");
const { integrationRuntime } = await import("@integrations/registry/worker");

const ADMIN = { role: "admin", id: "user-1" } as const;
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.execute(
    "insert into env_marker (id, env, endpoint_host) values (1, 'development', 'local')",
  );
  vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net");
  vi.stubEnv("JIRA_API_TOKEN", "atl-token-5c0ffee5");
  vi.stubEnv("JIRA_PROJECT_KEY", "AIW");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function jiraState() {
  const { integrations } = await listIntegrations();
  const jira = integrations.find((entry) => entry.id === "jira");
  if (!jira) throw new Error("this build ships no Jira");
  return jira.state;
}

describe("pressing Test on an environment-configured Jira", () => {
  it("while Jira cannot be reached keeps the card Connected and says why the test failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 104.192.141.1:443"), {
            code: "ECONNREFUSED",
          }),
        });
      }),
    );
    expect((await jiraState()).status).toBe("connected");

    const tested = await testIntegrationConnection({ actor: ADMIN, integrationId: "jira" });

    expect(tested.test).toMatchObject({ ok: false, failure: { reason: "provider_unreachable" } });
    expect(tested.integration.state.status).toBe("connected");
    expect(tested.integration.state.verification).toMatchObject({
      state: "failed",
      failure: { reason: "provider_unreachable" },
    });
  });

  it("when Jira refuses the token turns the card Failing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes("/_edge/tenant_info")
          ? Response.json({ cloudId: "cloud-1" })
          : new Response(null, { status: 401 }),
      ),
    );

    const tested = await testIntegrationConnection({ actor: ADMIN, integrationId: "jira" });

    expect(tested.test).toMatchObject({ ok: false, failure: { reason: "credential_rejected" } });
    expect(tested.integration.state.status).toBe("failing");
  });
});

describe("a Jira site address whose host does not resolve", () => {
  it("names the host and the field it came from, and leaves the card Connected", async () => {
    vi.stubEnv("JIRA_BASE_URL", "https://acme.atlasian.net");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Node's own shape for a name no resolver knows (observed on Node 26).
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND acme.atlasian.net"), {
            code: "ENOTFOUND",
            syscall: "getaddrinfo",
            hostname: "acme.atlasian.net",
          }),
        });
      }),
    );

    const tested = await testIntegrationConnection({ actor: ADMIN, integrationId: "jira" });

    expect(tested.test).toMatchObject({ ok: false, failure: { reason: "provider_unreachable" } });
    const message = tested.test?.ok === false ? tested.test.failure.message : "";
    expect(message).toContain("acme.atlasian.net");
    expect(message).toContain("ENOTFOUND");
    expect(message).toContain("Check the Site URL");
    // A VPN that is down says the same about a host that exists, so this is
    // not a verdict about the values.
    expect(tested.integration.state.status).toBe("connected");
  });
});

describe("a Jira value no request can carry", () => {
  // A token copied out of a wrapped terminal: the line break sits inside it,
  // where trimming does not reach.
  const WRAPPED_TOKEN = "atl-token-5c0f\nfee5";

  it("fails the card before anyone presses Test, naming the variable and never the value", async () => {
    vi.stubEnv("JIRA_API_TOKEN", WRAPPED_TOKEN);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const state = await jiraState();
    expect(state.status).toBe("failing");
    expect(state.failure?.reason).toBe("value_malformed");
    expect(state.failure?.message).toContain("API token");
    expect(state.failure?.message).toContain("JIRA_API_TOKEN");

    const tested = await testIntegrationConnection({ actor: ADMIN, integrationId: "jira" });
    expect(tested.test).toMatchObject({ ok: false, failure: { reason: "value_malformed" } });
    expect(JSON.stringify(tested)).not.toContain("fee5");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a site address typed without https:// as that, not as Jira being down", async () => {
    vi.stubEnv("JIRA_BASE_URL", "acme.atlassian.net");
    vi.stubGlobal("fetch", vi.fn());

    const state = await jiraState();
    expect(state.status).toBe("failing");
    expect(state.failure).toMatchObject({ reason: "value_malformed" });
    expect(state.failure?.message).toContain("Site URL");
    expect(state.failure?.message).toContain("https://");
  });

  it("is refused by Jira's own test through the real context, before the token is sent", async () => {
    // Jira looks its site up before it authenticates; that request carries no
    // token and may go.
    const fetch = vi.fn(async (input: unknown) =>
      String(input).includes("/_edge/tenant_info")
        ? Response.json({ cloudId: "cloud-1" })
        : Response.json({ accountId: "account-1" }),
    );
    vi.stubGlobal("fetch", fetch);
    const manifest = integrationManifest("jira");
    const runtime = integrationRuntime("jira");
    if (!manifest || !runtime) throw new Error("this build ships no Jira");
    const values = {
      baseUrl: "https://acme.atlassian.net",
      apiToken: WRAPPED_TOKEN,
      projectKey: "AIW",
    };

    const result = await (runtime.testConnection as (ctx: unknown) => Promise<unknown>)(
      buildIntegrationContext({
        manifest,
        values,
        secrets: secretValuesOf(manifest, values),
        lifetime: new AbortController().signal,
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("The API token has a line break in it"),
      malformed: true,
    });
    expect(JSON.stringify(result)).not.toContain("fee5");
    for (const [input] of fetch.mock.calls) expect(String(input)).toContain("/_edge/tenant_info");
  });
});

describe("a Slack bot token no request header can carry", () => {
  it("is filed as a malformed value through the real context, not as Slack being down", async () => {
    // A curly quote pasted with the token: the resolver lets a one-line secret
    // with no line break through, and `ctx.http` refuses it when it is sent.
    vi.stubEnv("CHAT_SDK_SLACK_TOKEN", "xoxb-1-2-\u2019abc");
    vi.stubEnv("CHAT_SDK_CHANNEL_ID", "C0123");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const tested = await testIntegrationConnection({ actor: ADMIN, integrationId: "slack" });

    expect(tested.test).toEqual({
      ok: false,
      failure: {
        reason: "value_malformed",
        message:
          "The Bot token has a character in it that no request header can carry, usually a curly quote or an invisible character pasted from a document.",
      },
    });
    expect(tested.integration.state.status).toBe("failing");
    expect(fetch).not.toHaveBeenCalled();
  });
});
