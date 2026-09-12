import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  rows: [] as Array<{ key: string; value: unknown }>,
  /** A database that refuses every read, the way a broken deployment does. */
  readFails: false,
  /** How many times anything asked this endpoint's path to write. */
  writes: 0,
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: state.env }));
// The real settings cluster resolves both lists; only the database underneath
// it is answered from here, so what this file asserts is what a deployment
// with these rows and this environment would actually publish.
vi.mock("../../db/repositories/settings.js", () => ({
  readAllConnectedSettings: async () => {
    if (state.readFails) throw new Error("relation \"settings\" does not exist");
    return state.rows;
  },
  importConnectedEnvironmentSettings: async () => {
    state.writes += 1;
    return [];
  },
  latestConnectedSettingsVersions: async () => [],
}));
// The two identity facts are answered next door and read the database. This
// file is about the third field, so they are stubbed to a fixed answer.
vi.mock("./deployment-identity.js", () => ({
  deploymentIdentity: async () => ({
    commit: "0".repeat(40),
    env: "production",
    databaseEnv: "production",
    databaseFingerprint: "abc123",
  }),
}));

const { healthResponse } = await import("./health-response.js");

const { resetEnvironmentSettingsImportForTest } = await import(
  "../settings/environment-import.js"
);
const { logger } = await import("../../infra/logger.js");

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const key of Object.keys(state.env)) delete state.env[key];
  state.rows = [];
  state.readFails = false;
  state.writes = 0;
  resetEnvironmentSettingsImportForTest();
});

describe("health response", () => {
  it("names the migrated variables this deployment still sets", async () => {
    Object.assign(state.env, {
      MAX_CONCURRENT_AGENTS: 7,
      COLUMN_AI: "Agent",
      DASHBOARD_ORG_SLUG: "acme",
    });
    vi.stubEnv("MAX_CONCURRENT_AGENTS", "7");
    vi.stubEnv("COLUMN_AI", "Agent");
    vi.stubEnv("DASHBOARD_ORG_SLUG", "acme");

    const response = await healthResponse();

    expect(response.settings.migratedVariablesSet).toContain("MAX_CONCURRENT_AGENTS");
    expect(response.settings.migratedVariablesSet).toContain("COLUMN_AI");
    // Marked requiresRedeploy: the deployment still reads that variable itself,
    // so asking an operator to remove it would break the deployment.
    expect(response.settings.migratedVariablesSet).not.toContain("DASHBOARD_ORG_SLUG");
  });

  it("names the ones no stored row answers for, which are the unsafe ones", async () => {
    Object.assign(state.env, { MAX_CONCURRENT_AGENTS: 7, COLUMN_AI: "Agent" });
    vi.stubEnv("MAX_CONCURRENT_AGENTS", "7");
    vi.stubEnv("COLUMN_AI", "Agent");
    state.rows = [{ key: "COLUMN_AI", value: "Agent" }];

    const response = await healthResponse();

    // Both are still set, so both are on the to-do list. Only the one nothing
    // stored is unsafe to remove, and this is read from the rows rather than
    // from the import having claimed success.
    expect(response.settings.migratedVariablesSet).toEqual(
      expect.arrayContaining(["MAX_CONCURRENT_AGENTS", "COLUMN_AI"]),
    );
    expect(response.settings.migratedVariablesUnstored).toEqual(["MAX_CONCURRENT_AGENTS"]);
  });

  it("publishes names, never values", async () => {
    Object.assign(state.env, { COLUMN_AI: "Agent" });
    vi.stubEnv("COLUMN_AI", "Agent");

    const response = await healthResponse();

    // The endpoint is reachable by anything that can curl it, and some of these
    // variables carry a token in other deployments. A serialized response must
    // not hold a single value behind a name.
    expect(JSON.stringify(response)).not.toContain("Agent");
    expect(response.settings.migratedVariablesSet).toEqual(["COLUMN_AI"]);
    expect(response.settings.migratedVariablesUnstored).toEqual(["COLUMN_AI"]);
  });

  it("keeps answering when the settings table cannot be read", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    Object.assign(state.env, { MAX_CONCURRENT_AGENTS: 7 });
    vi.stubEnv("MAX_CONCURRENT_AGENTS", "7");
    state.readFails = true;

    const response = await healthResponse();

    // /health answered before it knew anything about the database and has to
    // keep answering: a deployment too broken to read a table is exactly when
    // somebody curls this.
    expect(response.status).toBe("ok");
    expect(response.settings.migratedVariablesSet).toEqual(["MAX_CONCURRENT_AGENTS"]);
    // Null, not an empty list: empty means "all stored, remove away", and this
    // deployment has no idea whether that is true.
    expect(response.settings.migratedVariablesUnstored).toBeNull();
    expect(
      warn.mock.calls.filter((call) => call[1] === "health_settings_table_unreadable"),
    ).toHaveLength(1);
    warn.mockRestore();
  });

  it("writes nothing: the endpoint takes no authentication", async () => {
    Object.assign(state.env, { MAX_CONCURRENT_AGENTS: 7, COLUMN_AI: "Agent" });
    vi.stubEnv("MAX_CONCURRENT_AGENTS", "7");
    vi.stubEnv("COLUMN_AI", "Agent");

    const response = await healthResponse();

    // Nothing is stored, which on the authenticated paths is what triggers the
    // environment import. Anyone on the internet can call this one, so it reads
    // and reports rather than writing.
    expect(response.settings.migratedVariablesUnstored).toEqual(
      expect.arrayContaining(["MAX_CONCURRENT_AGENTS", "COLUMN_AI"]),
    );
    expect(state.writes).toBe(0);
  });

  it("answers with an empty list once the variables are gone", async () => {
    const response = await healthResponse();

    expect(response.settings.migratedVariablesSet).toEqual([]);
    expect(response.settings.migratedVariablesUnstored).toEqual([]);
    expect(response.status).toBe("ok");
    expect(response.commit).toBe("0".repeat(40));
  });
});
