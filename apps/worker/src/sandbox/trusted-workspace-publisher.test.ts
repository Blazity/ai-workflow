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
  isRepoAllowed: vi.fn(),
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
  createRepositoryVcsRuntime: vi.fn((target: { provider: "github" | "gitlab" }) =>
    target.provider === "gitlab"
      ? {
          config: {
            kind: "gitlab",
            host: "https://gitlab.com",
            auth: { token: "glpat" },
          },
          getToken: async () => "gitlab-token",
          vcs: { getBranchSha: mocks.getBranchSha, getPRHead: mocks.getPrHead },
        }
      : {
          config: {
            kind: "github",
            host: "https://github.com",
            auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
          },
          getToken: mocks.getToken,
          vcs: { getBranchSha: mocks.getBranchSha, getPRHead: mocks.getPrHead },
        },
  ),
}));
vi.mock("../../env.js", () => ({ env: { JOB_TIMEOUT_MS: 120_000 } }));
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));
vi.mock("../lib/repo-allowlist.js", () => ({
  isRepoAllowed: mocks.isRepoAllowed,
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

function readRepository(repoPath = "acme/shared", localPath = "/vercel/sandbox/repos/shared") {
  return {
    ...repository(repoPath, localPath),
    access: "read" as const,
    branchName: "main",
    researchBaseSha: `before-${repoPath}`,
    expectedRemoteSha: undefined,
    preAgentSha: undefined,
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
    mocks.isRepoAllowed.mockReturnValue(true);
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

  it("rechecks the allowlist immediately before push", async () => {
    mocks.isRepoAllowed
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]).toMatchObject({
      pushed: false,
      failureKind: "preflight_failed",
    });
    const pushes = mocks.publisherCommand.mock.calls.filter(
      ([, args]) => args.includes("push"),
    );
    expect(pushes).toHaveLength(0);
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

  it("fails every publication before a push when a read-only repository changed", async () => {
    const scopedManifest: WorkspaceManifest = {
      version: 2,
      repositories: [
        { ...repository(), access: "write" },
        readRepository(),
      ],
    };
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse") && args.includes("/vercel/sandbox/repos/shared")) {
        return command("changed-shared");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: scopedManifest,
      ...owner,
    });

    expect(result.repositories[1]).toMatchObject({
      changed: true,
      failureKind: "read_only_changed",
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("ignores untracked files in a read-only repository during preflight", async () => {
    const scopedManifest: WorkspaceManifest = {
      version: 2,
      repositories: [
        { ...repository(), access: "write" },
        readRepository(),
      ],
    };
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse") && args.includes("/vercel/sandbox/repos/shared")) {
        return command("before-acme/shared");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: scopedManifest,
      ...owner,
    });

    expect(result.repositories[1]).toMatchObject({ changed: false });
    expect(result.repositories[1]?.failureKind).toBeUndefined();
    expect(result.pushed).toBe(true);
    const readStatus = mocks.sourceCommand.mock.calls.find(
      ([, args]) =>
        (args as string[]).includes("status") &&
        (args as string[]).includes("/vercel/sandbox/repos/shared"),
    );
    expect(readStatus?.[1]).toContain("--untracked-files=no");
    expect(readStatus?.[1]).not.toContain("--untracked-files=all");
  });

  it("still fails a read-only repository with tracked modifications", async () => {
    const scopedManifest: WorkspaceManifest = {
      version: 2,
      repositories: [
        { ...repository(), access: "write" },
        readRepository(),
      ],
    };
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("status") && args.includes("/vercel/sandbox/repos/shared")) {
        return command(" M src/index.ts");
      }
      if (args.includes("rev-parse") && args.includes("/vercel/sandbox/repos/shared")) {
        return command("before-acme/shared");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: scopedManifest,
      ...owner,
    });

    expect(result.repositories[1]).toMatchObject({
      changed: true,
      failureKind: "read_only_changed",
    });
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

  it("pushes a github and a gitlab write repository each with its own provider credentials", async () => {
    const githubRepo = repository("acme/api", "/vercel/sandbox");
    const gitlabRepo = {
      ...repository("acme/contracts", "/vercel/sandbox/repos/gitlab__acme__contracts"),
      provider: "gitlab" as const,
    };
    const mixedManifest: WorkspaceManifest = {
      version: 1,
      repositories: [githubRepo, gitlabRepo],
    };
    // Preflight, then post-push, once per repository in manifest order.
    mocks.getBranchSha
      .mockReset()
      .mockResolvedValueOnce("before-acme/api")
      .mockResolvedValueOnce("before-acme/contracts")
      .mockResolvedValueOnce("after-api")
      .mockResolvedValueOnce("after-contracts");
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse")) {
        return command(
          args.includes(gitlabRepo.localPath) ? "after-contracts" : "after-api",
        );
      }
      return command();
    });
    mocks.publisherCommand.mockImplementation(async (_name: string, args: string[]) => {
      const isGitlab = args.some((arg) => arg.includes("/publisher/1"));
      if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
        return command(isGitlab ? "before-acme/contracts" : "before-acme/api");
      }
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command(isGitlab ? "after-contracts" : "after-api");
      }
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: mixedManifest,
      ...owner,
    });

    const pushes = mocks.publisherCommand.mock.calls.filter(([, args]) =>
      (args as string[]).includes("push"),
    );
    const githubPush = pushes.find(([, args]) =>
      (args as string[]).includes("https://github.com/acme/api.git"),
    );
    const gitlabPush = pushes.find(([, args]) =>
      (args as string[]).includes("https://gitlab.com/acme/contracts.git"),
    );
    // Each push targets its own provider's host, force-with-lease baseline, and
    // credentials (github via x-access-token, gitlab via oauth2).
    expect(githubPush?.[1]).toEqual(
      expect.arrayContaining([
        `http.extraHeader=AUTHORIZATION: Basic ${Buffer.from("x-access-token:secret").toString("base64")}`,
        "--force-with-lease=refs/heads/blazebot/AIW-100:before-acme/api",
      ]),
    );
    expect(gitlabPush?.[1]).toEqual(
      expect.arrayContaining([
        `http.extraHeader=AUTHORIZATION: Basic ${Buffer.from("oauth2:gitlab-token").toString("base64")}`,
        "--force-with-lease=refs/heads/blazebot/AIW-100:before-acme/contracts",
      ]),
    );

    expect(result.pushed).toBe(true);
    const byPath = Object.fromEntries(
      result.repositories.map((repo) => [repo.repoPath, repo]),
    );
    expect(byPath["acme/api"]).toMatchObject({
      provider: "github",
      pushed: true,
      pushedHead: "after-api",
    });
    expect(byPath["acme/contracts"]).toMatchObject({
      provider: "gitlab",
      pushed: true,
      pushedHead: "after-contracts",
    });
  });
});
