import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));

vi.mock("../../infra/vcs-config.js", () => ({ env: state.env }));
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

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const key of Object.keys(state.env)) delete state.env[key];
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

  it("publishes names, never values", async () => {
    Object.assign(state.env, { COLUMN_AI: "Agent" });
    vi.stubEnv("COLUMN_AI", "Agent");

    const response = await healthResponse();

    // The endpoint is reachable by anything that can curl it, and some of these
    // variables carry a token in other deployments. A serialized response must
    // not hold a single value behind a name.
    expect(JSON.stringify(response)).not.toContain("Agent");
    expect(response.settings.migratedVariablesSet).toEqual(["COLUMN_AI"]);
  });

  it("answers with an empty list once the variables are gone", async () => {
    const response = await healthResponse();

    expect(response.settings.migratedVariablesSet).toEqual([]);
    expect(response.status).toBe("ok");
    expect(response.commit).toBe("0".repeat(40));
  });
});
