import { describe, expect, it, vi } from "vitest";

vi.mock("./deployment-identity.js", () => ({
  deploymentIdentity: async () => ({
    commit: "0".repeat(40),
    env: "production",
    databaseEnv: "production",
    databaseFingerprint: "abc123",
  }),
}));

const { healthResponse } = await import("./health-response.js");

describe("health response", () => {
  it("publishes deployment identity without the completed migration status", async () => {
    const response = await healthResponse();

    expect(response).toMatchObject({
      status: "ok",
      commit: "0".repeat(40),
      env: "production",
      databaseEnv: "production",
      databaseFingerprint: "abc123",
    });
    expect(response).not.toHaveProperty("settings");
  });
});
