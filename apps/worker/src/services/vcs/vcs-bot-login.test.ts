import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  providers: [{ kind: "github" }],
  integrations: [] as Array<{
    manifest: { id: string; capabilities: string[] };
    ctx: { connection: { botLogin?: string; legacyBotLogin?: string } };
  }>,
  integrationStates: new Map<string, { configuredFields: string[] }>(),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  getConfiguredVcsProviders: () => state.providers,
  getVcsBotLoginConfig: () => ({
    byProvider: { github: undefined },
    legacy: undefined,
  }),
}));

vi.mock("../integrations/usable.js", () => ({
  usableIntegrations: async () => state.integrations,
  resolveUsableIntegrations: async () => ({
    readable: true,
    usable: state.integrations,
    states: state.integrationStates,
  }),
}));

const { getVcsBotLogin } = await import("./vcs-bot-login.js");

describe("getVcsBotLogin", () => {
  beforeEach(() => {
    state.providers = [{ kind: "github" }];
    state.integrations = [];
    state.integrationStates = new Map();
  });

  it("does not apply the legacy login when a dashboard GitLab connection is also active", async () => {
    state.integrations = [{
      manifest: { id: "gitlab", capabilities: ["vcs"] },
      ctx: { connection: { legacyBotLogin: "dashboard-legacy-bot" } },
    }];
    state.integrationStates = new Map([
      ["gitlab", { configuredFields: ["token", "legacyBotLogin"] }],
    ]);

    await expect(getVcsBotLogin("github")).resolves.toBeUndefined();
    await expect(getVcsBotLogin("gitlab")).resolves.toBeUndefined();
  });

  it("applies the legacy login to the sole active VCS provider", async () => {
    state.providers = [];
    state.integrations = [{
      manifest: { id: "gitlab", capabilities: ["vcs"] },
      ctx: { connection: { legacyBotLogin: "dashboard-legacy-bot" } },
    }];
    state.integrationStates = new Map([
      ["gitlab", { configuredFields: ["token", "legacyBotLogin"] }],
    ]);

    await expect(getVcsBotLogin("gitlab")).resolves.toBe("dashboard-legacy-bot");
  });
});
