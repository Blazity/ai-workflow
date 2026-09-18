import { defineIntegration } from "@integrations/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

/**
 * The integrations this build ships is a fact about the BUILD, which a test has
 * to be able to declare the way it declares environment variables. The generated
 * registry is that declaration, so it is what this test replaces; nothing below
 * reaches past the service into how a status is computed.
 */
const manifest = defineIntegration({
  id: "demo",
  name: "Demo",
  description: "A provider core has never heard of.",
  connection: {
    fields: [
      { key: "baseUrl", label: "Site URL", env: "DEMO_BASE_URL", secret: false, format: "url" },
      { key: "apiToken", label: "API token", env: "DEMO_API_TOKEN", secret: true },
      {
        key: "privateKey",
        label: "Private key",
        env: "DEMO_PRIVATE_KEY",
        secret: false,
        optional: true,
        format: "multiline",
      },
    ],
  },
  capabilities: [],
  blocks: [],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "The token is accepted.", critical: true }],
});

/** The token the provider below accepts. Anything else is refused the way a real
 *  one refuses: with a body that echoes what was sent. */
const GOOD_TOKEN = "demo-token-good-0123456789";
const BAD_TOKEN = "demo-token-bad-0123456789";

const testConnection = vi.fn(async (ctx: { connection: Record<string, unknown> }) => {
  // The provider lives at demo.example. A URL pointing anywhere else does not
  // reach a provider at all, which is a throw rather than a refusal, exactly as
  // a real client behaves.
  const baseUrl = String(ctx.connection.baseUrl ?? "");
  if (!baseUrl.startsWith("https://demo.example")) {
    throw new Error(`fetch failed: ${baseUrl}`);
  }
  if (ctx.connection.apiToken === GOOD_TOKEN) return { ok: true as const, message: "Demo reachable" };
  return {
    ok: false as const,
    // Providers really do echo the credential back in an error body.
    reason: `401 Unauthorized for token ${String(ctx.connection.apiToken)}`,
  };
});

/** The service reaches for this deployment's connection through the db tier, so
 *  this is where a test hands it one. It is the same seam every other service
 *  test in this worker uses. */
vi.mock("../../db/client.js", () => ({ getDb: () => db }));

vi.mock("@integrations/registry", () => ({
  integrationManifests: [manifest],
  integrationManifest: (id: string) => (id === "demo" ? manifest : undefined),
}));

vi.mock("@integrations/registry/worker", () => ({
  integrationRuntime: (id: string) => (id === "demo" ? { manifest, testConnection } : undefined),
}));

const {
  IntegrationVersionConflictError,
  testIntegrationConnection,
  disconnectIntegrationConnection,
  listIntegrations,
  saveIntegrationConnection,
  setIntegrationConnectionSource,
  setIntegrationEnabledState,
} = await import("./authoring.js");
const { looksLikeIntegrationSecret } = await import("../../infra/secrets-crypto.js");

const KEY = "c".repeat(64);
const ADMIN = { role: "admin", id: "user-1" } as const;
const MEMBER = { role: "member", id: "user-2" } as const;

let db: Db;
const originalEnv = { ...process.env };

beforeEach(async () => {
  db = await createTestDb();
  // The deployment owns this database, which is what lets it write at all.
  await db.execute("insert into env_marker (id, env, endpoint_host) values (1, 'development', 'local')");
  process.env.INTEGRATION_SECRETS_KEY = KEY;
  delete process.env.DEMO_BASE_URL;
  delete process.env.DEMO_API_TOKEN;
  testConnection.mockClear();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function save(values: Record<string, string>, expectedVersion = 0, extra: { clearSecrets?: string[] } = {}) {
  return saveIntegrationConnection({
    actor: ADMIN,
    integrationId: "demo",
    expectedVersion,
    values,
    clearSecrets: extra.clearSecrets ?? [],
  });
}

const GOOD = { baseUrl: "https://demo.example/site", apiToken: GOOD_TOKEN };

describe("an admin connecting an integration for the first time", () => {
  it("is told at once that a wrong token was refused, and nothing is unlocked (INT-011)", async () => {
    const result = await save({ ...GOOD, apiToken: BAD_TOKEN });
    expect(result.test?.ok).toBe(false);
    expect(result.integration.state.status).toBe("not_connected");
    expect(result.integration.state.usable).toBe(false);
  });

  it("keeps the non-secret fields filled so one field can be corrected (INT-011)", async () => {
    const result = await save({ ...GOOD, apiToken: BAD_TOKEN });
    const url = result.integration.fields.find((f) => f.key === "baseUrl");
    expect(url?.storedValue).toBe("https://demo.example/site");
  });

  it("is Connected the moment the right token is saved, in one action (INT-010)", async () => {
    // This deployment sets none of the integration's variables, so there is no
    // environment connection to protect and nothing to switch away from. A
    // second button here would be a step that exists only because of how the
    // state is stored.
    const first = await save({ ...GOOD, apiToken: BAD_TOKEN });
    const second = await save(GOOD, first.integration.state.stored.latestVersion);
    expect(second.test).toEqual({ ok: true, message: "Demo reachable" });
    expect(second.integration.state.status).toBe("connected");
    expect(second.integration.state.source).toBe("stored");
    expect(second.integration.state.verification.state).toBe("passed");
    expect(second.integration.state.usable).toBe(true);
  });

  it("leaves a deployment configured through its environment alone until asked (INT-053)", async () => {
    // Here the environment IS the connection, so a save prepares values and
    // changes nothing about what is running. Switching is the admin's decision.
    process.env.DEMO_BASE_URL = "https://demo.example/site";
    process.env.DEMO_API_TOKEN = GOOD_TOKEN;
    const saved = await save(GOOD);
    expect(saved.test?.ok).toBe(true);
    expect(saved.integration.state.source).toBe("environment");
    expect(saved.integration.state.stored.activeVersion).toBe(1);

    const switched = await setIntegrationConnectionSource({
      actor: ADMIN,
      integrationId: "demo",
      source: "stored",
    });
    expect(switched.integration.state.source).toBe("stored");
    expect(switched.integration.state.status).toBe("connected");
  });

  it("does not switch a half-configured environment out from under the admin", async () => {
    // One variable set is a typo, not a decision. It is still the source, so a
    // stored save must not silently take over and make the typo invisible.
    process.env.DEMO_BASE_URL = "https://demo.example/site";
    const saved = await save(GOOD);
    expect(saved.integration.state.source).toBe("environment");
    expect(saved.integration.state.status).toBe("failing");
  });
});

describe("a provider that does not answer at all (INT-012)", () => {
  it("is told apart from a provider that answered no, because the fix is different", async () => {
    testConnection.mockImplementationOnce(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    const result = await save(GOOD);
    expect(result.test?.ok).toBe(false);
    expect(result.test?.ok === false && result.test.failure.reason).toBe("provider_unreachable");

    const refused = await save({ ...GOOD, apiToken: BAD_TOKEN }, 1);
    expect(refused.test?.ok === false && refused.test.failure.reason).toBe("credential_rejected");
  });
});

describe("the values that come back", () => {
  it("carry neither the token nor the envelope it is stored in (INT-023)", async () => {
    const saved = await save(GOOD);
    const listed = await listIntegrations();
    for (const payload of [JSON.stringify(saved), JSON.stringify(listed)]) {
      expect(payload).not.toContain(GOOD_TOKEN);
      expect(looksLikeIntegrationSecret(payload)).toBe(false);
    }
  });

  it("carry no token even when the provider echoed it back in its refusal (INT-023)", async () => {
    const refused = await save({ ...GOOD, apiToken: BAD_TOKEN });
    const payload = JSON.stringify(refused);
    expect(payload).not.toContain(BAD_TOKEN);
    expect(payload).toContain("401 Unauthorized");
  });

  it("say a secret is stored without saying what it is", async () => {
    const saved = await save(GOOD);
    const token = saved.integration.fields.find((f) => f.key === "apiToken");
    expect(token?.storedSecretSet).toBe(true);
    expect(token).not.toHaveProperty("storedValue");
  });
});

describe("correcting a save the provider refused (INT-011, INT-050)", () => {
  it("keeps the token that was entered with it, so a rotation is never silently lost", async () => {
    // The journey: paste a NEW token, get the URL wrong, fail. Fix the URL,
    // leave the token field blank because it was already typed once. If the save
    // carried the previously ACTIVE secret forward, this would pass with the OLD
    // token and read Connected until that token was revoked.
    const first = await save({ baseUrl: "https://wrong.example/site", apiToken: GOOD_TOKEN });
    expect(first.test?.ok).toBe(false);

    testConnection.mockClear();
    const second = await save(
      { baseUrl: "https://demo.example/site" },
      first.integration.state.stored.latestVersion,
    );
    expect(second.test?.ok).toBe(true);
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connection: expect.objectContaining({ apiToken: GOOD_TOKEN }) }),
    );
  });

  it("does not resurrect a superseded token when a working connection is edited", async () => {
    const first = await save(GOOD);
    const second = await save(
      { ...GOOD, apiToken: BAD_TOKEN },
      first.integration.state.stored.latestVersion,
    );
    expect(second.test?.ok).toBe(false);

    testConnection.mockClear();
    // The admin now fixes only the URL. What they last entered is the bad token,
    // so the save has to fail again rather than quietly reverting to the good
    // one and telling them the typo was the whole problem.
    await save({ baseUrl: "https://demo.example/other" }, second.integration.state.stored.latestVersion);
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connection: expect.objectContaining({ apiToken: BAD_TOKEN }) }),
    );
  });
});

describe("what a pasted value keeps and loses", () => {
  it("takes the whitespace off a token, because that is what a clipboard adds", async () => {
    const saved = await save({ ...GOOD, apiToken: `  ${GOOD_TOKEN}\n` });
    expect(saved.test?.ok).toBe(true);
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connection: expect.objectContaining({ apiToken: GOOD_TOKEN }) }),
    );
  });

  it("keeps a multiline value exactly as it was typed, because a key's shape is part of it", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\n  indented\nline\n-----END PRIVATE KEY-----\n";
    const saved = await save({ ...GOOD, privateKey: pem });
    const field = saved.integration.fields.find((f) => f.key === "privateKey");
    expect(field?.storedValue).toBe(pem);
  });
});

describe("editing a connection that already has a secret", () => {
  it("keeps the stored secret when only the URL changes (INT-052)", async () => {
    const first = await save(GOOD);
    testConnection.mockClear();
    const second = await save(
      { baseUrl: "https://demo.example/moved" },
      first.integration.state.stored.latestVersion,
    );
    // The test ran against the carried-forward token, which is the only way it
    // could have passed without the admin retyping it.
    expect(second.test?.ok).toBe(true);
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connection: expect.objectContaining({ apiToken: GOOD_TOKEN }) }),
    );
  });

  it("clears a secret only when that is what was asked for", async () => {
    const first = await save(GOOD);
    const second = await save({}, first.integration.state.stored.latestVersion, {
      clearSecrets: ["apiToken"],
    });
    const token = second.integration.fields.find((f) => f.key === "apiToken");
    expect(token?.storedSecretSet).toBe(false);
    expect(second.test?.ok).toBe(false);
  });
});

describe("saving values the provider refused", () => {
  it("leaves the working connection in use and says why the new ones failed (INT-051)", async () => {
    await save(GOOD);
    await setIntegrationConnectionSource({ actor: ADMIN, integrationId: "demo", source: "stored" });
    const state = (await listIntegrations()).integrations[0]?.state;

    const refused = await save({ ...GOOD, apiToken: BAD_TOKEN }, state?.stored.latestVersion ?? 0);
    expect(refused.integration.state.status).toBe("connected");
    expect(refused.integration.state.stored.prepared?.failure.reason).toBe("credential_rejected");
  });

  it("never puts them in use, because an outage must not take a working deployment down", async () => {
    const result = await save({ ...GOOD, apiToken: BAD_TOKEN });
    expect(result.integration.state.stored.activeVersion).toBeNull();
    expect(result.integration.state.stored.latestVersion).toBe(1);
  });

  it("refuses a second save whose version moved, so no tab overwrites another (INT-017)", async () => {
    await save(GOOD);
    await expect(save(GOOD, 0)).rejects.toBeInstanceOf(IntegrationVersionConflictError);
  });
});

describe("testing an environment-configured integration (INT-002)", () => {
  beforeEach(() => {
    process.env.DEMO_BASE_URL = "https://demo.example/site";
    process.env.DEMO_API_TOKEN = GOOD_TOKEN;
  });

  it("starts out Connected with nothing verified, because nothing was asked", async () => {
    const state = (await listIntegrations()).integrations[0]?.state;
    expect(state?.status).toBe("connected");
    expect(state?.verification).toEqual({ state: "never_tested" });
  });

  it("records what the provider said, so the card stops saying nothing was verified", async () => {
    const tested = await testIntegrationConnection({ actor: ADMIN, integrationId: "demo" });
    expect(tested.test?.ok).toBe(true);
    expect(tested.integration.state.verification.state).toBe("passed");
  });

  it("stops calling a refused environment connection Connected", async () => {
    process.env.DEMO_API_TOKEN = BAD_TOKEN;
    const tested = await testIntegrationConnection({ actor: ADMIN, integrationId: "demo" });
    expect(tested.integration.state.status).toBe("failing");
    expect(tested.integration.state.failure?.reason).toBe("credential_rejected");
    expect(JSON.stringify(tested)).not.toContain(BAD_TOKEN);
  });

  it("forgets that refusal once the variable is changed by a redeploy", async () => {
    process.env.DEMO_API_TOKEN = BAD_TOKEN;
    await testIntegrationConnection({ actor: ADMIN, integrationId: "demo" });
    process.env.DEMO_API_TOKEN = GOOD_TOKEN;
    const state = (await listIntegrations()).integrations[0]?.state;
    expect(state?.status).toBe("connected");
    expect(state?.verification.state).toBe("stale");
  });
});

describe("the disable switch", () => {
  it("changes the answer within one process, because it is read live and never cached", async () => {
    process.env.DEMO_BASE_URL = "https://demo.example/site";
    process.env.DEMO_API_TOKEN = GOOD_TOKEN;
    expect((await listIntegrations()).integrations[0]?.state.usable).toBe(true);

    await setIntegrationEnabledState({ actor: ADMIN, integrationId: "demo", enabled: false });
    const off = (await listIntegrations()).integrations[0]?.state;
    expect(off?.status).toBe("disabled");
    expect(off?.usable).toBe(false);

    await setIntegrationEnabledState({ actor: ADMIN, integrationId: "demo", enabled: true });
    expect((await listIntegrations()).integrations[0]?.state.usable).toBe(true);
  });
});

describe("switching the source", () => {
  it("is refused when the environment does not configure the integration (INT-055)", async () => {
    await save(GOOD);
    await expect(
      setIntegrationConnectionSource({
        actor: ADMIN,
        integrationId: "demo",
        source: "environment",
      }),
    ).rejects.toThrow(/DEMO_BASE_URL/);
  });

  it("names what is missing when the environment is only half set (INT-055)", async () => {
    process.env.DEMO_BASE_URL = "https://demo.example/site";
    await save(GOOD);
    await expect(
      setIntegrationConnectionSource({
        actor: ADMIN,
        integrationId: "demo",
        source: "environment",
      }),
    ).rejects.toThrow(/DEMO_API_TOKEN/);
  });
});

describe("disconnecting (INT-070)", () => {
  it("hands the connection back to the environment and forgets every value", async () => {
    await save(GOOD);
    await setIntegrationConnectionSource({ actor: ADMIN, integrationId: "demo", source: "stored" });
    const after = await disconnectIntegrationConnection({ actor: ADMIN, integrationId: "demo" });
    expect(after.integration.state.source).toBe("environment");
    expect(after.integration.state.stored.activeVersion).toBeNull();
    expect(after.integration.fields.find((f) => f.key === "apiToken")?.storedSecretSet).toBe(false);
  });
});

describe("who may change an integration", () => {
  it("refuses a member, who can still read what is connected", async () => {
    await expect(
      setIntegrationEnabledState({ actor: MEMBER, integrationId: "demo", enabled: false }),
    ).rejects.toThrow(/Forbidden/);
    expect((await listIntegrations()).integrations).toHaveLength(1);
  });

  it("refuses an integration this build does not ship", async () => {
    await expect(
      setIntegrationEnabledState({ actor: ADMIN, integrationId: "nosuch", enabled: false }),
    ).rejects.toThrow(/Unknown integration/);
  });
});

describe("a deployment that does not own its database (INT-015)", () => {
  beforeEach(async () => {
    await db.execute("update env_marker set env = 'production' where id = 1");
  });

  it("says so on the list, before anybody clicks anything", async () => {
    const listed = await listIntegrations();
    expect(listed.writes.allowed).toBe(false);
    expect(listed.writes.allowed === false && listed.writes.reason).toContain("production");
  });

  it("refuses every write, naming both sides", async () => {
    await expect(save(GOOD)).rejects.toThrow(/production/);
    await expect(
      setIntegrationEnabledState({ actor: ADMIN, integrationId: "demo", enabled: false }),
    ).rejects.toThrow(/production/);
    await expect(
      disconnectIntegrationConnection({ actor: ADMIN, integrationId: "demo" }),
    ).rejects.toThrow(/production/);
  });

  it("leaves reads working, because seeing what is connected harms nobody", async () => {
    expect((await listIntegrations()).integrations[0]?.id).toBe("demo");
  });
});

describe("a database that cannot say who owns it", () => {
  it("refuses writes when no deployment ever claimed it", async () => {
    await db.execute("delete from env_marker");
    const listed = await listIntegrations();
    expect(listed.writes.allowed).toBe(false);
    expect(listed.writes.allowed === false && listed.writes.reason).toContain(
      "could not be confirmed",
    );
    await expect(save(GOOD)).rejects.toThrow(/could not be confirmed/);
  });

  it("refuses writes when the marker cannot be read at all, rather than failing opaquely", async () => {
    // A real read failure, not a mocked one: an admin whose database is down
    // must get the sentence the card can show, never a bare 500. Renamed rather
    // than dropped, and put back, because the shared test database keeps its
    // schema between tests.
    await db.execute("alter table env_marker rename to env_marker_away");
    try {
      const listed = await listIntegrations();
      expect(listed.writes.allowed).toBe(false);
      expect(listed.writes.allowed === false && listed.writes.reason).toContain(
        "could not be reached",
      );
      await expect(
        setIntegrationEnabledState({ actor: ADMIN, integrationId: "demo", enabled: false }),
      ).rejects.toThrow(/could not be confirmed/);
    } finally {
      await db.execute("alter table env_marker_away rename to env_marker");
    }
  });
});

describe("a deployment with no secrets key", () => {
  beforeEach(() => {
    delete process.env.INTEGRATION_SECRETS_KEY;
  });

  it("refuses to store a secret, naming the variable to set (INT-014)", async () => {
    await expect(save(GOOD)).rejects.toThrow(/INTEGRATION_SECRETS_KEY/);
  });

  it("leaves an environment-configured integration working (INT-014)", async () => {
    process.env.DEMO_BASE_URL = "https://demo.example/site";
    process.env.DEMO_API_TOKEN = GOOD_TOKEN;
    const state = (await listIntegrations()).integrations[0]?.state;
    expect(state?.status).toBe("connected");
    expect(state?.secretsKeyAvailable).toBe(false);
  });
});
