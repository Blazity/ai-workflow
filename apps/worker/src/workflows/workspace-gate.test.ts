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
  invalidateWorkspaceGate,
  recordSuccessfulWorkspaceGate,
} from "./workspace-gate.js";
import { fingerprintWorkspaceState } from "./workspace-gate-fingerprint.js";
import { recoverPrePrGateFromSteps } from "./blocks/finalize-workspace.js";

function checksStepsWithGate(
  gate: { configurationVersion: number; fingerprint: string } | null,
) {
  return {
    checks: {
      output: {
        status: "ok",
        ok: true,
        outcome: "passed",
        fixCycles: 0,
        summary: "all checks passed",
        gate,
      },
    },
  };
}

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
let untracked = new Set<string>();

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
        // Model git faithfully: tracked modifications surface under every
        // --untracked-files mode, but untracked entries only appear when the
        // caller asks for them (--untracked-files=all), never under =no.
        const lines: string[] = [];
        if (dirty.has(path)) lines.push(" M src/index.ts");
        if (untracked.has(path) && args.includes("--untracked-files=all")) {
          lines.push("?? scratch/build.log");
        }
        return commandResult(0, lines.join("\n"));
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
    untracked = new Set();
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

  it("tolerates untracked-only dirt but still fails on tracked modifications", async () => {
    // A write repo with no in-tree .gitignore (e.g. a bare GitLab repo) surfaces
    // the untracked build/test scratch that in-workspace research phases leave
    // behind. That scratch never enters the publication bundle (commit ranges
    // only), so the gate must record cleanly instead of throwing.
    untracked.add("/vercel/sandbox/repos/gitlab__acme__api");
    const gate = await recordSuccessfulWorkspaceGate({
      sandboxId: "sbx-1",
      workspaceManifest: manifest,
      configurationVersion: 7,
    });
    expect(gate).toEqual({
      configurationVersion: 7,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    // A tracked, uncommitted modification is real work that would be lost, so it
    // must still fail the gate.
    untracked.clear();
    dirty.add("/vercel/sandbox/repos/gitlab__acme__api");
    await expect(
      recordSuccessfulWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        configurationVersion: 7,
      }),
    ).rejects.toThrow("Run Workspace is not clean");
  });

  it("names the cause when the workspace cannot be inspected at the boundary", async () => {
    // A production scheduled run died here with a message that named only the
    // boundary, so the operator could not tell a vanished sandbox from an agent
    // that left work uncommitted. The distinct causes must reach the run record.
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

    dirty.add("/vercel/sandbox");
    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
      }),
    ).rejects.toMatchObject({
      code: "workspace_unverifiable",
      message: expect.stringContaining("Run Workspace is not clean"),
    });

    dirty.clear();
    manifestRaw = JSON.stringify({
      ...manifest,
      repositories: [{ ...manifest.repositories[0], repoPath: "foreign/repo" }],
    });
    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
      }),
    ).rejects.toMatchObject({
      code: "workspace_unverifiable",
      message: expect.stringContaining("does not match"),
    });
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

  it("recovers a durable checks gate and returns null when none is present", () => {
    const gate = { configurationVersion: 7, fingerprint: "abc" };
    expect(recoverPrePrGateFromSteps(checksStepsWithGate(gate))).toEqual(gate);
    // A passing checks node that recorded no gate (config absent/inapplicable).
    expect(recoverPrePrGateFromSteps(checksStepsWithGate(null))).toBeNull();
    // No checks node at all: nothing to recover.
    expect(
      recoverPrePrGateFromSteps({ research: { output: { status: "ok" } } }),
    ).toBeNull();
  });

  it("recovers the most recently completed gate when checks ran more than once", () => {
    const stale = { configurationVersion: 6, fingerprint: "stale" };
    const fresh = { configurationVersion: 7, fingerprint: "fresh" };
    // Insertion order models completion order: the fresher checks run finishes
    // last, so reverse iteration returns it, matching the hot-path ctx.prePrGate.
    const steps = {
      firstChecks: {
        output: {
          status: "ok",
          ok: true,
          outcome: "passed",
          fixCycles: 0,
          summary: "",
          gate: stale,
        },
      },
      secondChecks: {
        output: {
          status: "ok",
          ok: true,
          outcome: "passed",
          fixCycles: 0,
          summary: "",
          gate: fresh,
        },
      },
    };
    expect(recoverPrePrGateFromSteps(steps)).toEqual(fresh);
  });

  it("routes a recovered gate through the same guards: stale config version is still rejected", async () => {
    // Record a real gate, then hand it back as a durable checks output, as if
    // the heap gate was lost on a cold scheduler resume.
    const gate = await recordSuccessfulWorkspaceGate({
      sandboxId: "sbx-1",
      workspaceManifest: manifest,
      configurationVersion: 7,
    });
    const recovered = recoverPrePrGateFromSteps(checksStepsWithGate(gate));
    expect(recovered).toEqual(gate);

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
        gate: recovered,
      }),
    ).rejects.toMatchObject({ code: "configuration_changed" });
  });

  it("routes a recovered gate through the same guards: changed workspace is still rejected", async () => {
    const gate = await recordSuccessfulWorkspaceGate({
      sandboxId: "sbx-1",
      workspaceManifest: manifest,
      configurationVersion: 7,
    });
    const recovered = recoverPrePrGateFromSteps(checksStepsWithGate(gate));

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
        gate: recovered,
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
