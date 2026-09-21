import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfiguredVcsProviders: vi.fn(),
  getVcsProviderConfig: vi.fn(),
  getVcsToken: vi.fn(),
  getBotIdentity: vi.fn(),
  createVCSForRepository: vi.fn(),
  resolveUsableIntegrations: vi.fn(),
  usableIntegrations: vi.fn(async (): Promise<any[]> => []),
  checkIntegrationPin: vi.fn(),
  getVcsBotLogin: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {},
  getConfiguredVcsProviders: mocks.getConfiguredVcsProviders,
  getVcsProviderConfig: mocks.getVcsProviderConfig,
}));

vi.mock("../../adapters/vcs/github-auth.js", () => ({
  getBotIdentity: mocks.getBotIdentity,
  getVcsToken: mocks.getVcsToken,
}));

vi.mock("../../adapters/vcs/create-vcs.js", () => ({
  createVCSForRepository: mocks.createVCSForRepository,
}));

vi.mock("../integrations/runtime.js", () => ({
  resolveUsableIntegrations: mocks.resolveUsableIntegrations,
  usableIntegrations: mocks.usableIntegrations,
  checkIntegrationPin: mocks.checkIntegrationPin,
  getVcsBotLogin: mocks.getVcsBotLogin,
}));

vi.mock("../../infra/logger.js", () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}));

import { buildSandboxProviderConfigs, createRepositoryVcsRuntime } from "./vcs-runtime.js";

function usableGitLab() {
  return {
    manifest: { id: "gitlab", name: "GitLab", capabilities: ["vcs"] },
    runtime: {
      capabilities: {
        vcs: () => ({
          sandboxCredentials: async () => ({
            host: "https://gitlab.example.com",
            authUser: "oauth2",
            token: "glpat",
            commitAuthor: "ai-workflow-blazity",
            commitEmail: "ai-workflow@blazity.com",
          }),
        }),
      },
    },
    ctx: { connection: {} },
  };
}

describe("buildSandboxProviderConfigs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usableIntegrations.mockResolvedValue([]);
    mocks.createVCSForRepository.mockReturnValue({});
  });

  it("resolves commit identity only for provider kinds needed by the run", async () => {
    mocks.getConfiguredVcsProviders.mockReturnValue([
      {
        kind: "github",
        auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
        host: "https://github.com",
        legacyBaseBranch: "main",
      },
    ]);
    const gitlab = usableGitLab();
    mocks.usableIntegrations.mockResolvedValue([gitlab]);
    mocks.resolveUsableIntegrations.mockResolvedValue({
      readable: true,
      usable: [gitlab],
      states: new Map([["gitlab", { usable: true }]]),
    });
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
    const github = {
      kind: "github",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
      host: "https://github.com",
      legacyBaseBranch: "main",
    };
    mocks.getConfiguredVcsProviders.mockReturnValue([github]);
    mocks.getVcsProviderConfig.mockReturnValue(github);
    const gitlab = usableGitLab();
    mocks.usableIntegrations.mockResolvedValue([gitlab]);
    mocks.resolveUsableIntegrations.mockResolvedValue({
      readable: true,
      usable: [gitlab],
      states: new Map([["gitlab", { usable: true }]]),
    });
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

  it("memoizes the repository VCS adapter per runtime", async () => {
    const provider = {
      kind: "github",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
      host: "https://github.com",
      legacyBaseBranch: "main",
    };
    mocks.getVcsProviderConfig.mockReturnValue(provider);
    const getPRHead = vi.fn().mockResolvedValue({ headSha: "sha" });
    mocks.createVCSForRepository.mockReturnValue({ getPRHead });

    const runtime = createRepositoryVcsRuntime({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });

    await runtime.vcs.getPRHead(7);
    await runtime.vcs.getPRHead(7);
    expect(mocks.createVCSForRepository).toHaveBeenCalledTimes(1);
    expect(getPRHead).toHaveBeenCalledTimes(2);
  });

  it("refuses a later provider call when the run's connection pin was reconfigured", async () => {
    const createAdapter = vi.fn();
    mocks.resolveUsableIntegrations.mockResolvedValue({
      readable: true,
      usable: [{
        manifest: { id: "gitlab", name: "GitLab", capabilities: ["vcs"] },
        runtime: { capabilities: { vcs: createAdapter } },
        ctx: { connection: {} },
      }],
      states: new Map([["gitlab", { usable: true }]]),
    });
    mocks.checkIntegrationPin.mockReturnValue({ ok: false, reason: "reconfigured" });

    const runtime = createRepositoryVcsRuntime({
      provider: "gitlab",
      repoPath: "acme/api",
      baseBranch: "main",
      integrationPins: [{ integrationId: "gitlab", configFingerprint: "old-host" }],
    });

    await expect(runtime.vcs.findPR("ai/AIW-100")).rejects.toThrow(
      "Version control provider GitLab moved after this run started (reconfigured). Start a new run.",
    );
    expect(createAdapter).not.toHaveBeenCalled();
  });
});
