import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "./repo-workspace.js";

const mocks = vi.hoisted(() => ({
  sourceCommand: vi.fn(),
  readBundle: vi.fn(),
  publisherCommand: vi.fn(),
  writeFiles: vi.fn(),
  stop: vi.fn(),
  createSandbox: vi.fn(),
  getBranchSha: vi.fn(),
  getPrHead: vi.fn(),
  getToken: vi.fn(),
  registerSandbox: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({
      sandboxId: "source-sandbox",
      runCommand: mocks.sourceCommand,
      readFileToBuffer: mocks.readBundle,
    })),
    create: mocks.createSandbox,
  },
}));
vi.mock("./credentials.js", () => ({ getSandboxCredentials: () => ({ teamId: "team" }) }));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVcsRuntime: vi.fn(() => ({
    config: {
      kind: "github",
      host: "https://github.com",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
    },
    getToken: mocks.getToken,
    vcs: { getBranchSha: mocks.getBranchSha, getPRHead: mocks.getPrHead },
  })),
}));
vi.mock("../../env.js", () => ({ env: { JOB_TIMEOUT_MS: 120_000 } }));
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));

import { publishTrustedWorkspaceFromSandbox } from "./trusted-workspace-publisher.js";

function command(stdout = "", stderr = "", exitCode = 0) {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

function repository(repoPath = "acme/api", localPath = "/vercel/sandbox") {
  return {
    provider: "github" as const,
    repoPath,
    slug: repoPath.replace("/", "__"),
    localPath,
    defaultBranch: "main",
    branchName: "blazebot/AIW-100",
    selectedRationale: "ticket repository",
    expectedRemoteSha: `before-${repoPath}`,
    preAgentSha: `before-${repoPath}`,
  };
}

const manifest: WorkspaceManifest = { version: 1, repositories: [repository()] };
const owner = {
  subjectKey: "ticket:jira:AIW-100",
  ownerToken: "owner-1",
  runId: "run-1",
};

function installHappyCommands(targetHead = "after") {
  mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
    if (args.includes("rev-parse")) return command(targetHead);
    return command();
  });
  mocks.readBundle.mockResolvedValue(Buffer.from("bundle"));
  mocks.publisherCommand.mockImplementation(async (_name: string, args: string[]) => {
    if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
      return command("before-acme/api");
    }
    if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
      return command(targetHead);
    }
    return command();
  });
}

describe("trusted workspace publisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSandbox.mockResolvedValue({
      sandboxId: "publisher-sandbox",
      status: "running",
      runCommand: mocks.publisherCommand,
      writeFiles: mocks.writeFiles,
      stop: mocks.stop,
    });
    mocks.writeFiles.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue({ status: "stopped" });
    mocks.getToken.mockResolvedValue("secret");
    mocks.registerSandbox.mockResolvedValue(undefined);
    mocks.getBranchSha.mockResolvedValueOnce("before-acme/api").mockResolvedValueOnce("after");
    mocks.getPrHead.mockResolvedValue({ headSha: "trigger", baseRef: "main", state: "open" });
    installHappyCommands();
  });

  it("uses exact force-with-lease arguments and canonical provider coordinates", async () => {
    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(true);
    expect(mocks.publisherCommand).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        "--force-with-lease=refs/heads/blazebot/AIW-100:before-acme/api",
        "https://github.com/acme/api.git",
        "HEAD:refs/heads/blazebot/AIW-100",
      ]),
    );
    expect(mocks.stop).toHaveBeenCalledWith({ blocking: true });
  });

  it.each([
    {
      name: "dirty worktree",
      command: (_name: string, args: string[]) =>
        Promise.resolve(args.includes("status") ? command(" M src/index.ts") : command()),
      kind: "dirty_worktree",
    },
    {
      name: "merge conflict",
      command: (_name: string, args: string[]) =>
        Promise.resolve(args.includes("diff") ? command("src/index.ts") : command()),
      kind: "merge_conflict",
    },
  ])("fails preflight for a $name before creating a publisher", async ({ command: run, kind }) => {
    mocks.sourceCommand.mockImplementation(run);
    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]?.failureKind).toBe(kind);
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("fails when the remote branch changed after workspace preparation", async () => {
    mocks.getBranchSha.mockReset().mockResolvedValue("foreign-head");
    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]).toMatchObject({ failureKind: "remote_drift" });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("preflights every publisher checkout before pushing any repository", async () => {
    const repositories = [
      repository("acme/api", "/vercel/sandbox"),
      repository("acme/web", "/vercel/sandbox/repos/github__acme__web"),
    ];
    mocks.getBranchSha.mockReset()
      .mockResolvedValueOnce("before-acme/api")
      .mockResolvedValueOnce("before-acme/web");
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse")) {
        return command(args.includes(repositories[1]!.localPath) ? "after-web" : "after-api");
      }
      return command();
    });
    mocks.publisherCommand.mockImplementation(async (_name: string, args: string[]) => {
      const second = args.some((arg) => arg.includes("/publisher/1"));
      if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
        return command(second ? "unexpected-head" : "before-acme/api");
      }
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command(second ? "after-web" : "after-api");
      }
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: { version: 1, repositories },
      ...owner,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[1]).toMatchObject({ failureKind: "remote_drift" });
    expect(
      mocks.publisherCommand.mock.calls.some(([, args]) => (args as string[]).includes("push")),
    ).toBe(false);
  });

  it("treats the exact target already on the remote as a safe Workflow replay", async () => {
    mocks.getBranchSha.mockReset().mockResolvedValue("after");
    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result).toMatchObject({ pushed: true, repositories: [{ pushedHead: "after" }] });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });
});
