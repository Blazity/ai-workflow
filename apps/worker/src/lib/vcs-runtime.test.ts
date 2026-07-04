import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfiguredVcsProviders: vi.fn(),
  getVcsToken: vi.fn(),
  getBotIdentity: vi.fn(),
}));

vi.mock("../../env.js", () => ({
  env: {},
  getConfiguredVcsProviders: mocks.getConfiguredVcsProviders,
  getVcsProviderConfig: vi.fn(),
  getVcsToken: mocks.getVcsToken,
}));

vi.mock("./github-auth.js", () => ({
  getBotIdentity: mocks.getBotIdentity,
}));

import { buildSandboxProviderConfigs } from "./vcs-runtime.js";

describe("buildSandboxProviderConfigs", () => {
  it("resolves commit identity only for provider kinds needed by the run", async () => {
    mocks.getConfiguredVcsProviders.mockReturnValue([
      {
        kind: "github",
        auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
        host: "https://github.com",
        legacyBaseBranch: "main",
      },
      {
        kind: "gitlab",
        token: "glpat",
        host: "https://gitlab.example.com",
        legacyBaseBranch: "main",
      },
    ]);
    mocks.getBotIdentity.mockRejectedValue(new Error("github identity should not be resolved"));

    const configs = await buildSandboxProviderConfigs(new Set(["gitlab"]));

    expect(configs).toEqual([
      expect.objectContaining({
        kind: "gitlab",
        host: "https://gitlab.example.com",
        commitAuthor: "ai-workflow-blazity",
        commitEmail: "ai-workflow@blazity.com",
      }),
    ]);
    expect(mocks.getBotIdentity).not.toHaveBeenCalled();
  });
});
