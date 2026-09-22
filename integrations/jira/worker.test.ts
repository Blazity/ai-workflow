/**
 * What an operator reads on the Health screen about this deployment's Jira.
 *
 * These checks used to live in core (`services/system/probes.ts`, ids
 * `jira.api` and `jira.webhook-delivery`) and moved here in S12, so the cases
 * are the ones that suite proved, re-aimed at the integration that owns them
 * now. Two of them are the reason this file exists at all: a token Jira does
 * not accept and a project key that names nothing are different faults with
 * different fixes, and one blended message made a stale project key
 * undiagnosable for weeks on a deployment whose runs arrive by webhook.
 *
 * Delivery evidence is deliberately NOT here. Whether a request actually
 * reached this worker is core's generic `webhook-delivery` check, written from
 * the observations the shared webhook route records, and it reads the same for
 * every integration.
 */
import { describe, expect, it, vi } from "vitest";
import { runtime } from "./worker";

const CLOUD_ID = "cloud-1";
const WEBHOOK_URL = "https://worker.example/webhooks/jira";

type Handler = (url: string) => Response | undefined;

/**
 * A context whose HTTP is one function, so each case says only which Jira
 * endpoints answer and how. Everything the adapter needs (the cloudId
 * discovery hop included) goes through it.
 */
function context(handler: Handler, overrides: { webhookUrl?: string } = {}) {
  const fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const answer = handler(url);
    if (!answer) throw new Error(`Unexpected request: ${url}`);
    return answer;
  });
  return {
    connection: {
      baseUrl: "https://acme.atlassian.net",
      apiToken: "token",
      projectKey: "AIW",
    },
    signal: new AbortController().signal,
    webhookUrl: "webhookUrl" in overrides ? overrides.webhookUrl : WEBHOOK_URL,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    http: { fetch },
  } as never;
}

function tenantInfo(url: string): Response | undefined {
  return url.includes("/_edge/tenant_info")
    ? Response.json({ cloudId: CLOUD_ID })
    : undefined;
}

function statuses(names: string[]): Response {
  return Response.json([
    { statuses: names.map((name, index) => ({ id: String(index + 1), name })) },
  ]);
}

function webhooks(
  registrations: Array<{ url: string; enabled: boolean; events: string[] }> | number,
): Response {
  return typeof registrations === "number"
    ? new Response(null, { status: registrations })
    : Response.json(registrations);
}

const probe = (id: "api" | "project" | "webhook-registration") => runtime.health![id]!;

describe("the Jira integration's health checks", () => {
  it("names a token Jira did not accept, without blaming the project", async () => {
    const result = await probe("api")(
      context((url) => {
        return (
          tenantInfo(url) ??
          (url.includes("/rest/api/3/myself") ? new Response(null, { status: 401 }) : undefined)
        );
      }),
    );

    expect(result).toEqual({
      status: "down",
      message: "Jira authentication failed: the Site URL or the API token was not accepted.",
    });
  });

  it("reports the token as accepted when Jira answers for the account", async () => {
    const result = await probe("api")(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/rest/api/3/myself")
            ? Response.json({ accountId: "99:acct" })
            : undefined),
      ),
    );

    expect(result).toMatchObject({ status: "live" });
  });

  it("names the project when the account is fine but the project is not reachable", async () => {
    // The fault a blended message used to hide: the credentials work, so every
    // other check is green, and yet not one ticket is ever picked up.
    const result = await probe("project")(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/statuses") ? new Response(null, { status: 404 }) : undefined),
      ),
    );

    expect(result).toEqual({
      status: "down",
      message:
        "Jira authenticated, but project AIW is not accessible; check the Project key on this integration and the token account's access to that project.",
    });
  });

  it("says a visible project with no statuses will ignore every delivery", async () => {
    // The state that replaced a boot failure: the worker used to refuse to
    // start without a Jira project, and a project that answers but shows this
    // account nothing has to be just as loud somewhere a person looks.
    const result = await probe("project")(
      context((url) => tenantInfo(url) ?? (url.includes("/statuses") ? statuses([]) : undefined)),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("AIW");
    expect((result as { message: string }).message).toContain(
      "every delivery about a ticket is ignored",
    );
  });

  it("reads a visible project as live and counts what it can move tickets between", async () => {
    const result = await probe("project")(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/statuses") ? statuses(["To Do", "In Progress"]) : undefined),
      ),
    );

    expect(result).toEqual({
      status: "live",
      message: "Project AIW is visible, with 2 statuses to move tickets between.",
    });
  });

  it("verifies the webhook registration through Jira's own API", async () => {
    const result = await probe("webhook-registration")(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/rest/webhooks/1.0/webhook")
            ? webhooks([
                { url: WEBHOOK_URL, enabled: true, events: ["jira:issue_updated"] },
              ])
            : undefined),
      ),
    );

    expect(result).toEqual({
      status: "live",
      message: `Jira calls ${WEBHOOK_URL} on every issue update.`,
    });
  });

  it("reports a Jira instance with no webhook pointing at this worker", async () => {
    const result = await probe("webhook-registration")(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/rest/webhooks/1.0/webhook")
            ? webhooks([
                {
                  url: "https://elsewhere.example/hook",
                  enabled: true,
                  events: ["jira:issue_updated"],
                },
              ])
            : undefined),
      ),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain(
      `No Jira webhook points at ${WEBHOOK_URL}`,
    );
  });

  it("says a registered webhook that was switched off is switched off", async () => {
    const result = await probe("webhook-registration")(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/rest/webhooks/1.0/webhook")
            ? webhooks([
                { url: WEBHOOK_URL, enabled: false, events: ["jira:issue_updated"] },
              ])
            : undefined),
      ),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("switched off");
  });

  it("says so when the webhook is registered but sends no issue updates", async () => {
    const result = await probe("webhook-registration")(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/rest/webhooks/1.0/webhook")
            ? webhooks([{ url: WEBHOOK_URL, enabled: true, events: ["jira:issue_created"] }])
            : undefined),
      ),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("does not send issue updates");
  });

  it("does not claim a failure when the account may not list Jira's webhooks", async () => {
    // A restricted token is not a broken deployment. Core's delivery check is
    // what answers in this case, so reporting Down here would put a red row on
    // the Health screen for something that is working.
    const result = await probe("webhook-registration")(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/rest/webhooks/1.0/webhook") ? webhooks(403) : undefined),
      ),
    );

    expect(result).toMatchObject({ status: "degraded" });
    expect((result as { message: string }).message).toContain("cannot list Jira's system webhooks");
  });

  it("checks nothing rather than inventing a URL when this worker has no public address", async () => {
    const result = await probe("webhook-registration")(
      context(tenantInfo, { webhookUrl: "" }),
    );

    expect(result).toMatchObject({ status: "degraded" });
    expect((result as { message: string }).message).toContain("no public URL");
  });
});

describe("the Jira integration's connection test", () => {
  it("passes and names what the account can see", async () => {
    const result = await runtime.testConnection!(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/rest/api/3/myself")
            ? Response.json({ accountId: "99:acct" })
            : url.includes("/statuses")
              ? statuses(["To Do"])
              : undefined),
      ),
    );

    expect(result).toEqual({
      ok: true,
      message: "Connected to AIW, 1 status visible.",
    });
  });

  it("refuses a connection whose credentials work but whose project shows nothing", async () => {
    // Saving this connection would give the deployment an issue tracker that
    // silently matches no ticket at all, which is worse than no tracker.
    const result = await runtime.testConnection!(
      context(
        (url) =>
          tenantInfo(url) ??
          (url.includes("/rest/api/3/myself")
            ? Response.json({ accountId: "99:acct" })
            : url.includes("/statuses")
              ? statuses([])
              : undefined),
      ),
    );

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("project AIW has no statuses");
  });
});
