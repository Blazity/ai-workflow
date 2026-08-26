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
vi.mock("../lib/adapters.js", () => ({
  createAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));
vi.mock("../lib/repo-allowlist.js", () => ({
  isRepoAllowed: mocks.isRepoAllowed,
  isRepoAllowedForScope: (
    repository: { provider: string; repoPath: string },
    scope?: {
      repositories?: Array<{ provider: string; repoPath: string }>;
    },
  ) =>
    mocks.isRepoAllowed(repository.repoPath) ||
    Boolean(
      scope?.repositories?.some(
        (pinned) =>
          pinned.provider === repository.provider &&
          pinned.repoPath.toLowerCase() === repository.repoPath.toLowerCase(),
      ),
    ),
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

  it("fails when the remote branch moved to a head this workspace does not contain", async () => {
    mocks.getBranchSha.mockReset().mockResolvedValue("foreign-head");
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse")) return command("after");
      // A foreign write is not reachable from the workspace HEAD.
      if (args.includes("--is-ancestor") && args.includes("foreign-head")) {
        return command("", "", 1);
      }
      return command();
    });
    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]).toMatchObject({ failureKind: "remote_drift" });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("leases the current remote head when this workspace already published it", async () => {
    // A review loop that fixes twice pushes twice from one workspace: the second
    // push sees a branch this workspace itself moved, which is not drift.
    mocks.getBranchSha
      .mockReset()
      .mockResolvedValueOnce("moved-head")
      .mockResolvedValue("after");
    mocks.publisherCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
        return command("moved-head");
      }
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command("after");
      }
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]).toMatchObject({ pushed: true, pushedHead: "after" });
    expect(mocks.publisherCommand).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        "--force-with-lease=refs/heads/blazebot/AIW-100:moved-head",
      ]),
    );
  });

  describe("a source pull request the fix agent already pushed to", () => {
    const twoRepos: WorkspaceManifest = {
      version: 1,
      repositories: [repository(), repository("acme/web", "/vercel/sandbox/repos/web")],
    };
    const sourcePullRequest = {
      provider: "github" as const,
      repoPath: "acme/api",
      prId: 7,
      headSha: "trigger",
      baseRef: "main",
    };

    beforeEach(() => {
      // acme/api already carries this workspace's head, which is what an agent
      // that committed and pushed from the sandbox leaves behind, so prepare
      // marks it pushed and only acme/web stays pending.
      mocks.getBranchSha
        .mockReset()
        .mockResolvedValueOnce("after")
        .mockResolvedValueOnce("before-acme/web")
        .mockResolvedValue("after");
      mocks.publisherCommand.mockImplementation(async (_name: string, args: string[]) => {
        if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
          return command("before-acme/web");
        }
        if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
          return command("after");
        }
        return command();
      });
    });

    it("publishes the remaining repositories instead of failing on its own push", async () => {
      mocks.getPrHead.mockResolvedValue({ headSha: "after", baseRef: "main", state: "open" });

      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: twoRepos,
        sourcePullRequest,
        ...owner,
      });

      expect(result.repositories.map((repo) => repo.failureKind)).toEqual([undefined, undefined]);
      expect(result.repositories[0]).toMatchObject({ pushed: true, pushedHead: "after" });
      expect(result.repositories[1]).toMatchObject({ pushed: true, pushedHead: "after" });
    });

    it("still refuses to publish when somebody else pushed to it", async () => {
      mocks.getPrHead.mockResolvedValue({ headSha: "foreign", baseRef: "main", state: "open" });

      await expect(
        publishTrustedWorkspaceFromSandbox({
          sourceSandboxId: "source-sandbox",
          workspaceManifest: twoRepos,
          sourcePullRequest,
          ...owner,
        }),
      ).rejects.toThrow(/stale PR\/MR head/);
    });
  });

  it("rides out a 404 on the ref read that verifies the push", async () => {
    // The push wrote refs/heads/blazebot/AIW-100 milliseconds earlier, so the
    // branch exists; a 404 here is the provider ref API lagging its own write.
    mocks.getBranchSha
      .mockReset()
      .mockResolvedValueOnce("before-acme/api")
      .mockRejectedValueOnce(Object.assign(new Error("ref read failed"), { status: 404 }))
      .mockResolvedValueOnce("after");

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result).toMatchObject({ pushed: true, repositories: [{ pushedHead: "after" }] });
    expect(mocks.getBranchSha).toHaveBeenCalledTimes(3);
  });

  it("rides out a 404 on the preflight ref read of the promoted branch", async () => {
    // GitLab reclassifies a 404 into an error that keeps only the message.
    mocks.getBranchSha
      .mockReset()
      .mockRejectedValueOnce(new Error("404 Branch Not Found"))
      .mockResolvedValueOnce("before-acme/api")
      .mockResolvedValueOnce("after");

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result).toMatchObject({ pushed: true, repositories: [{ pushedHead: "after" }] });
  });

  it("propagates a non-404 ref read failure on the first attempt", async () => {
    mocks.getBranchSha
      .mockReset()
      .mockRejectedValue(Object.assign(new Error("provider unavailable"), { status: 500 }));

    await expect(
      publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
      }),
    ).rejects.toThrow("provider unavailable");
    expect(mocks.getBranchSha).toHaveBeenCalledTimes(1);
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

  it("ignores an untracked file in a write repository and still pushes", async () => {
    // AWT-1049: the agent left a session-memory file untracked in the write
    // checkout (nondeterministic: earlier runs committed it). It cannot enter
    // the commit bundle (HEAD ^expectedRemoteSha), so publication must proceed.
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("status")) {
        return args.includes("--untracked-files=all")
          ? command("?? blazebot/memory/AWT-1049.md")
          : command();
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(true);
    expect(result.repositories[0]?.failureKind).toBeUndefined();
    const writeStatus = mocks.sourceCommand.mock.calls.find(([, args]) =>
      (args as string[]).includes("status"),
    );
    expect(writeStatus?.[1]).toContain("--untracked-files=no");
    expect(writeStatus?.[1]).not.toContain("--untracked-files=all");
  });

  it("refuses to publish a memory document the base commit did not track", async () => {
    // The last line of defense: excludes and the pre-commit hook can both be
    // bypassed (--no-verify, core.hooksPath), the publication boundary cannot.
    // Absent from both the recorded baseline and the fresh default-branch tip:
    // the fallback fetch runs and still rejects.
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("blazebot/memory/AIW-100.md\n");
      }
      if (args.includes("ls-tree")) return command("");
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command("base-branch-tip");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[0]).toMatchObject({
      failureKind: "preflight_failed",
      error:
        "platform memory is platform-managed and must not be published: blazebot/memory/AIW-100.md was added in before-acme/api..after",
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("refuses to publish a document added under the new ai-workflow/memory directory", async () => {
    // The new write directory is gated exactly like the legacy one: a document
    // the base commit did not track is rejected at the publication boundary.
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("ai-workflow/memory/")) {
        return command("ai-workflow/memory/AIW-100.md\n");
      }
      if (args.includes("ls-tree")) return command("");
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command("base-branch-tip");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[0]).toMatchObject({
      failureKind: "preflight_failed",
      error:
        "platform memory is platform-managed and must not be published: ai-workflow/memory/AIW-100.md was added in before-acme/api..after",
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("publishes a memory document merged in from the base branch (leak-neutral)", async () => {
    // The recorded baseSha predates the local base merge, so a legacy document
    // carried in by merging the base branch looks added against it. It is absent
    // from baseSha but present on the fresh default-branch tip, so it is already
    // public and must publish. (Reproduces the blocked-legit-publication bug.)
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("blazebot/memory/legacy.md\n");
      }
      if (args.includes("ls-tree")) {
        return args.includes("before-acme/api")
          ? command("")
          : command("blazebot/memory/legacy.md\n");
      }
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command("base-branch-tip");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(true);
    expect(result.repositories[0]?.failureKind).toBeUndefined();
  });

  it("still rejects a memory document the agent added", async () => {
    // Absent from the recorded baseline and from the fresh default-branch tip:
    // the fallback fetch runs, confirms it is not public, and still rejects.
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("blazebot/memory/AIW-100.md\n");
      }
      if (args.includes("ls-tree")) return command("");
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command("base-branch-tip");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[0]).toMatchObject({
      failureKind: "preflight_failed",
      error:
        "platform memory is platform-managed and must not be published: blazebot/memory/AIW-100.md was added in before-acme/api..after",
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    // The fallback fetch actually ran against the fresh default branch.
    expect(
      mocks.sourceCommand.mock.calls.some(([, args]) => (args as string[]).includes("fetch")),
    ).toBe(true);
  });

  it("fails when the base-branch fallback fetch cannot run", async () => {
    // Fail-closed: a path absent from the baseline whose default-branch tip
    // cannot be fetched must not be waved through.
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("blazebot/memory/AIW-100.md\n");
      }
      if (args.includes("fetch")) return command("", "network down", 128);
      if (args.includes("ls-tree")) return command("");
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[0]).toMatchObject({
      failureKind: "preflight_failed",
      error:
        "memory publication check failed: unable to verify main for blazebot/memory/AIW-100.md",
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("fetches the repository default branch with canonical credentials for the fallback", async () => {
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("blazebot/memory/legacy.md\n");
      }
      if (args.includes("ls-tree")) {
        return args.includes("before-acme/api")
          ? command("")
          : command("blazebot/memory/legacy.md\n");
      }
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command("base-branch-tip");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    // The fallback fetches repo.defaultBranch (not branchName or mergeBase) from
    // the canonical clone URL with x-access-token credentials.
    const fetchCall = mocks.sourceCommand.mock.calls.find(([, args]) =>
      (args as string[]).includes("fetch"),
    );
    expect(fetchCall?.[1]).toEqual([
      "-C",
      "/vercel/sandbox",
      "-c",
      `http.extraHeader=AUTHORIZATION: Basic ${Buffer.from("x-access-token:secret").toString("base64")}`,
      "fetch",
      "--no-tags",
      "https://github.com/acme/api.git",
      "main",
    ]);
  });

  it("does not fetch or request a token when a flagged memory path is baseline-tracked", async () => {
    // Legacy tracked: the first ls-tree answers, so the default-branch fallback
    // never runs. Replay coordinates keep the publisher out, so no token either.
    mocks.getBranchSha.mockReset().mockResolvedValue("after");
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("blazebot/memory/legacy.md\n");
      }
      if (args.includes("ls-tree")) return command("blazebot/memory/legacy.md\n");
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(true);
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(
      mocks.sourceCommand.mock.calls.some(([, args]) => (args as string[]).includes("fetch")),
    ).toBe(false);
  });

  it("publishes a modification to a memory document the base commit tracks", async () => {
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("blazebot/memory/AIW-100.md\n");
      }
      if (args.includes("ls-tree")) return command("blazebot/memory/AIW-100.md\n");
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(true);
    expect(result.repositories[0]?.failureKind).toBeUndefined();
  });

  it("publishes a deletion of a memory document the base commit tracks", async () => {
    // A deletion is reported by the same diff, and ls-tree of the base still
    // answers, so a legacy cleanup commit keeps publishing.
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("blazebot/memory/legacy.md\n");
      }
      if (args.includes("ls-tree")) return command("blazebot/memory/legacy.md\n");
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(true);
    expect(result.repositories[0]?.failureKind).toBeUndefined();
  });

  it("refuses to publish a memory document added and deleted inside the range", async () => {
    // The tree diff of base..head sees nothing, but the blob still ships in the
    // published commits, so the added-path log is what catches it. Absent from
    // both the baseline and the fresh default-branch tip, so it still rejects.
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("");
      }
      if (args.includes("log") && args.includes("blazebot/memory/")) {
        return command("\nblazebot/memory/AIW-100.md\n");
      }
      if (args.includes("ls-tree")) return command("");
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command("base-branch-tip");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[0]).toMatchObject({
      failureKind: "preflight_failed",
      error:
        "platform memory is platform-managed and must not be published: blazebot/memory/AIW-100.md was added in before-acme/api..after",
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("publishes a base-tracked memory path that the range deleted and re-added", async () => {
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("blazebot/memory/")) {
        return command("blazebot/memory/legacy.md\n");
      }
      if (args.includes("ls-tree")) return command("blazebot/memory/legacy.md\n");
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(true);
    expect(result.repositories[0]?.failureKind).toBeUndefined();
    // Both enumerations named the same path, and it is probed once.
    expect(
      mocks.sourceCommand.mock.calls.filter(([, args]) =>
        (args as string[]).includes("ls-tree"),
      ),
    ).toHaveLength(1);
  });

  it("fails the repository when the per-path memory probe cannot run", async () => {
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("blazebot/memory/")) {
        return command("blazebot/memory/AIW-100.md\n");
      }
      if (args.includes("ls-tree")) return command("", "bad object", 128);
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]).toMatchObject({
      failureKind: "preflight_failed",
      error:
        "memory publication check failed for blazebot/memory/AIW-100.md: bad object",
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("enumerates the range twice and probes nothing when no memory path changed", async () => {
    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.pushed).toBe(true);
    const memoryCalls = mocks.sourceCommand.mock.calls.filter(
      ([name, args]) => name === "git" && (args as string[]).includes("blazebot/memory/"),
    );
    expect(memoryCalls.map(([, args]) => args)).toEqual([
      [
        "-C",
        "/vercel/sandbox",
        "diff",
        "--name-only",
        "before-acme/api..after",
        "--",
        "ai-workflow/memory/",
        "blazebot/memory/",
      ],
      [
        "-C",
        "/vercel/sandbox",
        "log",
        "--diff-filter=A",
        "--name-only",
        "--pretty=format:",
        "before-acme/api..after",
        "--",
        "ai-workflow/memory/",
        "blazebot/memory/",
      ],
    ]);
    expect(
      mocks.sourceCommand.mock.calls.some(([, args]) =>
        (args as string[]).includes("ls-tree"),
      ),
    ).toBe(false);
  });

  it("skips the memory gate entirely when the source head is the baseline", async () => {
    installHappyCommands("before-acme/api");

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]).toMatchObject({ changed: false });
    expect(
      mocks.sourceCommand.mock.calls.some(([, args]) =>
        (args as string[]).includes("blazebot/memory/"),
      ),
    ).toBe(false);
  });

  it("never runs the memory gate against a read-only repository", async () => {
    const scopedManifest: WorkspaceManifest = {
      version: 2,
      repositories: [{ ...repository(), access: "write" }, readRepository()],
    };
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse") && args.includes("/vercel/sandbox/repos/shared")) {
        return command("before-acme/shared");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: scopedManifest,
      ...owner,
    });

    const memoryCalls = mocks.sourceCommand.mock.calls.filter(([, args]) =>
      (args as string[]).includes("blazebot/memory/"),
    );
    expect(memoryCalls).toHaveLength(2);
    for (const [, args] of memoryCalls) {
      expect(args as string[]).toContain("/vercel/sandbox");
      expect(args as string[]).not.toContain("/vercel/sandbox/repos/shared");
    }
  });

  it("fails the repository when the memory publication check cannot run", async () => {
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("diff") && args.includes("blazebot/memory/")) {
        return command("", "bad revision", 128);
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]).toMatchObject({
      failureKind: "preflight_failed",
      error: "memory publication check failed: bad revision",
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("still fails a write repository with a tracked modification before push", async () => {
    mocks.sourceCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("status")) return command(" M src/index.ts");
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: manifest,
      ...owner,
    });

    expect(result.repositories[0]).toMatchObject({ failureKind: "dirty_worktree" });
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

  describe("review ledger narrows the no-commit guard", () => {
    // No commits from the agent: source HEAD never moved past the pre-agent
    // baseline, so the preflight loop returns early without ever creating a
    // publisher sandbox (mirrors the "safe Workflow replay" no-op path above).
    function noAgentCommits() {
      installHappyCommands("before-acme/api");
    }

    it("accepts zero commits when every work item was already addressed or a question", async () => {
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          workItems: [
            { alias: "T1", threadId: "d1" },
            { alias: "T2", threadId: "d2" },
          ],
          acceptedAliases: ["T1", "T2"],
          actionableAliases: [],
          rejectedCount: 0,
          truncated: 0,
          declaredWrites: false,
        },
      });

      expect(result).toMatchObject({ pushed: true });
      expect(result.error).toBeUndefined();
      expect(result.repositories.every((repository) => !repository.pushed)).toBe(true);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    });

    it("errors, naming the actionable alias, when an accepted disposition is actionable", async () => {
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          // No matching work item entry: the alias falls back to a bare name.
          workItems: [],
          acceptedAliases: ["T2"],
          actionableAliases: ["T2"],
          rejectedCount: 0,
          truncated: 0,
          declaredWrites: false,
        },
      });

      expect(result.pushed).toBe(false);
      expect(result.error).toBe(
        "Agent marked review threads T2 as actionable but made no commits",
      );
    });

    it("names every actionable alias, in summary order, when there is more than one", async () => {
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          workItems: [],
          acceptedAliases: ["T1", "T3"],
          actionableAliases: ["T1", "T3"],
          rejectedCount: 0,
          truncated: 0,
          declaredWrites: false,
        },
      });

      expect(result.pushed).toBe(false);
      expect(result.error).toBe(
        "Agent marked review threads T1, T3 as actionable but made no commits",
      );
    });

    it("names an actionable alias with its file and line, and another with a general-comment marker", async () => {
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          workItems: [
            { alias: "T1", threadId: "d1", filePath: "src/foo.ts", line: 42 },
            { alias: "T3", threadId: "d3" },
          ],
          acceptedAliases: ["T1", "T3"],
          actionableAliases: ["T1", "T3"],
          rejectedCount: 0,
          truncated: 0,
          declaredWrites: false,
        },
      });

      expect(result.pushed).toBe(false);
      expect(result.error).toBe(
        "Agent marked review threads T1 (src/foo.ts:42), T3 (general comment) as actionable but made no commits",
      );
    });

    it("keeps today's no-commit error when the guard summary has zero work items", async () => {
      // A feed made only of third-party bot threads is exactly what produces
      // an empty workItems array upstream (selectWorkItems in review-ledger.ts
      // excludes them before the summary ever reaches this guard), so this
      // also covers that case at this seam.
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          workItems: [],
          acceptedAliases: [],
          actionableAliases: [],
          rejectedCount: 0,
          truncated: 0,
          declaredWrites: false,
        },
      });

      expect(result.pushed).toBe(false);
      expect(result.error).toBe("Agent reported success but made no commits");
    });

    it("keeps today's no-commit error when verification rejected a disposition", async () => {
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          workItems: [{ alias: "T1", threadId: "d1" }],
          acceptedAliases: [],
          actionableAliases: [],
          rejectedCount: 1,
          truncated: 0,
          declaredWrites: false,
        },
      });

      expect(result.pushed).toBe(false);
      expect(result.error).toBe("Agent reported success but made no commits");
    });

    it("keeps today's no-commit error when the feed was truncated", async () => {
      // The guard must not vouch for a snapshot it knows is incomplete.
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          workItems: [{ alias: "T1", threadId: "d1" }],
          acceptedAliases: ["T1"],
          actionableAliases: [],
          rejectedCount: 0,
          truncated: 1,
          declaredWrites: false,
        },
      });

      expect(result.pushed).toBe(false);
      expect(result.error).toBe("Agent reported success but made no commits");
    });

    it("keeps today's no-commit error when the agent declared it intended to write code", async () => {
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          workItems: [{ alias: "T1", threadId: "d1" }],
          acceptedAliases: ["T1"],
          actionableAliases: [],
          rejectedCount: 0,
          truncated: 0,
          declaredWrites: true,
        },
      });

      expect(result.pushed).toBe(false);
      expect(result.error).toBe("Agent reported success but made no commits");
    });

    it("keeps today's no-commit error when a work item was never covered by verification", async () => {
      noAgentCommits();
      const result = await publishTrustedWorkspaceFromSandbox({
        sourceSandboxId: "source-sandbox",
        workspaceManifest: manifest,
        ...owner,
        reviewLedger: {
          workItems: [
            { alias: "T1", threadId: "d1" },
            { alias: "T2", threadId: "d2" },
          ],
          // T2 is missing: verification did not cover the exact work-item set.
          acceptedAliases: ["T1"],
          actionableAliases: [],
          rejectedCount: 0,
          truncated: 0,
          declaredWrites: false,
        },
      });

      expect(result.pushed).toBe(false);
      expect(result.error).toBe("Agent reported success but made no commits");
    });
  });
});
