import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";

const mocks = vi.hoisted(() => ({
  sandboxGet: vi.fn(),
  getDb: vi.fn(),
  getCurrentPrePrCheckConfig: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../db/client.js", () => ({ getDb: mocks.getDb }));
vi.mock("../pre-pr-checks/store.js", () => ({
  getCurrentPrePrCheckConfig: mocks.getCurrentPrePrCheckConfig,
}));

import {
  assertCurrentWorkspaceGate,
  fingerprintWorkspaceState,
  invalidateWorkspaceGate,
  recordSuccessfulWorkspaceGate,
} from "./workspace-gate.js";

const manifest: WorkspaceManifest = {
  version: 1,
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      slug: "acme__web",
      localPath: "/vercel/sandbox",
      defaultBranch: "main",
      branchName: "ai-workflow/AIW-120",
      selectedRationale: "ticket repository",
      expectedRemoteSha: "web-base",
      preAgentSha: "web-base",
    },
    {
      provider: "gitlab",
      repoPath: "acme/api",
      slug: "gitlab__acme__api",
      localPath: "/vercel/sandbox/repos/gitlab__acme__api",
      defaultBranch: "main",
      branchName: "ai-workflow/AIW-120",
      selectedRationale: "dependency",
      expectedRemoteSha: "api-base",
      preAgentSha: "api-base",
    },
  ],
};

let manifestRaw = JSON.stringify(manifest);
let heads = new Map<string, string>();
let dirty = new Set<string>();

function commandResult(exitCode: number, stdout = "", stderr = "") {
  return {
    exitCode,
    stdout: async () => stdout,
    stderr: async () => stderr,
  };
}

function sandbox() {
  return {
    runCommand: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "cat") return commandResult(0, manifestRaw);
      const path = args[1]!;
      if (args.includes("status")) {
        return commandResult(0, dirty.has(path) ? " M src/index.ts" : "");
      }
      if (args.includes("rev-parse")) {
        const head = heads.get(path);
        return head ? commandResult(0, head) : commandResult(128, "", "missing");
      }
      return commandResult(1, "", "unexpected command");
    }),
  };
}

describe("workspace gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manifestRaw = JSON.stringify(manifest);
    heads = new Map([
      ["/vercel/sandbox", "web-head"],
      ["/vercel/sandbox/repos/gitlab__acme__api", "api-base"],
    ]);
    dirty = new Set();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue(null);
    mocks.sandboxGet.mockImplementation(async () => sandbox());
  });

  it("fingerprints canonical manifest content while preserving repository order", () => {
    const reorderedKeys: WorkspaceManifest = {
      repositories: manifest.repositories.map((repo) => ({
        repoPath: repo.repoPath,
        provider: repo.provider,
        slug: repo.slug,
        localPath: repo.localPath,
        defaultBranch: repo.defaultBranch,
        branchName: repo.branchName,
        selectedRationale: repo.selectedRationale,
        expectedRemoteSha: repo.expectedRemoteSha,
        preAgentSha: repo.preAgentSha,
      })),
      version: 1,
    };
    expect(
      fingerprintWorkspaceState(manifest, ["web-head", "api-base"]),
    ).toBe(
      fingerprintWorkspaceState(reorderedKeys, ["web-head", "api-base"]),
    );

    const reversed = {
      ...manifest,
      repositories: [...manifest.repositories].reverse(),
    };
    expect(
      fingerprintWorkspaceState(reversed, ["api-base", "web-head"]),
    ).not.toBe(
      fingerprintWorkspaceState(manifest, ["web-head", "api-base"]),
    );
  });

  it("records a versioned gate only for a clean, fully inspected workspace", async () => {
    const gate = await recordSuccessfulWorkspaceGate({
      sandboxId: "sbx-1",
      workspaceManifest: manifest,
      configurationVersion: 7,
    });

    expect(gate).toEqual({
      configurationVersion: 7,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects dirty, incomplete, or tampered workspace state", async () => {
    dirty.add("/vercel/sandbox/repos/gitlab__acme__api");
    await expect(
      recordSuccessfulWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        configurationVersion: 7,
      }),
    ).rejects.toThrow("Run Workspace is not clean");

    dirty.clear();
    heads.delete("/vercel/sandbox/repos/gitlab__acme__api");
    await expect(
      recordSuccessfulWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        configurationVersion: 7,
      }),
    ).rejects.toThrow("HEAD is unavailable");

    heads.set("/vercel/sandbox/repos/gitlab__acme__api", "api-base");
    manifestRaw = JSON.stringify({
      ...manifest,
      repositories: [{ ...manifest.repositories[0], repoPath: "foreign/repo" }],
    });
    await expect(
      recordSuccessfulWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        configurationVersion: 7,
      }),
    ).rejects.toThrow("does not match");
  });

  it("does not require a gate when configuration is absent or inapplicable", async () => {
    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
      }),
    ).resolves.toEqual({
      required: false,
      reason: "missing_configuration",
      configurationVersion: null,
    });
    expect(mocks.sandboxGet).not.toHaveBeenCalled();

    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
      version: 8,
      config: {
        repositories: [{
          provider: "github",
          repoPath: "unselected/repo",
          commands: ["pnpm test"],
        }],
      },
    });
    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
      }),
    ).resolves.toEqual({
      required: false,
      reason: "no_applicable_checks",
      configurationVersion: 8,
    });
  });

  it("requires an exact configuration version and unchanged fingerprint", async () => {
    const gate = await recordSuccessfulWorkspaceGate({
      sandboxId: "sbx-1",
      workspaceManifest: manifest,
      configurationVersion: 7,
    });
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
      version: 7,
      config: {
        repositories: [{
          provider: "github",
          repoPath: "acme/web",
          commands: ["pnpm test"],
        }],
      },
    });

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate,
      }),
    ).resolves.toEqual({
      required: true,
      configurationVersion: 7,
      fingerprint: gate.fingerprint,
    });

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
      }),
    ).rejects.toMatchObject({ code: "missing_gate" });

    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
      version: 8,
      config: {
        repositories: [{
          provider: "github",
          repoPath: "acme/web",
          commands: ["pnpm test"],
        }],
      },
    });
    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate,
      }),
    ).rejects.toMatchObject({ code: "configuration_changed" });

    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
      version: 7,
      config: {
        repositories: [{
          provider: "github",
          repoPath: "acme/web",
          commands: ["pnpm test"],
        }],
      },
    });
    heads.set("/vercel/sandbox", "web-mutated");
    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate,
      }),
    ).rejects.toMatchObject({ code: "workspace_changed" });
  });

  it("invalidates the gate through the shared mutator API", () => {
    const state = {
      prePrGate: { configurationVersion: 7, fingerprint: "fingerprint" },
    };
    invalidateWorkspaceGate(state);
    expect(state.prePrGate).toBeNull();
  });
});
