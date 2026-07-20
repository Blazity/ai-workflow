import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAdapter } from "./github.js";

const mockOctokit = {
  paginate: vi.fn(),
  git: {
    getRef: vi.fn(),
    createRef: vi.fn(),
    updateRef: vi.fn(),
  },
  repos: {
    createOrUpdateFileContents: vi.fn(),
  },
  pulls: {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
  },
  issues: {
    listComments: vi.fn(),
    createComment: vi.fn(),
  },
  checks: {
    create: vi.fn(),
    update: vi.fn(),
    listForRef: vi.fn(),
  },
};

vi.mock("../../lib/github-auth.js", () => ({
  buildOctokit: vi.fn(() => mockOctokit),
}));

function ghAdapter() {
  return new GitHubAdapter({
    auth: { appId: 1, privateKeyBase64: "a2V5", installationId: 2 },
    owner: "test-org",
    repo: "test-repo",
    baseBranch: "main",
  });
}

describe("GitHubAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createBranch", () => {
    it("creates branch from base ref", async () => {
      mockOctokit.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "abc123" } },
      });
      mockOctokit.git.createRef.mockResolvedValueOnce({ data: {} });

      const adapter = ghAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockOctokit.git.createRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "refs/heads/feat/test",
        sha: "abc123",
      });
    });

    it("seeds empty repo on 409 then creates branch", async () => {
      const error = new Error("Git Repository is empty") as any;
      error.status = 409;
      mockOctokit.git.getRef.mockRejectedValueOnce(error);
      mockOctokit.repos.createOrUpdateFileContents.mockResolvedValueOnce({
        data: { commit: { sha: "seed123" } },
      });
      mockOctokit.git.createRef.mockResolvedValueOnce({ data: {} });

      const adapter = ghAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalled();
      expect(mockOctokit.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({ sha: "seed123" }),
      );
    });

    it("force-resets existing branch to base SHA on 422", async () => {
      mockOctokit.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "base-sha" } },
      });
      const error = new Error("Reference already exists") as any;
      error.status = 422;
      mockOctokit.git.createRef.mockRejectedValueOnce(error);
      mockOctokit.git.updateRef.mockResolvedValueOnce({ data: {} });

      const adapter = ghAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockOctokit.git.updateRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "heads/feat/test",
        sha: "base-sha",
        force: true,
      });
    });
  });

  describe("createPR", () => {
    it("creates pull request", async () => {
      mockOctokit.pulls.create.mockResolvedValueOnce({
        data: { number: 42, html_url: "https://github.com/test-org/test-repo/pull/42" },
      });

      const adapter = ghAdapter();
      const pr = await adapter.createPR("feat/test", "Add feature", "Description");

      expect(pr.id).toBe(42);
      expect(pr.url).toContain("/pull/42");
    });
  });

  describe("getPRHead", () => {
    it("reads the authoritative open pull-request identity even when its branch ref is gone", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          head: { sha: "source-head-sha" },
          base: { ref: "release" },
          state: "open",
          merged: false,
        },
      });

      const adapter = ghAdapter();

      await expect(adapter.getPRHead(42)).resolves.toEqual({
        headSha: "source-head-sha",
        baseRef: "release",
        state: "open",
      });
      expect(mockOctokit.pulls.get).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
      });
      expect(mockOctokit.git.getRef).not.toHaveBeenCalled();
    });

    it("distinguishes a merged pull request from a merely closed one", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          head: { sha: "source-head-sha" },
          base: { ref: "main" },
          state: "closed",
          merged: true,
        },
      });

      await expect(ghAdapter().getPRHead(42)).resolves.toEqual({
        headSha: "source-head-sha",
        baseRef: "main",
        state: "merged",
      });
    });
  });

  describe("getLatestCheckRuns", () => {
    it("returns latest check-run identity and conclusion for an exact head", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        {
          id: 102,
          name: "ci / build",
          app: { slug: "github-actions" },
          status: "completed",
          conclusion: "success",
        },
      ]);

      await expect(ghAdapter().getLatestCheckRuns("source-head-sha")).resolves.toEqual([
        {
          id: 102,
          name: "ci / build",
          appSlug: "github-actions",
          status: "completed",
          conclusion: "success",
        },
      ]);
      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        mockOctokit.checks.listForRef,
        {
          owner: "test-org",
          repo: "test-repo",
          ref: "source-head-sha",
          filter: "latest",
          per_page: 100,
        },
      );
    });

    it("keeps a current configured failure that appears after the first 100 Check Runs", async () => {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        name: `unrelated-${index + 1}`,
        app: { slug: "github-actions" },
        status: "completed",
        conclusion: "success",
      }));
      mockOctokit.checks.listForRef.mockResolvedValueOnce({
        data: { check_runs: firstPage },
      });
      mockOctokit.paginate.mockResolvedValueOnce([
        ...firstPage,
        {
          id: 101,
          name: "required / lint",
          app: { slug: "github-actions" },
          status: "completed",
          conclusion: "failure",
        },
      ]);

      const checks = await ghAdapter().getLatestCheckRuns("source-head-sha");

      expect(checks).toHaveLength(101);
      expect(checks.at(-1)).toEqual({
        id: 101,
        name: "required / lint",
        appSlug: "github-actions",
        status: "completed",
        conclusion: "failure",
      });
      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        mockOctokit.checks.listForRef,
        {
          owner: "test-org",
          repo: "test-repo",
          ref: "source-head-sha",
          filter: "latest",
          per_page: 100,
        },
      );
    });
  });

  describe("findPR", () => {
    it("returns null when no PR exists", async () => {
      mockOctokit.pulls.list.mockResolvedValueOnce({ data: [] });

      const adapter = ghAdapter();
      const pr = await adapter.findPR("feat/test");
      expect(pr).toBeNull();
    });

    it("returns PR when one exists", async () => {
      mockOctokit.pulls.list.mockResolvedValueOnce({
        data: [{ number: 42, html_url: "https://github.com/test-org/test-repo/pull/42", head: { ref: "feat/test" } }],
      });

      const adapter = ghAdapter();
      const pr = await adapter.findPR("feat/test");
      expect(pr).not.toBeNull();
      expect(pr!.id).toBe(42);
      expect(mockOctokit.pulls.list).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        head: "test-org:feat/test",
        base: "main",
        state: "open",
      });
    });
  });

  describe("getPRHeadSha", () => {
    it("returns the provider's current pull request head", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: { head: { sha: "current-head" } },
      });

      await expect(ghAdapter().getPRHeadSha(42)).resolves.toBe("current-head");
      expect(mockOctokit.pulls.get).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
      });
    });
  });

  describe("postPRComment", () => {
    it("posts an issue comment and returns its html_url", async () => {
      mockOctokit.issues.createComment.mockResolvedValueOnce({
        data: { html_url: "https://github.com/test-org/test-repo/pull/42#issuecomment-1" },
      });

      const adapter = ghAdapter();
      const result = await adapter.postPRComment(42, "Looks good");

      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: "Looks good",
      });
      expect(result).toEqual({
        url: "https://github.com/test-org/test-repo/pull/42#issuecomment-1",
      });
    });
  });

  describe("gate statuses", () => {
    it("creates a GitHub check run and returns a gate status ref", async () => {
      mockOctokit.checks.create.mockResolvedValueOnce({ data: { id: 123 } });

      const adapter = ghAdapter();
      const ref = await adapter.createGateStatus("blazebot / code-hygiene", "sha1");

      expect(ref).toEqual({ provider: "github", id: 123 });
      expect(mockOctokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-org",
          repo: "test-repo",
          name: "blazebot / code-hygiene",
          head_sha: "sha1",
          status: "in_progress",
        }),
      );
    });

    it("updates a GitHub gate status ref", async () => {
      mockOctokit.checks.update.mockResolvedValueOnce({ data: {} });

      const adapter = ghAdapter();
      await adapter.updateGateStatus(
        { provider: "github", id: 123 },
        { status: "completed", conclusion: "success", summary: "ok" },
      );

      expect(mockOctokit.checks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "test-org",
          repo: "test-repo",
          check_run_id: 123,
          status: "completed",
          conclusion: "success",
        }),
      );
    });
  });
});
