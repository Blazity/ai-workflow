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
import {
  WORKSPACE_GATE_NOT_RECORDED_MESSAGE,
  WORKSPACE_NOT_VERIFIABLE_MESSAGE,
} from "../workflow-definition/interpreter.js";
import type { RepositoryScriptsOutput } from "./blocks/repository-scripts-output.js";
import { fingerprintWorkspaceState } from "./workspace-gate-fingerprint.js";
import { recoverPrePrGateFromSteps } from "./blocks/finalize-workspace.js";

/** The stored configuration the boundary reads to decide the gate applies. */
function configuredForAcmeWeb() {
  mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
    version: 7,
    config: {
      repositories: [{ provider: "github", repoPath: "acme/web", commands: ["pnpm test"] }],
    },
  });
}

function failure(
  overrides: Partial<RepositoryScriptsOutput["failures"][number]>,
): RepositoryScriptsOutput["failures"][number] {
  return {
    repo: "github:acme/web",
    command: "pnpm test",
    exitCode: 1,
    output: "",
    phase: null,
    ...overrides,
  };
}

/** A recovered scripts output, with only the fields the refusal reads set. */
function scriptsFailure(
  overrides: Partial<RepositoryScriptsOutput>,
): RepositoryScriptsOutput {
  return {
    ok: false,
    outcome: "failed",
    allPassed: false,
    anyFailed: true,
    groupStatuses: [],
    groupCoverage: [],
    uncoveredGroupCount: 0,
    results: [],
    failures: [],
    dirtied: [],
    setupFailed: false,
    summary: "",
    ...overrides,
  };
}

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
/** Tracked paths a dirty repository reports, so a test can pin how many of
 *  them the failure names. */
let dirtyFiles: string[] = ["src/index.ts"];

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
        if (dirty.has(path)) {
          for (const file of dirtyFiles) lines.push(` M ${file}`);
        }
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
    dirtyFiles = ["src/index.ts"];
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

  it("names the files that drifted, bounded, instead of only saying not clean", async () => {
    // The sandbox is gone by the time an operator reads this, so a message that
    // does not name the paths cannot be acted on at all. A group with
    // restoreTree false leaves tracked files behind on purpose; which files it
    // was is what separates that from work the agent never committed.
    dirty.add("/vercel/sandbox");
    dirtyFiles = ["src/index.ts", "pnpm-lock.yaml"];
    await expect(
      recordSuccessfulWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        configurationVersion: 7,
      }),
    ).rejects.toThrow(
      "Run Workspace is not clean for github:acme/web: src/index.ts, pnpm-lock.yaml",
    );
  });

  it("counts the drifted files it does not name", async () => {
    dirty.add("/vercel/sandbox");
    dirtyFiles = Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`);
    await expect(
      recordSuccessfulWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        configurationVersion: 7,
      }),
    ).rejects.toThrow(/src\/file-9\.ts and 3 more$/);
  });

  it("reports a rename by the path that exists now", async () => {
    dirty.add("/vercel/sandbox");
    dirtyFiles = ["src/old.ts -> src/new.ts"];
    await expect(
      recordSuccessfulWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        configurationVersion: 7,
      }),
    ).rejects.toThrow("not clean for github:acme/web: src/new.ts");
  });

  it("blames the repository scripts for the drift they caused, and only that", async () => {
    // The shape a restoreTree:false group leaves behind: its own commands
    // rewrote a tracked file and the agent's uncommitted work was already
    // there. Two different failures with two different fixes, and reverting
    // the second would destroy the run's output.
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
    dirtyFiles = ["src/generated.ts", "src/agent-work.ts"];

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
        dirtied: [
          {
            repo: "github:acme/web",
            files: ["src/generated.ts"],
            preExisting: ["src/agent-work.ts"],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "workspace_unverifiable",
      message:
        `${WORKSPACE_NOT_VERIFIABLE_MESSAGE} ` +
        "Run Workspace is not clean for github:acme/web: src/generated.ts, src/agent-work.ts " +
        "Repository scripts modified 1 tracked file in github:acme/web: src/generated.ts. " +
        "1 tracked file in github:acme/web was already modified before the scripts ran: " +
        "src/agent-work.ts.",
    });
  });

  it("says nothing about attribution for a run whose scripts touched nothing", async () => {
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
        dirtied: [{ repo: "github:acme/web", files: [], preExisting: [] }],
      }),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining("Repository scripts modified"),
    });
  });

  it("keeps the attribution behind the bound that clamps the git message", async () => {
    // The reason is untrusted text of unknown length. Folding the attribution
    // in front of that bound would let a long git message delete the one
    // sentence that says who dirtied the tree.
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
    dirtyFiles = Array.from({ length: 40 }, (_, index) => `src/very-long-path-${index}.ts`);

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
        dirtied: [
          {
            repo: "github:acme/web",
            files: ["src/very-long-path-0.ts"],
            preExisting: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "Repository scripts modified 1 tracked file in github:acme/web: src/very-long-path-0.ts.",
      ),
    });
  });

  it("says the gate record is missing, not that the checks could not start", async () => {
    // UP-4847: the scripts may have passed. Only the gating selection mints a
    // gate, so this fires for a run whose checks were entirely green.
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
        gate: null,
      }),
    ).rejects.toMatchObject({
      code: "missing_gate",
      message: WORKSPACE_GATE_NOT_RECORDED_MESSAGE,
    });
  });

  it("names the failing command instead of the missing record once the scripts failed", async () => {
    // The refusal lands in the SAME ticket comment as the failing commands, so
    // a sentence about the gate RECORD answers a question nobody asked: the
    // record is missing precisely because the scripts failed.
    configuredForAcmeWeb();

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
        scriptsFailure: scriptsFailure({
          failures: [failure({ command: "pnpm test", exitCode: 1 })],
        }),
      }),
    ).rejects.toMatchObject({
      code: "missing_gate",
      message:
        "Repository scripts failed, so publication was refused: github:acme/web: pnpm test (exit 1)",
    });
  });

  it("counts the failures the refusal did not name", async () => {
    configuredForAcmeWeb();

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
        scriptsFailure: scriptsFailure({
          failures: [
            failure({ command: "pnpm test", exitCode: 1 }),
            failure({ command: "pnpm lint", exitCode: 2 }),
            failure({ command: "pnpm build", exitCode: 1 }),
          ],
        }),
      }),
    ).rejects.toMatchObject({
      message:
        "Repository scripts failed, so publication was refused: github:acme/web: pnpm test (exit 1); and 2 more",
    });
  });

  it("says a stopped batch was stopped, not that it failed", async () => {
    configuredForAcmeWeb();

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
        scriptsFailure: scriptsFailure({
          failures: [
            failure({ command: "pnpm test", exitCode: -1, phase: "batch" }),
          ],
        }),
      }),
    ).rejects.toMatchObject({
      message:
        "Repository scripts were stopped before finishing, so publication was refused: " +
        "github:acme/web: pnpm test (batch stopped)",
    });
  });

  it("names a timeout as a timeout, with how long the command actually ran", async () => {
    configuredForAcmeWeb();

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
        scriptsFailure: scriptsFailure({
          failures: [failure({ command: "pnpm e2e", exitCode: 124 })],
          results: [
            {
              repo: "github:acme/web",
              command: "pnpm e2e",
              group: "checks",
              exitCode: 124,
              durationMs: 1_800_000,
              timedOut: true,
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({
      message:
        "Repository scripts timed out, so publication was refused: " +
        "github:acme/web: pnpm e2e (timed out after 30 minutes)",
    });
  });

  it("keeps the record sentence when the scripts output carries no failure", async () => {
    // outcome "failed" with no entries at all is an unreadable configuration:
    // there is no command to name, and the sentence about the record is then
    // the only true one this boundary has.
    configuredForAcmeWeb();

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
        scriptsFailure: scriptsFailure({ failures: [] }),
      }),
    ).rejects.toMatchObject({
      code: "missing_gate",
      message: WORKSPACE_GATE_NOT_RECORDED_MESSAGE,
    });
  });

  it("hands the attribution over structurally, not only inside the message", async () => {
    // Every surface downstream clamps the message. The publication boundary
    // reads this field and gives it to executionError as isolated evidence,
    // which is the only copy guaranteed to reach an operator.
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
    dirtyFiles = ["src/generated.ts"];

    await expect(
      assertCurrentWorkspaceGate({
        sandboxId: "sbx-1",
        workspaceManifest: manifest,
        gate: null,
        dirtied: [
          { repo: "github:acme/web", files: ["src/generated.ts"], preExisting: [] },
        ],
      }),
    ).rejects.toMatchObject({
      code: "workspace_unverifiable",
      attribution:
        "Repository scripts modified 1 tracked file in github:acme/web: src/generated.ts.",
      message: expect.stringContaining(WORKSPACE_NOT_VERIFIABLE_MESSAGE),
    });
  });

  it("blames the scripts for a workspace that moved after the gate was minted", async () => {
    // The likeliest single cause of a moved fingerprint is a restoreTree false
    // group, and this branch used to say only that "something" changed. The
    // attribution was wired into the not-clean branch alone.
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
        gate: { configurationVersion: 7, fingerprint: "stale-fingerprint" },
        dirtied: [
          { repo: "github:acme/web", files: ["src/generated.ts"], preExisting: [] },
        ],
      }),
    ).rejects.toMatchObject({
      code: "workspace_changed",
      attribution:
        "Repository scripts modified 1 tracked file in github:acme/web: src/generated.ts.",
      message: expect.stringContaining(
        "Repository scripts modified 1 tracked file in github:acme/web",
      ),
    });
  });

  it("names both configuration versions instead of saying only that one moved", async () => {
    // Both numbers are in hand at the compare site, and an operator told the
    // configuration moved has no other way to find out from what to what.
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
      version: 9,
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
        gate: { configurationVersion: 7, fingerprint: "fingerprint" },
        dirtied: [
          { repo: "github:acme/web", files: ["src/generated.ts"], preExisting: [] },
        ],
      }),
    ).rejects.toMatchObject({
      code: "configuration_changed",
      message: expect.stringContaining("configuration moved from v7 to v9"),
      attribution:
        "Repository scripts modified 1 tracked file in github:acme/web: src/generated.ts.",
    });
  });

  it("says nothing about scripts on either branch when none ran", async () => {
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
        gate: { configurationVersion: 7, fingerprint: "stale-fingerprint" },
      }),
    ).rejects.toMatchObject({
      code: "workspace_changed",
      // Byte for byte what it always was: no drift means no sentence, and no
      // structural cause for the boundary to promote either.
      message: "The Run Workspace changed after pre-publication checks passed.",
      attribution: undefined,
    });
  });

  it("invalidates the gate through the shared mutator API", () => {
    const state = {
      prePrGate: { configurationVersion: 7, fingerprint: "fingerprint" },
    };
    invalidateWorkspaceGate(state);
    expect(state.prePrGate).toBeNull();
  });
});
