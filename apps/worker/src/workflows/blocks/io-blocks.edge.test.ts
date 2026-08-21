import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One consolidated file per the task constraints (single new test file, no edits
// elsewhere). All the module mocks below form a superset shared by every block
// executor and repository adapter exercised here; repo-allowlist.js is left REAL
// so process.env.AGENT_ALLOWED_REPOS drives the actual guard/filter.
const mocks = vi.hoisted(() => ({
  postComment: vi.fn(),
  createRepositoryVCS: vi.fn(),
  getDb: vi.fn(),
  listWorkflowOwnedBranchesForTicket: vi.fn(),
  upsertWorkflowOwnedBranch: vi.fn(),
  finalizeWorkspacePublication: vi.fn(),
  sandboxGet: vi.fn(),
  loadPrePrCheckConfigStep: vi.fn(),
  runPrePrChecksWithFixes: vi.fn(),
  resolvePhaseStall: vi.fn(),
  listWorkspaceRepositoriesStep: vi.fn(),
  startRepoCheckBatchStep: vi.fn(),
  collectRepoCheckBatchStep: vi.fn(),
  pollPhaseUntilDone: vi.fn(),
  loggerWarn: vi.fn(),
  buildOctokit: vi.fn(),
  assertActiveRunOwner: vi.fn(),
}));

vi.mock("../../lib/adapters.js", () => ({
  createAdapters: () => ({ issueTracker: { postComment: mocks.postComment } }),
}));
vi.mock("../../lib/vcs-runtime.js", () => ({ createRepositoryVCS: mocks.createRepositoryVCS }));
vi.mock("../../db/client.js", () => ({ getDb: mocks.getDb }));
vi.mock("../../db/queries/workflow-owned-branches.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
  upsertWorkflowOwnedBranch: mocks.upsertWorkflowOwnedBranch,
}));
vi.mock("../workspace-publication.js", () => ({
  finalizeWorkspacePublication: mocks.finalizeWorkspacePublication,
}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("./pre-pr-checks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pre-pr-checks.js")>()),
  loadPrePrCheckConfigStep: mocks.loadPrePrCheckConfigStep,
  runPrePrChecksWithFixes: mocks.runPrePrChecksWithFixes,
  resolvePhaseStall: mocks.resolvePhaseStall,
}));
// run_checks drives these steps on its explicit-commands path; both of its
// modes launch detached and poll, so neither runs a command inline any more.
// Only the steps are replaced: the derived cap, the output bounding and the
// stall sentence stay real.
vi.mock("../../pre-pr-checks/runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pre-pr-checks/runner.js")>()),
  listWorkspaceRepositoriesStep: mocks.listWorkspaceRepositoriesStep,
  startRepoCheckBatchStep: mocks.startRepoCheckBatchStep,
  collectRepoCheckBatchStep: mocks.collectRepoCheckBatchStep,
}));
vi.mock("./poll-phase.js", () => ({ pollPhaseUntilDone: mocks.pollPhaseUntilDone }));
vi.mock("../../lib/logger.js", () => ({
  logger: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/github-auth.js", () => ({ buildOctokit: mocks.buildOctokit }));
vi.mock("../../lib/active-run-owner.js", () => ({
  assertActiveRunOwner: (...args: any[]) => mocks.assertActiveRunOwner(...args),
}));

import type {
  WorkspaceManifest,
  WorkspaceRepositoryInput,
} from "../../sandbox/repo-workspace.js";
import { emptyPrePrCheckConfig } from "../../pre-pr-checks/config.js";
import { isRepoAllowed, filterAllowedRepositories } from "../../lib/repo-allowlist.js";
import { AI_WORKFLOW_COMMENT_MARKER } from "../../lib/vcs-bot-identity.js";
import {
  createRepositoryDirectory,
  createRepositoryDirectoryForProviders,
} from "../../adapters/vcs/repository-directory.js";
import { createOrFindWorkflowOwnedPullRequest } from "../repository-prs.js";
import type { WorkspacePublicationResult } from "../workspace-publication.js";
import { execute as executeFetchPrContext } from "./fetch-pr-context.js";
import { execute as executeFinalizeWorkspace } from "./finalize-workspace.js";
import { execute as executePostPrComment } from "./post-pr-comment.js";
import { execute as executePostTicketComment } from "./post-ticket-comment.js";
import { execute as executeRunChecks } from "./run-checks.js";
import { makeCtx, makeNode, makePrPayload } from "./test-support.js";

// AGENT_ALLOWED_REPOS is unset globally. Restore after every test so a value set
// by one test never leaks into another (which would break the no-op assumption).
const ORIGINAL_ALLOWED_REPOS = process.env.AGENT_ALLOWED_REPOS;
const activeOwner = {
  subjectKey: "ticket:jira:AWT-1",
  ownerToken: "owner-1",
  runId: "run-1",
};

const marked = (body: string) => `${body}\n\n${AI_WORKFLOW_COMMENT_MARKER}`;

function setAllowlist(value: string | undefined): void {
  if (value === undefined) delete process.env.AGENT_ALLOWED_REPOS;
  else process.env.AGENT_ALLOWED_REPOS = value;
}

afterEach(() => {
  setAllowlist(ORIGINAL_ALLOWED_REPOS);
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// repo-allowlist.ts: isRepoAllowed (real, env-driven)
// ---------------------------------------------------------------------------
describe("isRepoAllowed", () => {
  it("allows any repo when AGENT_ALLOWED_REPOS is unset", () => {
    setAllowlist(undefined);
    expect(isRepoAllowed("acme/anything")).toBe(true);
  });

  it("allows all when AGENT_ALLOWED_REPOS is an empty string", () => {
    setAllowlist("");
    expect(isRepoAllowed("x/y")).toBe(true);
  });

  it("allows all when the allowlist is whitespace/comma-only (misconfig is a no-op)", () => {
    setAllowlist(" , , ");
    expect(isRepoAllowed("acme/off")).toBe(true);
  });

  it("returns true for an exact on-list match", () => {
    setAllowlist("acme/api");
    expect(isRepoAllowed("acme/api")).toBe(true);
  });

  it("matches case-insensitively in both directions", () => {
    setAllowlist("ACME/API");
    expect(isRepoAllowed("acme/api")).toBe(true);
    setAllowlist("acme/api");
    expect(isRepoAllowed("Acme/API")).toBe(true);
  });

  it("returns false for an off-list repo", () => {
    setAllowlist("acme/api");
    expect(isRepoAllowed("acme/web")).toBe(false);
  });

  it("parses multiple entries with whitespace and a trailing comma", () => {
    setAllowlist("acme/api, acme/web,");
    expect(isRepoAllowed("acme/web")).toBe(true);
    expect(isRepoAllowed("acme/api")).toBe(true);
    expect(isRepoAllowed("acme/other")).toBe(false);
  });

  it("does not trim the query argument (only lowercases it)", () => {
    setAllowlist("acme/api");
    expect(isRepoAllowed(" acme/api")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// repo-allowlist.ts: filterAllowedRepositories (real, env-driven)
// ---------------------------------------------------------------------------
describe("filterAllowedRepositories", () => {
  it("returns the input unchanged (same reference) when unset", () => {
    setAllowlist(undefined);
    const list = [{ repoPath: "acme/api" }, { repoPath: "acme/web" }];
    expect(filterAllowedRepositories(list)).toBe(list);
  });

  it("drops off-list entries, preserving order and extra fields", () => {
    setAllowlist("acme/api");
    const result = filterAllowedRepositories([
      { repoPath: "acme/api", x: 1 },
      { repoPath: "acme/web", x: 2 },
    ]);
    expect(result).toEqual([{ repoPath: "acme/api", x: 1 }]);
  });

  it("keeps a case-differing on-list entry", () => {
    setAllowlist("acme/api");
    const result = filterAllowedRepositories([
      { repoPath: "Acme/API" },
      { repoPath: "Other/Repo" },
    ]);
    expect(result).toEqual([{ repoPath: "Acme/API" }]);
  });

  it("returns an empty array when the list matches nothing", () => {
    setAllowlist("acme/none");
    expect(filterAllowedRepositories([{ repoPath: "acme/api" }, { repoPath: "acme/web" }])).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// repository-directory.ts: allowlist applied to normalized listings
// ---------------------------------------------------------------------------
describe("repository directory allowlist", () => {
  const mockFetch = vi.fn();

  function gitLabResponse(body: unknown, headers: Record<string, string> = {}) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(headers),
      json: vi.fn().mockResolvedValue(body),
    };
  }

  const githubConfig = {
    kind: "github" as const,
    auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
    repoPath: "default/repo",
    baseBranch: "main",
    host: "https://github.com",
  };
  const gitlabConfig = {
    kind: "gitlab" as const,
    token: "glpat",
    repoPath: "default/repo",
    baseBranch: "main",
    host: "https://gitlab.example.com",
  };

  function octokitReturning(fullNames: string[]) {
    return {
      apps: { listReposAccessibleToInstallation: vi.fn() },
      paginate: vi.fn().mockResolvedValue(fullNames.map((full_name) => ({ full_name }))),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    mocks.buildOctokit.mockReturnValue(octokitReturning([]));
  });

  it("returns the complete normalized GitHub catalog independently of the runtime allowlist", async () => {
    setAllowlist("acme/api");
    mocks.buildOctokit.mockReturnValue(octokitReturning(["acme/api", "acme/web"]));

    const result = await createRepositoryDirectory(githubConfig).listRepositories();

    expect(result.map((r) => r.repoPath)).toEqual(["acme/api", "acme/web"]);
  });

  it("preserves GitHub path casing in the complete catalog", async () => {
    setAllowlist("acme/api");
    mocks.buildOctokit.mockReturnValue(octokitReturning(["Acme/API", "other/repo"]));

    const result = await createRepositoryDirectory(githubConfig).listRepositories();

    expect(result.map((r) => r.repoPath)).toEqual(["Acme/API", "other/repo"]);
  });

  it("returns the complete normalized GitLab catalog independently of the runtime allowlist", async () => {
    setAllowlist("acme/api");
    mockFetch.mockResolvedValueOnce(
      gitLabResponse([{ path_with_namespace: "acme/api" }, { path_with_namespace: "acme/web" }], {
        "x-next-page": "",
      }),
    );

    const result = await createRepositoryDirectory(gitlabConfig).listRepositories();

    expect(result.map((r) => r.repoPath)).toEqual(["acme/api", "acme/web"]);
  });

  it("merges complete catalogs from every configured provider", async () => {
    setAllowlist("acme/api");
    mocks.buildOctokit.mockReturnValue(octokitReturning(["acme/web"]));
    mockFetch.mockResolvedValueOnce(
      gitLabResponse([{ path_with_namespace: "acme/api" }], { "x-next-page": "" }),
    );

    const directory = createRepositoryDirectoryForProviders([
      { kind: "github", auth: githubConfig.auth, host: "https://github.com", legacyBaseBranch: "main" },
      { kind: "gitlab", token: "glpat", host: "https://gitlab.example.com", legacyBaseBranch: "main" },
    ]);

    const result = await directory.listRepositories();

    expect(result).toEqual([
      expect.objectContaining({ provider: "github", repoPath: "acme/web" }),
      expect.objectContaining({ provider: "gitlab", repoPath: "acme/api" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// repository-prs.ts: allowlist guards (real repo-allowlist, mocked db/vcs)
// ---------------------------------------------------------------------------
describe("repository-prs allowlist guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.assertActiveRunOwner.mockResolvedValue(undefined);
  });

  it("refuses to open a PR on an off-list repo without calling the provider", async () => {
    setAllowlist("acme/allowed");
    const createPR = vi.fn();
    const findPR = vi.fn();
    mocks.createRepositoryVCS.mockReturnValue({ createPR, findPR });

    await expect(
      createOrFindWorkflowOwnedPullRequest({
        branchName: "blazebot/awt-1",
        repository: {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "x",
          workflowOwnedBranch: { branchName: "blazebot/awt-1" },
        },
        title: "Fix API",
        body: "",
        owner: activeOwner,
      }),
    ).rejects.toThrow("Refusing to open a PR on acme/api");

    expect(createPR).not.toHaveBeenCalled();
    expect(findPR).not.toHaveBeenCalled();
    expect(mocks.upsertWorkflowOwnedBranch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// post_ticket_comment: edge cases
// ---------------------------------------------------------------------------
describe("post_ticket_comment edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns commentUrl null when the tracker has no deep link", async () => {
    mocks.postComment.mockResolvedValue(null);

    const result = await executePostTicketComment(
      makeNode("post_ticket_comment", { body: "Done." }),
      {},
      makeCtx(),
    );

    expect(result).toEqual({ kind: "next", output: { status: "ok", commentUrl: null } });
  });

  it("fails on a whitespace-only body without posting", async () => {
    const result = await executePostTicketComment(
      makeNode("post_ticket_comment", { body: "   " }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toContain("requires a body");
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("trims the body before posting", async () => {
    mocks.postComment.mockResolvedValue("https://jira/comment");

    await executePostTicketComment(
      makeNode("post_ticket_comment", { body: "  Done.  " }),
      {},
      makeCtx(),
    );

    expect(mocks.postComment).toHaveBeenCalledWith("AWT-1", "Done.");
  });
});

// ---------------------------------------------------------------------------
// post_pr_comment: edge cases
// ---------------------------------------------------------------------------
describe("post_pr_comment edge cases", () => {
  function publication(): WorkspacePublicationResult {
    return {
      status: "published",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          branchName: "b",
          defaultBranch: "main",
          expectedHead: "api-before",
          pushedHead: "api-head",
        },
        {
          provider: "gitlab",
          repoPath: "acme/web",
          branchName: "b",
          defaultBranch: "main",
          expectedHead: "web-before",
          pushedHead: "web-head",
        },
      ],
      pushResult: { pushed: true, repositories: [] },
      prs: [
        { provider: "github", repoPath: "acme/api", id: 7, url: "u7", branch: "b", isNew: true },
        { provider: "gitlab", repoPath: "acme/web", id: 9, url: "u9", branch: "b", isNew: true },
      ],
    };
  }

  function singlePublication(): WorkspacePublicationResult {
    return {
      status: "published",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/other",
          branchName: "b",
          defaultBranch: "main",
          expectedHead: "other-before",
          pushedHead: "other-head",
        },
      ],
      pushResult: { pushed: true, repositories: [] },
      prs: [
        { provider: "github", repoPath: "acme/other", id: 5, url: "u5", branch: "b", isNew: true },
      ],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to comment on an off-allowlist PR without creating a provider client", async () => {
    setAllowlist("acme/allowed");

    const result = await executePostPrComment(
      makeNode("post_pr_comment", { body: "LGTM" }),
      {},
      makeCtx({ publication: singlePublication() }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("not in AGENT_ALLOWED_REPOS");
    }
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  it("prefers publication PRs over the pr_trigger payload", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: null });
    mocks.createRepositoryVCS.mockImplementation(({ repoPath }: { repoPath: string }) => ({
      getPRHead: vi.fn().mockResolvedValue({
        headSha: repoPath === "acme/web" ? "web-head" : "api-head",
        baseRef: "main",
        state: "open",
      }),
      postPRComment,
    }));

    const result = await executePostPrComment(
      makeNode("post_pr_comment", { body: "LGTM", target: "all" }),
      {},
      makeCtx({
        publication: publication(),
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_checks_failed",
          subjectKey: "ticket:jira:AWT-1",
          ownerToken: "owner:test",
          ticketKey: "AWT-1",
          definitionId: 1,
          definitionVersion: 1,
          scope: "workflow_owned",
          pr: makePrPayload(),
        },
      }),
    );

    expect(result.kind).toBe("next");
    expect(postPRComment).toHaveBeenCalledTimes(2);
    expect(postPRComment).toHaveBeenCalledWith(7, marked("LGTM"));
    expect(postPRComment).toHaveBeenCalledWith(9, marked("LGTM"));
  });

  it("does not infer a missing publication target from the trigger payload", async () => {
    const incomplete = { ...singlePublication(), repositories: [] };

    const result = await executePostPrComment(
      makeNode("post_pr_comment", { body: "hi" }),
      {},
      makeCtx({
        publication: incomplete,
        entry: {
          kind: "pr_trigger",
          triggerType: "trigger_pr_checks_failed",
          subjectKey: "ticket:jira:AWT-1",
          ownerToken: "owner:test",
          ticketKey: "AWT-1",
          definitionId: 1,
          definitionVersion: 1,
          scope: "workflow_owned",
          pr: makePrPayload({ baseRef: "develop" }),
        },
      }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toContain("identity is incomplete");
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  it("does not infer a missing publication target as main for a ticket run", async () => {
    const incomplete = { ...singlePublication(), repositories: [] };

    const result = await executePostPrComment(
      makeNode("post_pr_comment", { body: "hi" }),
      {},
      makeCtx({ publication: incomplete }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toContain("identity is incomplete");
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  it("fails on a whitespace-only body without touching VCS", async () => {
    const result = await executePostPrComment(
      makeNode("post_pr_comment", { body: "   " }),
      {},
      makeCtx({ publication: publication() }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toContain("requires a body");
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// run_checks: edge cases
// ---------------------------------------------------------------------------
describe("run_checks edge cases", () => {
  function batchStarted(repoIndex: unknown) {
    return {
      skipped: false,
      commandId: `cmd-${repoIndex}`,
      localPath: "/vercel/sandbox",
      paths: {
        launchId: `launch${repoIndex}`,
        dir: `/tmp/batch-${repoIndex}`,
        wrapper: `/tmp/batch-${repoIndex}-wrapper.sh`,
        sentinel: `/tmp/batch-${repoIndex}-done`,
      },
    };
  }

  /** What the collect step returns, with the fields run_checks never sets. */
  function edgeCollected(
    results: Array<{ provider: string; repoPath: string; command: string; exitCode: number }>,
  ) {
    return {
      results,
      failures: [],
      setupFailed: false,
      progress: { completed: results.length, total: results.length, stoppedAt: null },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.pollPhaseUntilDone.mockResolvedValue(true);
    mocks.resolvePhaseStall.mockResolvedValue("none");
    mocks.startRepoCheckBatchStep.mockImplementation(async (...args: unknown[]) =>
      batchStarted(args[6]),
    );
    mocks.collectRepoCheckBatchStep.mockResolvedValue(edgeCollected([]));
  });

  it("uses the empty config when no pre-PR-checks configuration is stored", async () => {
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({
      version: null,
      config: emptyPrePrCheckConfig,
    });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      passed: true,
      fixCycles: 0,
      failures: [],
      summary: "ok",
    });

    await executeRunChecks(makeNode("run_checks"), {}, makeCtx());

    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx-1",
        config: emptyPrePrCheckConfig,
        agentKind: "claude",
        model: "claude-model",
        observeBudget: expect.any(Function),
      }),
    );
    // maxFixCycles is gone from the call, not set to zero: the repair loop it
    // bounded no longer exists.
    expect(mocks.runPrePrChecksWithFixes.mock.calls[0]?.[0]).not.toHaveProperty(
      "maxFixCycles",
    );
  });

  it("reports ok true when the configured checks pass", async () => {
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({ version: 1, config: { repositories: [] } });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      passed: true,
      fixCycles: 0,
      failures: [],
      summary: "ok",
    });

    const result = await executeRunChecks(makeNode("run_checks"), {}, makeCtx());

    expect(result.kind).toBe("next");
    expect(result.output!.ok).toBe(true);
    expect(result.output!.failures).toEqual([]);
  });

  it("fails when the workspace manifest is missing", async () => {
    mocks.listWorkspaceRepositoriesStep.mockRejectedValue(
      new Error("Workspace manifest not found in sandbox at /vercel/sandbox/aiw-repos.json"),
    );

    const result = await executeRunChecks(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toContain("Workspace manifest not found");
  });

  it("routes an empty commands array to the configured pre-PR-checks path", async () => {
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({ version: 1, config: { repositories: [] } });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      passed: true,
      fixCycles: 0,
      failures: [],
      summary: "ok",
    });

    await executeRunChecks(makeNode("run_checks", { commands: [] }), {}, makeCtx());

    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledTimes(1);
    expect(mocks.listWorkspaceRepositoriesStep).not.toHaveBeenCalled();
  });

  it("runs each command per repository and keys results per repo", async () => {
    mocks.listWorkspaceRepositoriesStep.mockResolvedValue([
      { provider: "github", repoPath: "acme/api" },
      { provider: "github", repoPath: "acme/web" },
    ]);
    mocks.collectRepoCheckBatchStep
      .mockResolvedValueOnce(
        edgeCollected([
          { provider: "github", repoPath: "acme/api", command: "pnpm lint", exitCode: 0 },
        ]),
      )
      .mockResolvedValueOnce(
        edgeCollected([
          { provider: "github", repoPath: "acme/web", command: "pnpm lint", exitCode: 0 },
        ]),
      );

    const result = await executeRunChecks(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output!.results).toEqual([
      { repo: "github:acme/api", command: "pnpm lint", exitCode: 0 },
      { repo: "github:acme/web", command: "pnpm lint", exitCode: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// finalize_workspace: edge cases
// ---------------------------------------------------------------------------
describe("finalize_workspace edge cases", () => {
  const repo: WorkspaceRepositoryInput = {
    provider: "github",
    repoPath: "acme/api",
    defaultBranch: "main",
    selectedRationale: "selected",
  };
  const workspaceManifest: WorkspaceManifest = {
    version: 1,
    repositories: [
      {
        ...repo,
        slug: "acme__api",
        localPath: "/vercel/sandbox",
        branchName: "blazebot/awt-1",
        expectedRemoteSha: "before",
        preAgentSha: "before",
      },
    ],
  };
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a thrown publication to kind failed with the push phase", async () => {
    mocks.finalizeWorkspacePublication.mockRejectedValue(new Error("boom"));

    const result = await executeFinalizeWorkspace(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toBe("boom");
      expect(result.error.phase).toBe("push");
    }
  });

  it("does not comment on a failed publication that produced zero PRs", async () => {
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      status: "failed",
      reason: "push rejected",
      repositories: [],
      prs: [],
    });

    const result = await executeFinalizeWorkspace(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest }),
    );

    expect(result.kind).toBe("execution_error");
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("reports finalized without creating or commenting on PRs", async () => {
    mocks.finalizeWorkspacePublication.mockResolvedValue({
      status: "finalized",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          branchName: "blazebot/awt-1",
          defaultBranch: "main",
          expectedHead: "before",
          pushedHead: "after",
        },
      ],
      prs: [],
    });

    const result = await executeFinalizeWorkspace(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo], workspaceManifest }),
    );

    expect(result.kind).toBe("next");
    expect(mocks.postComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetch_pr_context: edge cases
// ---------------------------------------------------------------------------
describe("fetch_pr_context edge cases", () => {
  const repoWithPr: WorkspaceRepositoryInput = {
    provider: "github",
    repoPath: "acme/api",
    defaultBranch: "main",
    selectedRationale: "selected",
    workflowOwnedBranch: {
      branchName: "blazebot/awt-1",
      pr: { id: 7, url: "https://pr/7", branch: "blazebot/awt-1" },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
  });

  it("refuses to read an off-allowlist PR without creating a provider client", async () => {
    setAllowlist("acme/allowed");

    const result = await executeFetchPrContext(
      makeNode("fetch_pr_context"),
      {},
      makeCtx({ selectedRepositories: [repoWithPr] }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("not in AGENT_ALLOWED_REPOS");
    }
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  it("uses the validated PR event tuple instead of a potentially stale owned-branch row", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
      getPRComments: vi.fn().mockResolvedValue([]),
      getCheckRunResults: vi.fn().mockResolvedValue([]),
      getPRConflictStatus: vi.fn().mockResolvedValue(false),
    });
    const ctx = makeCtx({
      selectedRepositories: [],
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_created",
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner:test",
        ticketKey: "AWT-1",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr: makePrPayload(),
      },
    });

    const result = await executeFetchPrContext(makeNode("fetch_pr_context"), {}, ctx);

    expect(result.kind).toBe("next");
    const owned = ctx.repositoryContexts[0].repository.workflowOwnedBranch;
    expect(owned?.branchName).toBe("blazebot/awt-1");
    expect(owned?.pr?.id).toBe(7);
    expect(mocks.listWorkflowOwnedBranchesForTicket).not.toHaveBeenCalled();
  });

  it("maps a rejected VCS call to a failed result", async () => {
    mocks.createRepositoryVCS.mockReturnValue({
      getPRComments: vi.fn().mockRejectedValue(new Error("github 500")),
      getCheckRunResults: vi.fn().mockResolvedValue([]),
      getPRConflictStatus: vi.fn().mockResolvedValue(false),
    });

    const result = await executeFetchPrContext(
      makeNode("fetch_pr_context"),
      {},
      makeCtx({ selectedRepositories: [repoWithPr] }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("github 500");
  });

  it("returns full context for a repo with a PR and empty context for one without", async () => {
    const vcs = {
      getPRComments: vi.fn().mockResolvedValue([{ author: "bob", body: "x", liked: false }]),
      getCheckRunResults: vi.fn().mockResolvedValue([]),
      getPRConflictStatus: vi.fn().mockResolvedValue(false),
    };
    mocks.createRepositoryVCS.mockReturnValue(vcs);
    const repoWithoutPr: WorkspaceRepositoryInput = {
      provider: "github",
      repoPath: "acme/web",
      defaultBranch: "main",
      selectedRationale: "selected",
    };
    const ctx = makeCtx({ selectedRepositories: [repoWithPr, repoWithoutPr] });

    const result = await executeFetchPrContext(makeNode("fetch_pr_context"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(mocks.createRepositoryVCS).toHaveBeenCalledTimes(1);
    expect(ctx.repositoryContexts[1]).toMatchObject({
      prComments: [],
      checkResults: [],
      hasConflicts: false,
    });
  });
});
