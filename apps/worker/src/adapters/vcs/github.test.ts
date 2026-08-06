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
    listReviewComments: vi.fn(),
    listReviews: vi.fn(),
    listCommentsForReview: vi.fn(),
    createReview: vi.fn(),
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

  describe("branch ownership operations", () => {
    it("creates branch from base ref", async () => {
      mockOctokit.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "abc123" } },
      });
      mockOctokit.git.createRef.mockResolvedValueOnce({ data: {} });

      const adapter = ghAdapter();
      await expect(
        adapter.createBranchIfMissing("feat/test", "main"),
      ).resolves.toBe("created");

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
      await expect(
        adapter.createBranchIfMissing("feat/test", "main"),
      ).resolves.toBe("created");

      expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalled();
      expect(mockOctokit.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({ sha: "seed123" }),
      );
    });

    it("reports an existing branch without resetting it on 422", async () => {
      mockOctokit.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "base-sha" } },
      });
      const error = new Error("Reference already exists") as any;
      error.status = 422;
      mockOctokit.git.createRef.mockRejectedValueOnce(error);

      const adapter = ghAdapter();
      await expect(
        adapter.createBranchIfMissing("feat/test", "main"),
      ).resolves.toBe("existing");

      expect(mockOctokit.git.updateRef).not.toHaveBeenCalled();
    });

    it("throws on a 422 that is not a ref-already-exists error", async () => {
      mockOctokit.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "base-sha" } },
      });
      const error = Object.assign(new Error("Reference update failed: invalid ref name"), {
        status: 422,
      });
      mockOctokit.git.createRef.mockRejectedValueOnce(error);

      const adapter = ghAdapter();
      await expect(
        adapter.createBranchIfMissing("feat/test", "main"),
      ).rejects.toThrow("invalid ref name");

      expect(mockOctokit.git.updateRef).not.toHaveBeenCalled();
    });

    it("force-resets only through the explicit owned-branch operation", async () => {
      mockOctokit.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "base-sha" } },
      });
      mockOctokit.git.updateRef.mockResolvedValueOnce({ data: {} });

      await ghAdapter().resetOwnedBranch("feat/test", "main");

      expect(mockOctokit.git.updateRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "heads/feat/test",
        sha: "base-sha",
        force: true,
      });
    });

    it("creates a branch directly at a commit SHA base without a branch-name lookup", async () => {
      mockOctokit.git.createRef.mockResolvedValueOnce({ data: {} });

      const sha = "a".repeat(40);
      const adapter = ghAdapter();
      await expect(
        adapter.createBranchIfMissing("feat/test", sha),
      ).resolves.toBe("created");

      expect(mockOctokit.git.getRef).not.toHaveBeenCalled();
      expect(mockOctokit.git.createRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "refs/heads/feat/test",
        sha,
      });
    });

    it("reports an existing branch on 422 when the base is a commit SHA", async () => {
      const sha = "b".repeat(40);
      const error = Object.assign(new Error("Reference already exists"), {
        status: 422,
      });
      mockOctokit.git.createRef.mockRejectedValueOnce(error);

      const adapter = ghAdapter();
      await expect(
        adapter.createBranchIfMissing("feat/test", sha),
      ).resolves.toBe("existing");

      expect(mockOctokit.git.getRef).not.toHaveBeenCalled();
      expect(mockOctokit.git.updateRef).not.toHaveBeenCalled();
    });

    it("force-resets an owned branch directly to a commit SHA base", async () => {
      const sha = "c".repeat(40);
      mockOctokit.git.updateRef.mockResolvedValueOnce({ data: {} });

      await ghAdapter().resetOwnedBranch("feat/test", sha);

      expect(mockOctokit.git.getRef).not.toHaveBeenCalled();
      expect(mockOctokit.git.updateRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "heads/feat/test",
        sha,
        force: true,
      });
    });

    it("distinguishes an absent branch from provider failures", async () => {
      const missing = Object.assign(new Error("Not Found"), { status: 404 });
      mockOctokit.git.getRef.mockRejectedValueOnce(missing);

      await expect(
        ghAdapter().getBranchShaIfExists("feat/missing"),
      ).resolves.toBeNull();
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

  describe("getManualDispatchPullRequest", () => {
    it("returns authoritative lifecycle, current failures, and eligible review facts", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          html_url: "https://github.com/test-org/test-repo/pull/42",
          head: { ref: "feature/manual", sha: "head-sha" },
          base: { ref: "main" },
          title: "Manual dispatch",
          user: { login: "alice" },
          draft: false,
          state: "open",
          merged: false,
        },
      });
      mockOctokit.paginate
        .mockResolvedValueOnce([
          {
            id: 100,
            name: "ci / build",
            app: { slug: "github-actions" },
            status: "completed",
            conclusion: "failure",
          },
          {
            id: 101,
            name: "ci / lint",
            app: { slug: "github-actions" },
            status: "completed",
            conclusion: "success",
          },
        ])
        .mockResolvedValueOnce([
          {
            state: "CHANGES_REQUESTED",
            user: { login: "reviewer" },
            body: "Please cover the retry path.",
          },
          {
            state: "APPROVED",
            user: { login: "maintainer" },
            body: "",
          },
        ]);

      await expect(
        ghAdapter().getManualDispatchPullRequest(42),
      ).resolves.toMatchObject({
        prNumber: 42,
        headRef: "feature/manual",
        headSha: "head-sha",
        baseRef: "main",
        state: "open",
        failedChecks: [
          {
            name: "ci / build",
            conclusion: "failure",
            checkRunId: 100,
            appSlug: "github-actions",
          },
        ],
        reviews: [
          {
            state: "changes_requested",
            author: "reviewer",
            body: "Please cover the retry path.",
          },
        ],
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

  describe("publishPRReview", () => {
    it("publishes against the exact head and returns persisted inline comment ids", async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 802,
            path: "src/other.ts",
            line: 1,
            start_line: null,
          },
          {
            id: 801,
            path: "src/index.ts",
            line: 12,
            start_line: 10,
          },
        ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 701 },
      });

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "Two findings.",
        comments: [
          {
            path: "src/index.ts",
            body: "Handle this failure.",
            startLine: 10,
            endLine: 12,
          },
        ],
      });

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
        commit_id: "reviewed-head",
        event: "REQUEST_CHANGES",
        body: "Two findings.\n\n<!-- ai-workflow-review:review-hash -->",
        comments: [
          {
            path: "src/index.ts",
            body: "Handle this failure.",
            side: "RIGHT",
            line: 12,
            start_side: "RIGHT",
            start_line: 10,
          },
        ],
      });
      expect(mockOctokit.paginate).toHaveBeenLastCalledWith(
        mockOctokit.pulls.listCommentsForReview,
        {
          owner: "test-org",
          repo: "test-repo",
          pull_number: 42,
          review_id: 701,
          per_page: 100,
        },
      );
      expect(result).toEqual({
        id: "701",
        commentIds: ["801"],
      });
    });

    it("reuses an existing marked review without publishing a duplicate", async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([
          {
            id: 701,
            body: "Already published.\n\n<!-- ai-workflow-review:review-hash -->",
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 801,
            path: "src/index.ts",
            line: 12,
            start_line: 10,
          },
        ]);

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "approve",
        summary: "Approved.",
        comments: [
          {
            path: "src/index.ts",
            body: "Already published.",
            startLine: 10,
            endLine: 12,
          },
          {
            path: "src/missing.ts",
            body: "Provider omitted this comment.",
            startLine: 3,
            endLine: 3,
          },
        ],
      });

      expect(mockOctokit.pulls.createReview).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "701", commentIds: ["801", null] });
    });

    it("recognises a review marked with a prior key", async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([
          {
            id: 701,
            body:
              "Published before the key was stable.\n\n" +
              "<!-- ai-workflow-review:old-content-hash -->",
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 801,
            path: "src/index.ts",
            line: 12,
            start_line: 10,
          },
        ]);

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "round-key",
        priorIdempotencyKeys: ["old-content-hash"],
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "The same review.",
        comments: [
          {
            path: "src/index.ts",
            body: "Already published.",
            startLine: 10,
            endLine: 12,
          },
        ],
      });

      // The key the marker is written from changed with the release; the review
      // on the pull request did not. Failing to recognise it here would greet
      // every open pull request with a second copy of its own review.
      expect(mockOctokit.pulls.createReview).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "701", commentIds: ["801"] });
    });

    it("falls back to a summary-only review when GitHub rejects inline positions", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([]);
      const rejected = Object.assign(new Error("Validation failed"), {
        status: 422,
      });
      mockOctokit.pulls.createReview
        .mockRejectedValueOnce(rejected)
        .mockResolvedValueOnce({ data: { id: 702 } });

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          {
            path: "src/index.ts",
            body: "Handle this failure.",
            startLine: 10,
            endLine: 12,
          },
        ],
      });

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledTimes(2);
      expect(mockOctokit.pulls.createReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          comments: [],
          body: expect.stringContaining(
            "- `src/index.ts:10-12` — Handle this failure.",
          ),
        }),
      );
      expect(result).toEqual({ id: "702", commentIds: [null] });
    });

    // A merged review comment carries its agreement note after a blank line.
    // Left unindented, that blank line closes the markdown list, detaching the
    // note and starting a fresh list for every finding after it.
    it("keeps a merged comment's agreement note inside its own bullet", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([]);
      const rejected = Object.assign(new Error("Validation failed"), {
        status: 422,
      });
      mockOctokit.pulls.createReview
        .mockRejectedValueOnce(rejected)
        .mockResolvedValueOnce({ data: { id: 703 } });

      await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "Two findings.",
        comments: [
          {
            path: "src/index.ts",
            body: "**High**: Handle this failure.\n\nReported by 3 of 3 reviewers.",
            startLine: 10,
            endLine: 12,
          },
          {
            path: "src/other.ts",
            body: "**Medium**: Rename this helper.",
            startLine: 4,
            endLine: 4,
          },
        ],
      });

      const body: string = mockOctokit.pulls.createReview.mock.calls[1]![0].body;
      expect(body).toContain(
        "- `src/index.ts:10-12` — **High**: Handle this failure.\n\n  Reported by 3 of 3 reviewers.",
      );
      // The bullet after a merged one still belongs to the same list.
      expect(body).toContain("\n- `src/other.ts:4` — **Medium**: Rename this helper.");
    });

    it("publishes findings as a comment review when the app cannot request changes on its own pull request", async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 803,
            path: "src/index.ts",
            line: 12,
            start_line: 10,
          },
        ]);
      const rejected = Object.assign(
        new Error(
          'Unprocessable Entity: "Review Can not request changes on your own pull request"',
        ),
        { status: 422 },
      );
      mockOctokit.pulls.createReview
        .mockRejectedValueOnce(rejected)
        .mockResolvedValueOnce({ data: { id: 703 } });

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          {
            path: "src/index.ts",
            body: "Handle this failure.",
            startLine: 10,
            endLine: 12,
          },
        ],
      });

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledTimes(2);
      expect(mockOctokit.pulls.createReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          event: "COMMENT",
          comments: [
            expect.objectContaining({
              path: "src/index.ts",
              body: "Handle this failure.",
            }),
          ],
        }),
      );
      expect(result).toEqual({ id: "703", commentIds: ["803"] });
    });

    it("publishes approval as a comment review when the app cannot approve its own pull request", async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const rejected = Object.assign(
        new Error(
          'Unprocessable Entity: "Review Can not approve your own pull request"',
        ),
        { status: 422 },
      );
      mockOctokit.pulls.createReview
        .mockRejectedValueOnce(rejected)
        .mockResolvedValueOnce({ data: { id: 704 } });

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "approve",
        summary: "Approved.",
        comments: [],
      });

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledTimes(2);
      expect(mockOctokit.pulls.createReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          event: "COMMENT",
          comments: [],
        }),
      );
      expect(result).toEqual({ id: "704", commentIds: [] });
    });

    it("falls back to a summary-only comment review when self-review inline positions are rejected", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([]);
      const selfReviewRejected = Object.assign(
        new Error(
          'Unprocessable Entity: "Review Can not request changes on your own pull request"',
        ),
        { status: 422 },
      );
      const inlineRejected = Object.assign(new Error("Validation failed"), {
        status: 422,
      });
      mockOctokit.pulls.createReview
        .mockRejectedValueOnce(selfReviewRejected)
        .mockRejectedValueOnce(inlineRejected)
        .mockResolvedValueOnce({ data: { id: 705 } });

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          {
            path: "src/index.ts",
            body: "Handle this failure.",
            startLine: 10,
            endLine: 12,
          },
        ],
      });

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledTimes(3);
      expect(mockOctokit.pulls.createReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          event: "COMMENT",
          comments: [],
          body: expect.stringContaining(
            "- `src/index.ts:10-12` — Handle this failure.",
          ),
        }),
      );
      expect(result).toEqual({ id: "705", commentIds: [null] });
    });

    it("does not hide unrelated GitHub validation failures", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([]);
      const rejected = Object.assign(new Error("Validation failed"), {
        status: 422,
      });
      mockOctokit.pulls.createReview.mockRejectedValueOnce(rejected);

      await expect(
        ghAdapter().publishPRReview(42, {
          idempotencyKey: "review-hash",
          headSha: "reviewed-head",
          decision: "approve",
          summary: "Approved.",
          comments: [],
        }),
      ).rejects.toBe(rejected);

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPRComments", () => {
    it("paginates and includes inline comments, issue comments, and review summary bodies", async () => {
      const reviewComments = [
        {
          user: { login: "reviewer" },
          body: "rename this",
          reactions: { total_count: 0 },
          path: "src/a.ts",
          line: 12,
          start_line: null,
        },
      ];
      const issueComments = [
        { user: { login: "reviewer" }, body: "general note", reactions: { total_count: 1 } },
      ];
      const reviews = [
        { user: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "please fix the null check" },
        // Approvals/dismissals with no summary text must not pollute the prompt.
        { user: { login: "reviewer" }, state: "APPROVED", body: "" },
      ];
      // paginate() follows every page; the adapter must read all three lists
      // through it, not a single first page.
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.pulls.listReviewComments) return reviewComments;
        if (endpoint === mockOctokit.issues.listComments) return issueComments;
        if (endpoint === mockOctokit.pulls.listReviews) return reviews;
        return [];
      });

      const adapter = ghAdapter();
      const comments = await adapter.getPRComments(42);

      // Regression: review summaries (and inline/issue comments) are paginated so
      // feedback past the first page is never dropped.
      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        mockOctokit.pulls.listReviews,
        expect.objectContaining({ pull_number: 42, per_page: 100 }),
      );
      expect(comments).toContainEqual(
        expect.objectContaining({ filePath: "src/a.ts", body: "rename this", endLine: 12 }),
      );
      expect(comments).toContainEqual(
        expect.objectContaining({ body: "general note", liked: true }),
      );
      expect(comments).toContainEqual({
        author: "reviewer",
        body: "[Review: changes requested] please fix the null check",
        liked: false,
      });
      // The empty-body approval is filtered out.
      expect(comments).toHaveLength(3);
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

    it("reuses a pending check with the same name on the exact head", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        {
          id: 123,
          name: "AI Workflow / review",
          status: "in_progress",
          app: { id: 1 },
        },
      ]);

      const ref = await ghAdapter().createGateStatus(
        "AI Workflow / review",
        "sha1",
      );

      expect(ref).toEqual({ provider: "github", id: 123 });
      expect(mockOctokit.checks.create).not.toHaveBeenCalled();
    });

    it("does not reuse a pending check owned by another GitHub App", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        {
          id: 123,
          name: "AI Workflow / review",
          status: "in_progress",
          app: { id: 99 },
        },
      ]);
      mockOctokit.checks.create.mockResolvedValueOnce({ data: { id: 124 } });

      const ref = await ghAdapter().createGateStatus(
        "AI Workflow / review",
        "sha1",
      );

      expect(ref).toEqual({ provider: "github", id: 124 });
      expect(mockOctokit.checks.create).toHaveBeenCalledOnce();
    });

    it("does not reuse another workflow resource's pending check", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        {
          id: 123,
          name: "AI Workflow / review",
          status: "in_progress",
          app: { id: 1 },
          external_id: "other-resource",
        },
      ]);
      mockOctokit.checks.create.mockResolvedValueOnce({ data: { id: 124 } });

      const ref = await ghAdapter().createGateStatus(
        "AI Workflow / review",
        "sha1",
        "this-resource",
      );

      expect(ref).toEqual({ provider: "github", id: 124 });
      expect(mockOctokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({ external_id: "this-resource" }),
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
