import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resolving the version control provider a repository is on, now that every
 * provider is an integration and core has no adapter of its own left.
 *
 * The two cases that used to be different, "a provider core ships" and "a
 * provider an integration ships", are one case, which is the point of the
 * stage. What is still worth pinning here is the behaviour around that: which
 * credentials a sandbox gets, what happens when one provider is unreachable,
 * and that a run pinned to a connection it started with refuses to carry on
 * through a different one.
 */
const mocks = vi.hoisted(() => ({
  resolveUsableIntegrations: vi.fn(),
  usableIntegrations: vi.fn(async (): Promise<unknown[]> => []),
  checkIntegrationPin: vi.fn(),
  getVcsBotLogin: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));

vi.mock("../integrations/runtime.js", () => ({
  resolveUsableIntegrations: mocks.resolveUsableIntegrations,
  usableIntegrations: mocks.usableIntegrations,
  checkIntegrationPin: mocks.checkIntegrationPin,
  getVcsBotLogin: mocks.getVcsBotLogin,
}));

vi.mock("../../infra/logger.js", () => ({
  logger: { warn: mocks.loggerWarn },
}));

import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";
import { deploymentIntegrations } from "../../engine/definition/integration-availability.js";
import { integrationPinsFor } from "../../engine/definition/integration-run.js";
import {
  buildSandboxProviderConfigs,
  createRepositoryVcsRuntime,
  listVcsRepositories,
} from "./vcs-runtime.js";

function connected(
  id: string,
  adapter: Record<string, unknown>,
): Record<string, unknown> {
  return {
    manifest: { id, name: id, capabilities: ["vcs"] },
    runtime: { capabilities: { vcs: () => adapter } },
    ctx: { connection: {} },
  };
}

function resolvesTo(...entries: Array<Record<string, unknown>>): void {
  mocks.resolveUsableIntegrations.mockImplementation(
    async ({ filter }: { filter?: (manifest: { id: string }) => boolean } = {}) => {
      const usable = entries.filter(
        (entry) => !filter || filter(entry.manifest as { id: string }),
      );
      return {
        readable: true,
        usable,
        states: new Map(
          usable.map((entry) => [(entry.manifest as { id: string }).id, { usable: true }]),
        ),
      };
    },
  );
  mocks.usableIntegrations.mockResolvedValue(entries);
}

function githubLike(): Record<string, unknown> {
  return {
    sandboxCredentials: async () => ({
      host: "https://github.com",
      authUser: "x-access-token",
      token: "ghs-token",
      commitAuthor: "ai-workflow[bot]",
      commitEmail: "7+ai-workflow[bot]@users.noreply.github.com",
    }),
  };
}

describe("buildSandboxProviderConfigs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVcsBotLogin.mockResolvedValue(undefined);
  });

  it("hands a sandbox the credentials of a provider it knows nothing else about", async () => {
    // The repository path is empty here, because the caller wants the
    // connection rather than a repository. An adapter that refused an empty
    // path would leave the run with no credentials to push with and nothing
    // but a warning in a log to say why.
    resolvesTo(connected("github", githubLike()));

    const configs = await buildSandboxProviderConfigs(new Set(["github"]));

    expect(configs).toEqual([
      expect.objectContaining({
        kind: "github",
        host: "https://github.com",
        authUser: "x-access-token",
        commitAuthor: "ai-workflow[bot]",
      }),
    ]);
  });

  it("resolves only the providers the run needs", async () => {
    const unwanted = vi.fn();
    resolvesTo(
      connected("github", githubLike()),
      connected("gitlab", { sandboxCredentials: unwanted }),
    );

    const configs = await buildSandboxProviderConfigs(new Set(["github"]));

    expect(configs.map((config) => config.kind)).toEqual(["github"]);
    expect(unwanted).not.toHaveBeenCalled();
  });

  it("keeps the other providers when one cannot answer", async () => {
    resolvesTo(
      connected("github", githubLike()),
      connected("gitlab", {
        sandboxCredentials: async () => {
          throw new Error("gitlab unavailable");
        },
      }),
    );

    const configs = await buildSandboxProviderConfigs();

    expect(configs.map((config) => config.kind)).toEqual(["github"]);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gitlab", err: "gitlab unavailable" }),
      "sandbox_provider_identity_resolution_failed",
    );
  });

  it("says so when a provider ships no way to push", async () => {
    resolvesTo(connected("github", {}));

    await expect(buildSandboxProviderConfigs()).resolves.toEqual([]);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github" }),
      "sandbox_provider_identity_resolution_failed",
    );
  });
});

describe("createRepositoryVcsRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVcsBotLogin.mockResolvedValue(undefined);
  });

  it("builds the adapter once per runtime, however often it is called", async () => {
    const getPRHead = vi.fn().mockResolvedValue({ headSha: "sha" });
    const vcs = vi.fn(() => ({ getPRHead }));
    mocks.resolveUsableIntegrations.mockResolvedValue({
      readable: true,
      usable: [{
        manifest: { id: "github", name: "GitHub", capabilities: ["vcs"] },
        runtime: { capabilities: { vcs } },
        ctx: { connection: {} },
      }],
      states: new Map([["github", { usable: true }]]),
    });

    const runtime = createRepositoryVcsRuntime({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });
    await runtime.vcs.getPRHead(7);
    await runtime.vcs.getPRHead(7);

    expect(vcs).toHaveBeenCalledTimes(1);
    expect(getPRHead).toHaveBeenCalledTimes(2);
  });

  it("refuses a provider no integration in this build serves", async () => {
    resolvesTo();

    const runtime = createRepositoryVcsRuntime({
      provider: "subversion",
      repoPath: "acme/api",
      baseBranch: "main",
    });

    await expect(runtime.vcs.findPR("ai/AIW-1")).rejects.toThrow(/subversion/u);
  });

  it("refuses a later call when the connection the run pinned was reconfigured", async () => {
    const vcs = vi.fn();
    mocks.resolveUsableIntegrations.mockResolvedValue({
      readable: true,
      usable: [{
        manifest: { id: "gitlab", name: "GitLab", capabilities: ["vcs"] },
        runtime: { capabilities: { vcs } },
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
    expect(vcs).not.toHaveBeenCalled();
  });
});

/**
 * A run suspended across the deploy that widened what a run pins.
 *
 * Pins are a recorded step result and replay unchanged, so a run started on
 * the earlier build comes back holding what that build pinned. For an agent
 * plus send_message graph that was its chat provider alone. Its next version
 * control call used to read GitHub's absence from that set as GitHub having
 * moved, and stopped the run with a sentence about a change nobody made.
 */
describe("a run whose recorded pins do not name the VCS provider", () => {
  const chatOnly = [{ integrationId: "slack", configFingerprint: "workspace-1" }];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("works on the repository against the provider as it is now", async () => {
    const findPR = vi.fn().mockResolvedValue(null);
    resolvesTo(connected("github", { findPR }));

    const runtime = createRepositoryVcsRuntime({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
      integrationPins: chatOnly,
    });

    await expect(runtime.vcs.findPR("ai-workflow/aiw-1")).resolves.toBeNull();
    expect(findPR).toHaveBeenCalledTimes(1);
    expect(mocks.checkIntegrationPin).not.toHaveBeenCalled();
  });

  it("still lists that provider's repositories", async () => {
    resolvesTo(
      connected("github", {
        listRepositories: async () => [{ provider: "github", path: "acme/api" }],
      }),
    );

    const listed = await listVcsRepositories({ integrationPins: chatOnly });

    expect(listed.failures).toEqual([]);
    expect(listed.repositories).toEqual([{ provider: "github", path: "acme/api" }]);
  });

  it("compares the pin a run started today records for the same graph", async () => {
    // The other half: a run started on this build pins version control for an
    // agent block, so the same call is held to the connection it started with.
    const manifest = (id: string, capability: string): IntegrationManifest =>
      ({
        id,
        name: id,
        description: "",
        connection: { fields: [] },
        capabilities: [capability],
        blocks: [],
        pages: [],
        health: [],
      }) as unknown as IntegrationManifest;
    const state = (id: string, fingerprint: string): IntegrationState =>
      ({
        integrationId: id,
        enabled: true,
        source: "environment",
        status: "connected",
        connection: "connected",
        verification: { state: "never_tested" },
        failure: null,
        usable: true,
        environment: { setVariables: [], missingVariables: [], complete: true },
        stored: { latestVersion: 0, activeVersion: null, missingFields: [], complete: false, prepared: null },
        pin: { integrationId: id, configFingerprint: fingerprint },
        secretsKeyAvailable: true,
      }) as IntegrationState;
    const pins = integrationPinsFor(
      [{ type: "trigger_ticket_ai" }, { type: "implementation_agent" }, { type: "send_message" }],
      deploymentIntegrations({
        manifests: [manifest("github", "vcs"), manifest("slack", "messaging")],
        states: new Map([
          ["github", state("github", "app-1")],
          ["slack", state("slack", "workspace-1")],
        ]),
      }),
    );
    const findPR = vi.fn().mockResolvedValue(null);
    resolvesTo(connected("github", { findPR }));
    mocks.checkIntegrationPin.mockReturnValue({ ok: true });

    const runtime = createRepositoryVcsRuntime({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
      integrationPins: pins,
    });

    await expect(runtime.vcs.findPR("ai-workflow/aiw-1")).resolves.toBeNull();
    expect(mocks.checkIntegrationPin).toHaveBeenCalledWith(
      { integrationId: "github", configFingerprint: "app-1" },
      expect.anything(),
    );
  });
});
