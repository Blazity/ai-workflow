import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "./repo-workspace.js";

const sourceRunCommand = vi.fn();
const sourceReadFileToBuffer = vi.fn();
const publisherRunCommand = vi.fn();
const publisherWriteFiles = vi.fn();
const publisherStop = vi.fn();
const sandboxCreate = vi.fn();
const getBranchSha = vi.fn();
const getToken = vi.fn();
const getPublicationAttempt = vi.fn();
const recordPreflight = vi.fn();
const recordPush = vi.fn();
const recordFailure = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({
      sandboxId: "source-sandbox",
      runCommand: sourceRunCommand,
      readFileToBuffer: sourceReadFileToBuffer,
    })),
    create: sandboxCreate,
  },
}));
vi.mock("./credentials.js", () => ({ getSandboxCredentials: () => ({ teamId: "team" }) }));
vi.mock("../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../publication/store.js", () => ({
  getPublicationAttempt,
  recordPublicationRepositoryPreflight: recordPreflight,
  recordPublicationRepositoryPush: recordPush,
  recordPublicationRepositoryFailure: recordFailure,
}));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVcsRuntime: vi.fn(() => ({
    config: {
      kind: "github",
      host: "https://github.com",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
    },
    getToken,
    vcs: { getBranchSha },
  })),
}));
vi.mock("../../env.js", () => ({ env: { JOB_TIMEOUT_MS: 120_000 } }));

import { publishTrustedWorkspaceFromSandbox } from "./trusted-workspace-publisher.js";

function command(stdout = "", stderr = "", exitCode = 0) {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

const trustedManifest: WorkspaceManifest = {
  version: 1,
  repositories: [{
    provider: "github",
    repoPath: "acme/api",
    slug: "acme__api",
    localPath: "/vercel/sandbox",
    defaultBranch: "main",
    branchName: "blazebot/aiw-100",
    selectedRationale: "ticket selected api",
    expectedRemoteSha: "remote-before",
    preAgentSha: "pre-agent",
  }],
};

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    runId: "run-1",
    blockId: "finalize",
    status: "pushing",
    failure: null,
    workspaceManifest: trustedManifest,
    repositories: [{
      provider: "github",
      repoPath: "acme/api",
      branchName: "blazebot/aiw-100",
      defaultBranch: "main",
      changed: false,
      expectedHead: null,
      targetHead: null,
      pushedHead: null,
      pr: null,
      failure: null,
    }],
    ...overrides,
  };
}

function installHappyCommands(localHead = "agent-after") {
  sourceRunCommand.mockImplementation(async (name: string, args: string[]) => {
    if (name !== "git") return command();
    if (args.includes("status")) return command();
    if (args.includes("diff")) return command();
    if (args.includes("rev-parse") && args.at(-1) === "HEAD") return command(localHead);
    if (args.includes("merge-base")) return command();
    if (args.includes("bundle") && args.includes("create")) return command();
    if (args.includes("remote")) return command("https://attacker.example/steal.git");
    return command();
  });
  sourceReadFileToBuffer.mockResolvedValue(Buffer.from("incremental-bundle"));
  publisherRunCommand.mockImplementation(async (name: string, args: string[]) => {
    if (name !== "git") return command();
    if (args.includes("rev-parse") && args.at(-1) === "HEAD") return command("remote-before");
    if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") return command(localHead);
    return command();
  });
}

describe("trusted workspace publisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandboxCreate.mockResolvedValue({
      sandboxId: "publisher-sandbox",
      runCommand: publisherRunCommand,
      writeFiles: publisherWriteFiles,
      stop: publisherStop,
    });
    publisherWriteFiles.mockResolvedValue(undefined);
    publisherStop.mockResolvedValue(undefined);
    getToken.mockResolvedValue("ghs_publisher_secret");
    getPublicationAttempt.mockResolvedValue(ledger());
    recordPreflight.mockResolvedValue(undefined);
    recordPush.mockResolvedValue(undefined);
    recordFailure.mockResolvedValue(undefined);
    getBranchSha
      .mockResolvedValueOnce("remote-before")
      .mockResolvedValueOnce("agent-after");
    installHappyCommands();
  });

  it("moves an incremental bundle into a fresh publisher and pushes only the canonical ref", async () => {
    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      publicationAttemptId: "attempt-1",
      workspaceManifest: trustedManifest,
    });

    expect(result.pushed).toBe(true);
    expect(sandboxCreate).toHaveBeenCalledWith({
      teamId: "team",
      runtime: "node24",
      timeout: 120_000,
    });
    expect(sourceRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "bundle",
      "create",
      expect.stringMatching(/^\/tmp\/aiw-publication-.+\.bundle$/),
      "HEAD",
      "^remote-before",
    ]);
    expect(publisherWriteFiles).toHaveBeenCalledWith([
      expect.objectContaining({ content: Buffer.from("incremental-bundle") }),
    ]);
    expect(publisherRunCommand).toHaveBeenCalledWith("git", expect.arrayContaining([
      "clone",
      "--branch",
      "blazebot/aiw-100",
      "https://github.com/acme/api.git",
    ]));
    expect(publisherRunCommand).toHaveBeenCalledWith("git", expect.arrayContaining([
      "push",
      "--force-with-lease=refs/heads/blazebot/aiw-100:remote-before",
      "https://github.com/acme/api.git",
      "HEAD:refs/heads/blazebot/aiw-100",
    ]));
    expect(publisherRunCommand.mock.calls.flat().join(" ")).not.toContain(
      "https://attacker.example",
    );
    expect(publisherStop).toHaveBeenCalledOnce();
    expect(getBranchSha).toHaveBeenCalledTimes(2);
  });

  it("never exposes a provider credential to a source-sandbox command", async () => {
    await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      publicationAttemptId: "attempt-1",
      workspaceManifest: trustedManifest,
    });

    const sourceArguments = JSON.stringify(sourceRunCommand.mock.calls);
    expect(sourceArguments).not.toContain("ghs_publisher_secret");
    expect(sourceArguments).not.toContain("http.extraHeader");
    expect(sourceArguments).not.toContain("fetch");
    expect(sourceArguments).not.toContain("push");
    expect(sourceArguments).not.toContain("origin");
  });

  it.each([
    ["omitted", []],
    ["injected", [
      ...ledger().repositories,
      { ...ledger().repositories[0], repoPath: "attacker/injected" },
    ]],
    ["rewritten", [{ ...ledger().repositories[0], branchName: "main" }]],
  ])("rejects a %s durable repository set before touching the source", async (_case, repositories) => {
    getPublicationAttempt.mockResolvedValue(ledger({ repositories }));

    await expect(publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      publicationAttemptId: "attempt-1",
      workspaceManifest: trustedManifest,
    })).rejects.toThrow(/ledger.*trusted workspace manifest/i);

    expect(sourceRunCommand).not.toHaveBeenCalled();
    expect(sandboxCreate).not.toHaveBeenCalled();
  });

  it("rejects a caller that rewrites the trusted publication branch to main", async () => {
    const tampered: WorkspaceManifest = {
      ...trustedManifest,
      repositories: [{ ...trustedManifest.repositories[0], branchName: "main" }],
    };

    await expect(publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      publicationAttemptId: "attempt-1",
      workspaceManifest: tampered,
    })).rejects.toThrow(/ledger.*trusted workspace manifest/i);

    expect(sourceRunCommand).not.toHaveBeenCalled();
    expect(sandboxCreate).not.toHaveBeenCalled();
  });

  it("fails before publishing when the trusted pre-agent commit is not an ancestor", async () => {
    sourceRunCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse")) return command("agent-after");
      if (args.includes("merge-base") && args.includes("pre-agent")) {
        return command("", "not an ancestor", 1);
      }
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      publicationAttemptId: "attempt-1",
      workspaceManifest: trustedManifest,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[0]).toEqual(expect.objectContaining({
      failureKind: "preflight_failed",
      error: expect.stringContaining("pre-agent"),
    }));
    expect(sandboxCreate).not.toHaveBeenCalled();
  });

  it("records an unchanged repository without creating a bundle or publisher", async () => {
    installHappyCommands("pre-agent");
    getBranchSha.mockReset().mockResolvedValue("remote-before");

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      publicationAttemptId: "attempt-1",
      workspaceManifest: trustedManifest,
    });

    expect(result.pushed).toBe(false);
    expect(result.error).toContain("no commits");
    expect(recordPreflight).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ changed: false, targetHead: "pre-agent" }),
    );
    expect(sourceRunCommand.mock.calls.some(([, args]) => args.includes("bundle"))).toBe(false);
    expect(sandboxCreate).not.toHaveBeenCalled();
  });

  it("rejects provider drift from the manager-authored remote baseline", async () => {
    getBranchSha.mockReset().mockResolvedValue("concurrent-head");

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      publicationAttemptId: "attempt-1",
      workspaceManifest: trustedManifest,
    });

    expect(result.repositories[0]).toEqual(expect.objectContaining({
      failureKind: "remote_drift",
      expectedHead: "concurrent-head",
    }));
    expect(sandboxCreate).not.toHaveBeenCalled();
  });

  it("rejects an imported bundle whose advertised target is not the source HEAD", async () => {
    publisherRunCommand.mockImplementation(async (name: string, args: string[]) => {
      if (name !== "git") return command();
      if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
        return command("remote-before");
      }
      if (args.includes("rev-parse") && args.at(-1) === "FETCH_HEAD") {
        return command("attacker-bundle-head");
      }
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      publicationAttemptId: "attempt-1",
      workspaceManifest: trustedManifest,
    });

    expect(result.repositories[0]).toEqual(expect.objectContaining({
      pushed: false,
      failureKind: "push_failed",
      error: expect.stringContaining("bundle target"),
    }));
    expect(publisherRunCommand.mock.calls.some(([, args]) => args.includes("push"))).toBe(false);
    expect(recordFailure).toHaveBeenCalled();
    expect(publisherStop).toHaveBeenCalledOnce();
  });
});
