import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCommand = vi.fn();
const mockStop = vi.fn();
const mockRecordPublicationRepositoryPreflight = vi.fn();
const mockRecordPublicationRepositoryPush = vi.fn();
const mockRecordPublicationRepositoryFailure = vi.fn();
const mockGetPublicationAttempt = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      status: "running",
      runCommand: mockRunCommand,
      stop: mockStop,
    })),
  },
}));

vi.mock("./credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../publication/store.js", () => ({
  getPublicationAttempt: mockGetPublicationAttempt,
  recordPublicationRepositoryPreflight: mockRecordPublicationRepositoryPreflight,
  recordPublicationRepositoryPush: mockRecordPublicationRepositoryPush,
  recordPublicationRepositoryFailure: mockRecordPublicationRepositoryFailure,
}));

type TestVcsConfig =
  | {
      kind: "github";
      auth: { appId: number; privateKeyBase64: string; installationId: number };
      repoPath: string;
      baseBranch: string;
      host: string;
    }
  | {
      kind: "gitlab";
      token: string;
      repoPath: string;
      baseBranch: string;
      host: string;
    };

const githubVcsConfig: TestVcsConfig = {
  kind: "github",
  auth: { appId: 123, privateKeyBase64: "ZmFrZS1wZW0=", installationId: 456 },
  repoPath: "test-owner/test-repo",
  baseBranch: "main",
  host: "https://github.com",
};
const gitlabVcsConfig: TestVcsConfig = {
  kind: "gitlab",
  token: "glpat_test_token",
  repoPath: "test-group/test-repo",
  baseBranch: "main",
  host: "https://gitlab.example.com",
};

vi.mock("../../env.js", () => ({
  env: { VCS_KIND: "github", GITHUB_OWNER: "test-owner", GITHUB_REPO: "test-repo" },
  getVcsProviderConfig: (provider: "github" | "gitlab") =>
    provider === "gitlab" ? gitlabVcsConfig : githubVcsConfig,
  getVcsToken: async (config: TestVcsConfig) =>
    config.kind === "gitlab" ? config.token : "ghs_test_minted_token",
}));

import {
  checkPhaseDone,
  collectPhase,
  collectPhaseOutput,
  pushWorkspaceFromSandbox,
  teardownSandbox,
  teardownSandboxes,
} from "./poll-agent.js";
import { WORKSPACE_MANIFEST_PATH, type WorkspaceManifest } from "./repo-workspace.js";

function result(stdout = "", stderr = "", exitCode = 0) {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

function workspaceRepo(
  repoPath: string,
  overrides: Partial<WorkspaceManifest["repositories"][number]> = {},
): WorkspaceManifest["repositories"][number] {
  const provider = overrides.provider ?? "github";
  return {
    provider,
    repoPath,
    slug: `${provider}__${repoPath.replace("/", "__")}`,
    localPath: `/vercel/sandbox/repos/${provider}__${repoPath.replace("/", "__")}`,
    defaultBranch: "main",
    branchName: "blazebot/task-1",
    selectedRationale: "selected",
    expectedRemoteSha: `${repoPath}-base`,
    preAgentSha: `${repoPath}-base`,
    ...overrides,
  };
}

function mockWorkspaceCommands(
  repositories: WorkspaceManifest["repositories"],
  options: {
    localHeads?: Record<string, string>;
    remoteHeads?: Record<string, string>;
    statuses?: Record<string, string>;
    conflicts?: Record<string, string>;
    pushErrors?: Record<string, string>;
    remoteHeadSequences?: Record<string, string[]>;
  } = {},
) {
  const manifest: WorkspaceManifest = { version: 1, repositories };
  mockRunCommand.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
      return result(JSON.stringify(manifest));
    }
    if (cmd !== "git") return result();
    const localPath = args[1] ?? "";
    const repo = repositories.find((candidate) => candidate.localPath === localPath);
    if (!repo) return result();
    if (args.includes("status")) return result(options.statuses?.[repo.repoPath] ?? "");
    if (args.includes("diff") && args.includes("--diff-filter=U")) {
      return result(options.conflicts?.[repo.repoPath] ?? "");
    }
    if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
      return result(options.localHeads?.[repo.repoPath] ?? `${repo.repoPath}-head`);
    }
    if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
      const sequence = options.remoteHeadSequences?.[repo.repoPath];
      if (sequence?.length) return result(sequence.shift());
      return result(options.remoteHeads?.[repo.repoPath] ?? repo.expectedRemoteSha ?? "");
    }
    if (args.includes("push")) {
      const error = options.pushErrors?.[repo.repoPath];
      return error ? result("", error, 1) : result();
    }
    return result();
  });
}

describe("pushWorkspaceFromSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPublicationAttempt.mockResolvedValue(null);
  });

  it.each([
    ["tracked", " M src/tracked.ts\n"],
    ["staged", "M  src/staged.ts\n"],
    ["untracked", "?? src/new.ts\n"],
    ["conflicted", "UU src/conflict.ts\n"],
  ])("rejects a %s worktree before any push", async (_kind, status) => {
    const repo = workspaceRepo("acme/api");
    mockWorkspaceCommands([repo], { statuses: { "acme/api": status } });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(publication.pushed).toBe(false);
    expect(publication.error).toContain("uncommitted changes");
    expect(publication.repositories[0]).toEqual(
      expect.objectContaining({ pushed: false, failureKind: "dirty_worktree" }),
    );
    expect(mockRunCommand.mock.calls.some(([, args]) => args.includes("push"))).toBe(false);
  });

  it("rejects an unmerged conflict even when porcelain output is empty", async () => {
    const repo = workspaceRepo("acme/api");
    mockWorkspaceCommands([repo], { conflicts: { "acme/api": "src/conflict.ts\n" } });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(publication.repositories[0]).toEqual(
      expect.objectContaining({ pushed: false, failureKind: "merge_conflict" }),
    );
  });

  it("preflights every repository before the first push", async () => {
    const web = workspaceRepo("acme/web");
    const api = workspaceRepo("acme/api", { provider: "gitlab" });
    mockWorkspaceCommands([web, api], { statuses: { "acme/api": "?? forgotten.txt\n" } });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(publication.pushed).toBe(false);
    expect(mockRunCommand.mock.calls.some(([, args]) => args.includes("push"))).toBe(false);
    expect(publication.repositories).toEqual([
      expect.objectContaining({ repoPath: "acme/web", pushed: false }),
      expect.objectContaining({ repoPath: "acme/api", failureKind: "dirty_worktree" }),
    ]);
  });

  it("rejects remote drift observed before publication", async () => {
    const repo = workspaceRepo("acme/api");
    mockWorkspaceCommands([repo], { remoteHeads: { "acme/api": "concurrent-head" } });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(publication.repositories[0]).toEqual(
      expect.objectContaining({
        expectedHead: "concurrent-head",
        pushed: false,
        failureKind: "remote_drift",
      }),
    );
    expect(mockRunCommand.mock.calls.some(([, args]) => args.includes("push"))).toBe(false);
  });

  it("pushes with an exact force-with-lease and records expected and pushed heads", async () => {
    const repo = workspaceRepo("acme/api");
    mockWorkspaceCommands([repo], { localHeads: { "acme/api": "local-head" } });

    const publication = await pushWorkspaceFromSandbox(
      "sbx-test-123",
      [],
      "attempt-1",
    );

    expect(publication).toEqual({
      pushed: true,
      repositories: [
        expect.objectContaining({
          repoPath: "acme/api",
          expectedHead: "acme/api-base",
          targetHead: "local-head",
          pushedHead: "local-head",
          pushed: true,
        }),
      ],
    });
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      repo.localPath,
      "-c",
      expect.stringContaining("http.extraHeader=AUTHORIZATION: Basic "),
      "push",
      "--force-with-lease=refs/heads/blazebot/task-1:acme/api-base",
      "origin",
      "HEAD:refs/heads/blazebot/task-1",
    ]);
    expect(mockRecordPublicationRepositoryPreflight).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        attemptId: "attempt-1",
        repoPath: "acme/api",
        expectedHead: "acme/api-base",
        targetHead: "local-head",
      }),
    );
    const pushCallIndex = mockRunCommand.mock.calls.findIndex(([, args]) => args.includes("push"));
    expect(mockRecordPublicationRepositoryPreflight.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunCommand.mock.invocationCallOrder[pushCallIndex]!,
    );
  });

  it("recognizes a durable target that already landed and does not push it again", async () => {
    const repo = workspaceRepo("acme/api");
    mockWorkspaceCommands([repo], {
      localHeads: { "acme/api": "local-head" },
      remoteHeads: { "acme/api": "local-head" },
    });
    mockGetPublicationAttempt.mockResolvedValue({
      id: "attempt-1",
      status: "pushing",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          changed: true,
          expectedHead: "acme/api-base",
          targetHead: "local-head",
          pushedHead: null,
        },
      ],
    });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123", [], "attempt-1");

    expect(publication).toEqual({
      pushed: true,
      repositories: [
        expect.objectContaining({
          repoPath: "acme/api",
          expectedHead: "acme/api-base",
          targetHead: "local-head",
          pushedHead: "local-head",
          pushed: true,
        }),
      ],
    });
    expect(mockRunCommand.mock.calls.some(([, args]) => args.includes("push"))).toBe(false);
    expect(mockRecordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ pushedHead: "local-head" }),
    );
  });

  it("records an already-landed repository and pushes only the remaining durable target", async () => {
    const web = workspaceRepo("acme/web");
    const api = workspaceRepo("acme/api");
    mockWorkspaceCommands([web, api], {
      localHeads: {
        "acme/web": "web-target",
        "acme/api": "api-target",
      },
      remoteHeads: {
        "acme/web": "web-target",
        "acme/api": "acme/api-base",
      },
    });
    mockGetPublicationAttempt.mockResolvedValue({
      id: "attempt-1",
      status: "pushing",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          changed: true,
          expectedHead: "acme/web-base",
          targetHead: "web-target",
          pushedHead: null,
        },
        {
          provider: "github",
          repoPath: "acme/api",
          changed: true,
          expectedHead: "acme/api-base",
          targetHead: "api-target",
          pushedHead: null,
        },
      ],
    });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123", [], "attempt-1");

    expect(publication.pushed).toBe(true);
    expect(publication.repositories).toEqual([
      expect.objectContaining({ repoPath: "acme/web", pushedHead: "web-target" }),
      expect.objectContaining({ repoPath: "acme/api", pushedHead: "api-target" }),
    ]);
    const pushCalls = mockRunCommand.mock.calls.filter(([, args]) => args.includes("push"));
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]?.[1]).toContain(api.localPath);
    expect(mockRecordPublicationRepositoryPush).toHaveBeenCalledTimes(2);
    expect(mockRecordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/web", pushedHead: "web-target" }),
    );
    expect(mockRecordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ repoPath: "acme/api", pushedHead: "api-target" }),
    );
  });

  it("treats a failed push response as success when a fresh fetch sees the target", async () => {
    const repo = workspaceRepo("acme/api");
    mockWorkspaceCommands([repo], {
      localHeads: { "acme/api": "local-head" },
      remoteHeadSequences: { "acme/api": ["acme/api-base", "local-head"] },
      pushErrors: { "acme/api": "connection reset after send" },
    });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123", [], "attempt-1");

    expect(publication).toEqual({
      pushed: true,
      repositories: [
        expect.objectContaining({
          repoPath: "acme/api",
          expectedHead: "acme/api-base",
          targetHead: "local-head",
          pushedHead: "local-head",
          pushed: true,
        }),
      ],
    });
    expect(mockRunCommand.mock.calls.filter(([, args]) => args.includes("push"))).toHaveLength(1);
    expect(mockRecordPublicationRepositoryPush).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ pushedHead: "local-head" }),
    );
  });

  it("classifies a lease rejection as terminal and never retries", async () => {
    const repo = workspaceRepo("acme/api");
    mockWorkspaceCommands([repo], { pushErrors: { "acme/api": "stale info" } });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(publication.repositories[0]).toEqual(
      expect.objectContaining({ pushed: false, failureKind: "lease_rejected" }),
    );
    const pushes = mockRunCommand.mock.calls.filter(([, args]) => args.includes("push"));
    expect(pushes).toHaveLength(1);
  });

  it("retains a successful first push when a later provider push fails", async () => {
    const web = workspaceRepo("acme/web");
    const api = workspaceRepo("acme/api", { provider: "gitlab" });
    mockWorkspaceCommands([web, api], { pushErrors: { "acme/api": "provider unavailable" } });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(publication.pushed).toBe(false);
    expect(publication.repositories).toEqual([
      expect.objectContaining({ repoPath: "acme/web", pushed: true, pushedHead: "acme/web-head" }),
      expect.objectContaining({ repoPath: "acme/api", pushed: false, error: "provider unavailable" }),
    ]);
  });

  it("returns a no-commit failure when every repository is unchanged", async () => {
    const repo = workspaceRepo("acme/api");
    mockWorkspaceCommands([repo], { localHeads: { "acme/api": "acme/api-base" } });

    const publication = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(publication.pushed).toBe(false);
    expect(publication.error).toContain("no commits");
    expect(publication.repositories[0]).toEqual(
      expect.objectContaining({ changed: false, pushed: false }),
    );
  });

  it("throws a clear error when the workspace manifest is missing", async () => {
    mockRunCommand.mockResolvedValue(result("", "not found", 1));
    await expect(pushWorkspaceFromSandbox("sbx-test-123")).rejects.toThrow(
      /workspace manifest not found/i,
    );
  });
});

describe("teardownSandbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops the sandbox", async () => {
    await teardownSandbox("sbx-test-123");
    expect(mockStop).toHaveBeenCalled();
  });

  it("does not throw on error", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    await expect(teardownSandbox("sbx-test-123")).resolves.not.toThrow();
  });
});

describe("teardownSandboxes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tears down every distinct id once, de-duplicated", async () => {
    const teardown = vi.fn().mockResolvedValue(undefined);
    await teardownSandboxes(["sbx-a", "sbx-b", "sbx-a"], teardown);
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledWith("sbx-a");
    expect(teardown).toHaveBeenCalledWith("sbx-b");
  });

  it("keeps tearing down the rest when one teardown fails (best-effort)", async () => {
    const teardown = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue(undefined);
    await expect(teardownSandboxes(["sbx-a", "sbx-b", "sbx-c"], teardown)).resolves.not.toThrow();
    expect(teardown).toHaveBeenCalledTimes(3);
  });

  it("defaults to the real teardownSandbox when no teardown is injected", async () => {
    await teardownSandboxes(["sbx-test-123"]);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});

describe("checkPhaseDone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when sentinel file exists", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe(true);
  });

  it("returns false when sentinel file is missing", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 1 });
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe(false);
  });

  it("returns stopped when the sandbox is unavailable", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe("stopped");
  });
});

describe("collectPhaseOutput", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefers stdout and falls back to stderr", async () => {
    mockRunCommand
      .mockResolvedValueOnce(result(""))
      .mockResolvedValueOnce(result("error details"));
    await expect(
      collectPhaseOutput("sbx-test-123", "/tmp/stdout", "/tmp/stderr"),
    ).resolves.toBe("error details");
  });
});

describe("collectPhase", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns raw and optional structured output", async () => {
    mockRunCommand.mockImplementation((_cmd: string, args: string[]) => {
      const file = args[0];
      const text = file.includes("stdout")
        ? "ndjson body"
        : file.includes("result")
          ? '{"result":"implemented"}'
          : "";
      return result(text);
    });
    await expect(
      collectPhase("sbx-test-123", {
        stdout: "/tmp/stdout",
        stderr: "/tmp/stderr",
        structuredOutput: "/tmp/result",
      }),
    ).resolves.toEqual({ raw: "ndjson body", structured: '{"result":"implemented"}' });
  });
});
