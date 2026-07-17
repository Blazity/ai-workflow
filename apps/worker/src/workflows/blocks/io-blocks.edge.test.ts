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
  publishWorkspaceChanges: vi.fn(),
  sandboxGet: vi.fn(),
  getCurrentPrePrCheckConfig: vi.fn(),
  runPrePrChecksWithFixes: vi.fn(),
  loggerWarn: vi.fn(),
  buildOctokit: vi.fn(),
}));

vi.mock("../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ issueTracker: { postComment: mocks.postComment } }),
}));
vi.mock("../../lib/vcs-runtime.js", () => ({ createRepositoryVCS: mocks.createRepositoryVCS }));
vi.mock("../../db/client.js", () => ({ getDb: mocks.getDb }));
vi.mock("../../db/queries/workflow-owned-branches.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
  upsertWorkflowOwnedBranch: mocks.upsertWorkflowOwnedBranch,
}));
vi.mock("../workspace-publication.js", () => ({
  publishWorkspaceChanges: mocks.publishWorkspaceChanges,
}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../../pre-pr-checks/store.js", () => ({
  getCurrentPrePrCheckConfig: mocks.getCurrentPrePrCheckConfig,
}));
vi.mock("../../pre-pr-checks/runner.js", () => ({
  runPrePrChecksWithFixes: mocks.runPrePrChecksWithFixes,
}));
vi.mock("../../lib/logger.js", () => ({
  logger: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/github-auth.js", () => ({ buildOctokit: mocks.buildOctokit }));

import type { WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import { emptyPrePrCheckConfig } from "../../pre-pr-checks/config.js";
import { isRepoAllowed, filterAllowedRepositories } from "../../lib/repo-allowlist.js";
import {
  createRepositoryDirectory,
  createRepositoryDirectoryForProviders,
} from "../../adapters/vcs/repository-directory.js";
import {
  createOrUseWorkflowOwnedPullRequestsForRepos,
  prepareSelectedRepositoryBranches,
} from "../repository-prs.js";
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

  it("drops an off-list GitHub full_name from the normalized result", async () => {
    setAllowlist("acme/api");
    mocks.buildOctokit.mockReturnValue(octokitReturning(["acme/api", "acme/web"]));

    const result = await createRepositoryDirectory(githubConfig).listRepositories();

    expect(result.map((r) => r.repoPath)).toEqual(["acme/api"]);
  });

  it("keeps a case-differing GitHub full_name", async () => {
    setAllowlist("acme/api");
    mocks.buildOctokit.mockReturnValue(octokitReturning(["Acme/API", "other/repo"]));

    const result = await createRepositoryDirectory(githubConfig).listRepositories();

    expect(result.map((r) => r.repoPath)).toEqual(["Acme/API"]);
  });

  it("drops an off-list GitLab path_with_namespace", async () => {
    setAllowlist("acme/api");
    mockFetch.mockResolvedValueOnce(
      gitLabResponse([{ path_with_namespace: "acme/api" }, { path_with_namespace: "acme/web" }], {
        "x-next-page": "",
      }),
    );

    const result = await createRepositoryDirectory(gitlabConfig).listRepositories();

    expect(result.map((r) => r.repoPath)).toEqual(["acme/api"]);
  });

  it("applies the allowlist per provider before the flat merge", async () => {
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

    expect(result).toEqual([expect.objectContaining({ provider: "gitlab", repoPath: "acme/api" })]);
  });
});

// ---------------------------------------------------------------------------
// repository-prs.ts: allowlist guards (real repo-allowlist, mocked db/vcs)
// ---------------------------------------------------------------------------
describe("repository-prs allowlist guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
  });

  it("refuses to branch an off-list repo without creating a branch", async () => {
    setAllowlist("acme/allowed");
    const createBranch = vi.fn();
    mocks.createRepositoryVCS.mockReturnValue({ createBranch });

    await expect(
      prepareSelectedRepositoryBranches("AWT-1", "blazebot/awt-1", [
        { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "x" },
      ]),
    ).rejects.toThrow("Refusing to branch acme/api: not in AGENT_ALLOWED_REPOS");

    expect(createBranch).not.toHaveBeenCalled();
    expect(mocks.upsertWorkflowOwnedBranch).not.toHaveBeenCalled();
  });

  it("branches an on-list repo when the allowlist is set and includes it", async () => {
    setAllowlist("acme/api");
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createRepositoryVCS.mockReturnValue({ createBranch });

    await prepareSelectedRepositoryBranches("AWT-1", "blazebot/awt-1", [
      { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "x" },
    ]);

    expect(createBranch).toHaveBeenCalledWith("blazebot/awt-1", "main");
    expect(mocks.upsertWorkflowOwnedBranch).toHaveBeenCalled();
  });

  it("allows an on-list repo case-insensitively", async () => {
    setAllowlist("acme/api");
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createRepositoryVCS.mockReturnValue({ createBranch });

    await expect(
      prepareSelectedRepositoryBranches("AWT-1", "blazebot/awt-1", [
        { provider: "github", repoPath: "Acme/API", defaultBranch: "main", selectedRationale: "x" },
      ]),
    ).resolves.toBeUndefined();

    expect(createBranch).toHaveBeenCalledTimes(1);
  });

  it("throws on the second (off-list) repo after the first repo already branched", async () => {
    setAllowlist("acme/api");
    const createBranch = vi.fn().mockResolvedValue(undefined);
    mocks.createRepositoryVCS.mockReturnValue({ createBranch });

    await expect(
      prepareSelectedRepositoryBranches("AWT-1", "blazebot/awt-1", [
        { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "x" },
        { provider: "github", repoPath: "acme/web", defaultBranch: "main", selectedRationale: "x" },
      ]),
    ).rejects.toThrow("Refusing to branch acme/web");

    expect(createBranch).toHaveBeenCalledTimes(1);
    expect(createBranch).toHaveBeenCalledWith("blazebot/awt-1", "main");
  });

  it("refuses to open a PR on an off-list repo without calling createPR", async () => {
    setAllowlist("acme/allowed");
    const createPR = vi.fn();
    mocks.createRepositoryVCS.mockReturnValue({ createPR });

    await expect(
      createOrUseWorkflowOwnedPullRequestsForRepos({
        ticketKey: "AWT-1",
        branchName: "blazebot/awt-1",
        repositories: [
          { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "x" },
        ],
        title: "Fix API",
      }),
    ).rejects.toThrow("Refusing to open a PR on acme/api");

    expect(createPR).not.toHaveBeenCalled();
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

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("requires a body");
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
      pushResult: { pushed: true, repositories: [] },
      prs: [
        { provider: "github", repoPath: "acme/other", id: 5, url: "u5", branch: "b", isNew: true },
      ],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers publication PRs over the pr_trigger payload", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: null });
    mocks.createRepositoryVCS.mockReturnValue({ postPRComment });

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
    expect(postPRComment).toHaveBeenCalledWith(7, "LGTM");
    expect(postPRComment).toHaveBeenCalledWith(9, "LGTM");
  });

  it("falls back to entry.pr.baseRef for a publication repo not in selectedRepositories (pr_trigger)", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: null });
    mocks.createRepositoryVCS.mockReturnValue({ postPRComment });

    await executePostPrComment(
      makeNode("post_pr_comment", { body: "hi" }),
      {},
      makeCtx({
        publication: singlePublication(),
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

    expect(mocks.createRepositoryVCS).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/other",
      baseBranch: "develop",
    });
  });

  it("falls back to 'main' for a publication repo not in selectedRepositories (ticket)", async () => {
    const postPRComment = vi.fn().mockResolvedValue({ url: null });
    mocks.createRepositoryVCS.mockReturnValue({ postPRComment });

    await executePostPrComment(
      makeNode("post_pr_comment", { body: "hi" }),
      {},
      makeCtx({ publication: singlePublication() }),
    );

    expect(mocks.createRepositoryVCS).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/other",
      baseBranch: "main",
    });
  });

  it("fails on a whitespace-only body without touching VCS", async () => {
    const result = await executePostPrComment(
      makeNode("post_pr_comment", { body: "   " }),
      {},
      makeCtx({ publication: publication() }),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("requires a body");
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// run_checks: edge cases
// ---------------------------------------------------------------------------
describe("run_checks edge cases", () => {
  function manifest(repoPaths: string[]): string {
    return JSON.stringify({
      version: 1,
      repositories: repoPaths.map((repoPath) => ({
        provider: "github",
        repoPath,
        slug: repoPath.split("/")[1],
        localPath: `/vercel/sandbox/repos/${repoPath.split("/")[1]}`,
        defaultBranch: "main",
        branchName: "blazebot/awt-1",
        selectedRationale: "selected",
      })),
    });
  }

  function sandbox(opts: { manifest?: string; manifestExit?: number; commandExit?: number }) {
    return {
      runCommand: vi.fn(async (cmdOrSpec: unknown, args?: string[]) => {
        if (cmdOrSpec === "cat" && args) {
          return {
            exitCode: opts.manifestExit ?? 0,
            stdout: async () => opts.manifest ?? "",
            stderr: async () => "",
          };
        }
        const exitCode = opts.commandExit ?? 0;
        return {
          exitCode,
          stdout: async () => (exitCode === 0 ? "passed" : "boom"),
          stderr: async () => "",
        };
      }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
  });

  it("uses the empty config when getCurrentPrePrCheckConfig returns null", async () => {
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue(null);
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      passed: true,
      fixCycles: 0,
      failures: [],
      summary: "ok",
    });

    await executeRunChecks(makeNode("run_checks"), {}, makeCtx());

    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledWith(
      "sbx-1",
      emptyPrePrCheckConfig,
      "claude",
      "claude-model",
      0,
      1_800_000,
    );
  });

  it("reports ok true when the configured checks pass", async () => {
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({ version: 1, config: { repositories: [] } });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      passed: true,
      fixCycles: 0,
      failures: [],
      summary: "ok",
    });

    const result = await executeRunChecks(makeNode("run_checks"), {}, makeCtx());

    expect(result.kind).toBe("next");
    expect(result.output.ok).toBe(true);
    expect(result.output.failures).toEqual([]);
  });

  it("fails when the workspace manifest is missing", async () => {
    mocks.sandboxGet.mockResolvedValue(sandbox({ manifestExit: 1 }));

    const result = await executeRunChecks(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("Workspace manifest not found");
  });

  it("routes an empty commands array to the configured pre-PR-checks path", async () => {
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({ version: 1, config: { repositories: [] } });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      passed: true,
      fixCycles: 0,
      failures: [],
      summary: "ok",
    });

    await executeRunChecks(makeNode("run_checks", { commands: [] }), {}, makeCtx());

    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledTimes(1);
    expect(mocks.sandboxGet).not.toHaveBeenCalled();
  });

  it("runs each command per repository and keys results per repo", async () => {
    mocks.sandboxGet.mockResolvedValue(sandbox({ manifest: manifest(["acme/api", "acme/web"]) }));

    const result = await executeRunChecks(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output.results).toEqual([
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
  const publishedPr = {
    provider: "github" as const,
    repoPath: "acme/api",
    id: 7,
    url: "https://github.com/acme/api/pull/7",
    branch: "blazebot/awt-1",
    isNew: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a thrown publication to kind failed with the push phase", async () => {
    mocks.publishWorkspaceChanges.mockRejectedValue(new Error("boom"));

    const result = await executeFinalizeWorkspace(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo] }),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("boom");
      expect(result.phase).toBe("push");
    }
  });

  it("does not comment on a failed publication that produced zero PRs", async () => {
    mocks.publishWorkspaceChanges.mockResolvedValue({
      status: "failed",
      reason: "push rejected",
      pushResult: { pushed: false, repositories: [] },
      prs: [],
    });

    const result = await executeFinalizeWorkspace(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo] }),
    );

    expect(result.kind).toBe("failed");
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("swallows a PR-links comment failure and still reports published", async () => {
    mocks.publishWorkspaceChanges.mockResolvedValue({
      status: "published",
      pushResult: { pushed: true, repositories: [] },
      prs: [publishedPr],
    });
    mocks.postComment.mockRejectedValue(new Error("jira down"));

    const result = await executeFinalizeWorkspace(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo] }),
    );

    expect(result.kind).toBe("next");
    expect(mocks.postComment).toHaveBeenCalled();
  });

  it("comments 'ready for review' when at least one PR is new", async () => {
    mocks.publishWorkspaceChanges.mockResolvedValue({
      status: "published",
      pushResult: { pushed: true, repositories: [] },
      prs: [publishedPr, { ...publishedPr, id: 8, isNew: false }],
    });

    await executeFinalizeWorkspace(
      makeNode("finalize_workspace"),
      {},
      makeCtx({ selectedRepositories: [repo] }),
    );

    expect(mocks.postComment).toHaveBeenCalledTimes(1);
    expect(mocks.postComment).toHaveBeenCalledWith(
      "AWT-1",
      expect.stringContaining("Pull requests ready for review:"),
    );
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

  it("prefers an existing owned-branch record over the pr_trigger payload defaults", async () => {
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([
      {
        provider: "github",
        repoPath: "acme/api",
        branchName: "owned-branch",
        pr: { id: 99, url: "https://pr/99", branch: "owned-branch" },
      },
    ]);
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
    expect(owned?.branchName).toBe("owned-branch");
    expect(owned?.pr?.id).toBe(99);
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

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("github 500");
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
