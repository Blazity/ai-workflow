import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfiguredVcsProviders: vi.fn(),
  getVcsProviderConfig: vi.fn(),
  getVcsToken: vi.fn(),
  getBotIdentity: vi.fn(),
  createVCSForRepository: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../../env.js", () => ({
  env: {},
  getConfiguredVcsProviders: mocks.getConfiguredVcsProviders,
  getVcsProviderConfig: mocks.getVcsProviderConfig,
  getVcsToken: mocks.getVcsToken,
}));

vi.mock("./github-auth.js", () => ({
  getBotIdentity: mocks.getBotIdentity,
}));

vi.mock("./create-vcs.js", () => ({
  createVCSForRepository: mocks.createVCSForRepository,
}));

vi.mock("./logger.js", () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}));

import { buildSandboxProviderConfigs, createRepositoryVcsRuntime } from "./vcs-runtime.js";

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

  it("keeps other provider configs when one provider identity lookup fails", async () => {
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
    mocks.getBotIdentity.mockRejectedValue(new Error("github unavailable"));

    const configs = await buildSandboxProviderConfigs();

    expect(configs).toEqual([
      expect.objectContaining({
        kind: "gitlab",
        host: "https://gitlab.example.com",
      }),
    ]);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github", err: "github unavailable" }),
      "sandbox_provider_identity_resolution_failed",
    );
  });

  it("memoizes the repository VCS adapter per runtime", () => {
    const provider = {
      kind: "github",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
      host: "https://github.com",
      legacyBaseBranch: "main",
    };
    mocks.getVcsProviderConfig.mockReturnValue(provider);
    mocks.createVCSForRepository.mockReturnValue({ kind: "vcs" });

    const runtime = createRepositoryVcsRuntime({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });

    expect(runtime.vcs).toBe(runtime.vcs);
    expect(mocks.createVCSForRepository).toHaveBeenCalledTimes(1);
  });
});
