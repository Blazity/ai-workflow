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
