import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAdapter } from "./github.js";

const mockOctokit = {
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
  },
};

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

function ghAdapter() {
  return new GitHubAdapter({
    token: "ghp_test",
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
    });
  });
});
