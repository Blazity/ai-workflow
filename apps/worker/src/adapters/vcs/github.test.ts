import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAdapter } from "./github.js";
import { reviewFindingDigest } from "./types.js";
import type { ReviewThread } from "./types.js";
import { AI_WORKFLOW_COMMENT_MARKER } from "../../lib/vcs-bot-identity.js";

const mockOctokit = {
  paginate: vi.fn(),
  graphql: vi.fn(),
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
    createReplyForReviewComment: vi.fn(),
  },
  issues: {
    listComments: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
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
    // `clearAllMocks` forgets calls but keeps the queue `mockResolvedValueOnce`
    // builds up, so a test that leaves one unconsumed hands it to the next test.
    // These two are queued in nearly every review test, which is exactly where
    // that leak is hardest to read.
    mockOctokit.paginate.mockReset();
    mockOctokit.paginate.mockResolvedValue([]);
    mockOctokit.graphql.mockReset();
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
    /** One review thread as the GraphQL query returns it. */
    function thread(options: {
      id: string;
      commentId?: string;
      databaseId?: number;
      body: string;
      isMinimized?: boolean;
      viewerDidAuthor?: boolean;
      /** Comments after the first. `viewerDidAuthor: false` is a human reply. */
      replies?: Array<{ viewerDidAuthor: boolean }>;
    }) {
      return {
        id: options.id,
        comments: {
          nodes: [
            {
              id: options.commentId ?? `${options.id}-comment`,
              databaseId: options.databaseId ?? null,
              body: options.body,
              viewerDidAuthor: options.viewerDidAuthor ?? true,
              isMinimized: options.isMinimized ?? false,
            },
            ...(options.replies ?? []).map((reply, index) => ({
              id: `${options.id}-reply-${index}`,
              databaseId: null,
              body: "A reply.",
              viewerDidAuthor: reply.viewerDidAuthor,
              isMinimized: false,
            })),
          ],
        },
      };
    }

    function stubReviewThreads(nodes: unknown[]) {
      mockOctokit.graphql.mockImplementation(async (query: string) =>
        String(query).includes("reviewThreads(")
          ? {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes,
                  },
                },
              },
            }
          : {},
      );
    }

    const graphqlCalls = (needle: string) =>
      mockOctokit.graphql.mock.calls.filter(([query]) =>
        String(query).includes(needle),
      );

    const findingMarker = (path: string, body: string) =>
      `<!-- ai-workflow-review-finding:${reviewFindingDigest({ path, body })} -->`;

    beforeEach(() => {
      stubReviewThreads([]);
      mockOctokit.issues.createComment.mockResolvedValue({ data: { id: 900 } });
      mockOctokit.issues.updateComment.mockResolvedValue({ data: { id: 900 } });
    });

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
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "Handle this failure." }),
        ],
      });

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
        commit_id: "reviewed-head",
        event: "REQUEST_CHANGES",
        // The verdict's review is per head and says so. The summary is not in it.
        body: expect.stringContaining(
          "<!-- ai-workflow-review-head:reviewed-head -->",
        ),
        comments: [
          {
            path: "src/index.ts",
            // The finding's own marker rides with the comment, because the thread
            // it opens is what the next round has to recognise.
            body:
              "Handle this failure.\n\n" +
              findingMarker("src/index.ts", "Handle this failure."),
            side: "RIGHT",
            line: 12,
            start_side: "RIGHT",
            start_line: 10,
          },
        ],
      });
      expect(mockOctokit.pulls.createReview.mock.calls[0]![0].body).not.toContain(
        "Two findings.",
      );
      // The summary is the pull request's own comment, marked with the pull
      // request's key so every later round finds it again, and with the bot marker
      // so the comment event it raises does not start another review round.
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body:
          "Two findings.\n\n<!-- ai-workflow-review:review-hash -->\n\n" +
          AI_WORKFLOW_COMMENT_MARKER,
      });
      expect(result).toEqual({
        id: "701",
        commentIds: ["801"],
      });
    });

    it("submits one verdict per head when the round is retried", async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([
          {
            id: 701,
            body:
              "## AI Workflow review\n\n" +
              "<!-- ai-workflow-review-head:reviewed-head -->",
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
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "Already published." }),
          reviewFindingDigest({ path: "src/missing.ts", body: "Provider omitted this comment." }),
        ],
      });

      expect(mockOctokit.pulls.createReview).not.toHaveBeenCalled();
      // Recognising the round is not the same as having finished it: the publish
      // call can succeed and the row that records it can be lost, so the summary
      // still has to be written on the way out.
      expect(mockOctokit.issues.createComment).toHaveBeenCalledTimes(1);
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
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "Already published." }),
        ],
      });

      // The key the marker is written from changed with the release; the review
      // on the pull request did not. Failing to recognise it here would greet
      // every open pull request with a second copy of its own review.
      expect(mockOctokit.pulls.createReview).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "701", commentIds: ["801"] });
    });

    // AIW-236's main requirement. Measured on our own PR #224, two rounds of
    // CodeRabbit left thirteen live threads and resolved, outdated or collapsed
    // exactly none of them.
    //
    // Hidden as OUTDATED and deliberately NOT resolved: this adapter cannot tell
    // "the defect was fixed" from "the reviewer worded it differently this round",
    // and only the first of those justifies a resolved tick.
    it("hides the thread of a finding this round no longer reports without resolving it", async () => {
      stubReviewThreads([
        thread({
          id: "thread-settled",
          commentId: "comment-node-settled",
          body: `Fixed since.\n\n${findingMarker("src/gone.ts", "Fixed since.")}`,
        }),
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 706 },
      });

      await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "approve",
        summary: "Nothing left.",
        comments: [],
        commentFindingDigests: [],
      });

      expect(graphqlCalls("minimizeComment")).toEqual([
        [expect.any(String), { subjectId: "comment-node-settled" }],
      ]);
      expect(graphqlCalls("resolveReviewThread")).toEqual([]);
    });

    // The case the digest cannot distinguish from a repair, and the reason the
    // sweep stopped claiming one. Agent prose is regenerated every round, so the
    // same defect routinely comes back under new wording and a new digest.
    it("hides the old thread and opens a new one when a finding is reworded", async () => {
      const before = "**High**: This can throw on an empty list.";
      const after = "**High**: An empty list makes this throw.";
      stubReviewThreads([
        thread({
          id: "thread-reworded",
          commentId: "comment-node-reworded",
          body: `${before}\n\n${findingMarker("src/index.ts", before)}`,
        }),
      ]);
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 830, path: "src/index.ts", line: 12, start_line: null },
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 713 },
      });

      await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          { path: "src/index.ts", body: after, startLine: 12, endLine: 12 },
        ],
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: after }),
        ],
      });

      // The old thread collapses as outdated, which is true, rather than resolved,
      // which would tell the reader a live defect was dealt with.
      expect(graphqlCalls("minimizeComment")).toEqual([
        [expect.any(String), { subjectId: "comment-node-reworded" }],
      ]);
      expect(graphqlCalls("resolveReviewThread")).toEqual([]);
      expect(
        mockOctokit.pulls.createReview.mock.calls[0]![0].comments[0].body,
      ).toContain(after);
    });

    // The path production actually takes. The workflow passes its own digests, and
    // they are deliberately NOT what the body hashes to: a published body carries
    // the agreement note and the identity excludes it. An adapter that re-derived
    // from the body would open threads under one identity and look them up under
    // another, which is the mismatch this whole seam exists to prevent.
    const callerDigest = "0123456789abcdef0123456789abcdef";
    const notedBody = "**High**: Still broken.\n\nBoth reviewers reported this.";

    it("marks a new thread with the caller's digest, not the body's", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 840, path: "src/index.ts", line: 9, start_line: null },
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 715 },
      });

      await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          { path: "src/index.ts", body: notedBody, startLine: 9, endLine: 9 },
        ],
        commentFindingDigests: [callerDigest],
      });

      const posted =
        mockOctokit.pulls.createReview.mock.calls[0]![0].comments[0].body;
      expect(posted).toContain(
        `<!-- ai-workflow-review-finding:${callerDigest} -->`,
      );
      expect(posted).not.toContain(
        reviewFindingDigest({ path: "src/index.ts", body: notedBody }),
      );
    });

    it("recognises an existing thread by the caller's digest", async () => {
      stubReviewThreads([
        thread({
          id: "thread-open",
          databaseId: 841,
          // Opened last round, under wording this round no longer uses. The caller
          // says it is the same finding, and the caller's word is what counts.
          body: `Older wording.\n\n<!-- ai-workflow-review-finding:${callerDigest} -->`,
        }),
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 716 },
      });

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          { path: "src/index.ts", body: notedBody, startLine: 9, endLine: 9 },
        ],
        commentFindingDigests: [callerDigest],
      });

      // Carried over, so no second copy and no outdated tick on a live finding.
      expect(
        mockOctokit.pulls.createReview.mock.calls[0]![0].comments,
      ).toEqual([]);
      expect(result.commentIds).toEqual(["841"]);
      expect(graphqlCalls("minimizeComment")).toEqual([]);
    });

    // The condition the plan set and the adapter could not previously even see:
    // it only ever read the thread's first comment.
    it("leaves a thread alone once a human has replied in it", async () => {
      const body = "**Nit**: Rename this.";
      stubReviewThreads([
        thread({
          id: "thread-discussed",
          commentId: "comment-node-discussed",
          body: `${body}\n\n${findingMarker("src/index.ts", body)}`,
          replies: [{ viewerDidAuthor: false }],
        }),
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 714 },
      });

      // This round no longer reports the finding, so the sweep would otherwise
      // collapse the thread and the reader's reply along with it.
      await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "approve",
        summary: "Nothing left.",
        comments: [],
        commentFindingDigests: [],
      });

      expect(graphqlCalls("minimizeComment")).toEqual([]);
      expect(graphqlCalls("resolveReviewThread")).toEqual([]);
    });

    // A finding the inline cap pushed into the summary is still standing. Settling
    // its thread would put "resolved" on the thread and "still open" in the summary
    // for one defect, which is worse than either alone.
    it("keeps the thread of a finding this round reports into the summary", async () => {
      const body = "**Nit**: Demoted by the cap this round.";
      stubReviewThreads([
        thread({
          id: "thread-deferred",
          databaseId: 814,
          body: `${body}\n\n${findingMarker("src/index.ts", body)}`,
        }),
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 712 },
      });

      await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "One finding, not shown inline.",
        // Not among the placed comments, and reported all the same.
        comments: [],
        commentFindingDigests: [],
        deferredFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body }),
        ],
      });

      expect(graphqlCalls("resolveReviewThread")).toEqual([]);
      expect(graphqlCalls("minimizeComment")).toEqual([]);
    });

    it("leaves a thread alone when this round still reports its finding", async () => {
      const body = "**High**: Handle this failure.";
      stubReviewThreads([
        thread({
          id: "thread-open",
          databaseId: 811,
          body: `${body}\n\n${findingMarker("src/index.ts", body)}`,
        }),
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 707 },
      });

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        // A force-push moved every line in the file and the finding came back at a
        // different one. The digest carries no position, so the thread is still
        // recognised and neither resolved nor restated.
        headSha: "force-pushed-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          { path: "src/index.ts", body, startLine: 40, endLine: 40 },
        ],
        commentFindingDigests: [reviewFindingDigest({ path: "src/index.ts", body })],
      });

      expect(graphqlCalls("resolveReviewThread")).toEqual([]);
      expect(mockOctokit.pulls.createReview.mock.calls[0]![0].comments).toEqual(
        [],
      );
      // The finding keeps the id of the thread it already has, so the run's record
      // of it does not go blank the moment it stops being reposted.
      expect(result.commentIds).toEqual(["811"]);
      // And it is named in the summary. Without this line the finding would be in
      // no artifact a reader treats as current, and an unfixed finding would read
      // as fixed.
      const summary = mockOctokit.issues.createComment.mock.calls[0]![0].body;
      expect(summary).toContain("### Findings already open on this pull request");
      expect(summary).toContain(
        "- `src/index.ts:40` — **High**: Handle this failure.",
      );
    });

    it("posts inline comments only for the findings this round adds", async () => {
      const kept = "**High**: Still broken.";
      stubReviewThreads([
        thread({
          id: "thread-open",
          databaseId: 812,
          body: `${kept}\n\n${findingMarker("src/index.ts", kept)}`,
        }),
      ]);
      mockOctokit.paginate.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 813, path: "src/new.ts", line: 7, start_line: null },
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 708 },
      });

      const result = await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "Two findings.",
        comments: [
          { path: "src/index.ts", body: kept, startLine: 12, endLine: 12 },
          { path: "src/new.ts", body: "**Nit**: New one.", startLine: 7, endLine: 7 },
        ],
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: kept }),
          reviewFindingDigest({ path: "src/new.ts", body: "**Nit**: New one." }),
        ],
      });

      expect(mockOctokit.pulls.createReview.mock.calls[0]![0].comments).toEqual([
        expect.objectContaining({ path: "src/new.ts" }),
      ]);
      expect(result.commentIds).toEqual(["812", "813"]);
    });

    it("edits the one summary comment instead of adding a second", async () => {
      mockOctokit.paginate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 5001, body: "A human said something else." },
          {
            id: 5002,
            body: "Round one.\n\n<!-- ai-workflow-review:review-hash -->",
          },
        ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 709 },
      });

      await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "approve",
        summary: "Round two.",
        comments: [],
        commentFindingDigests: [],
      });

      expect(mockOctokit.issues.createComment).not.toHaveBeenCalled();
      expect(mockOctokit.issues.updateComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        comment_id: 5002,
        body:
          "Round two.\n\n<!-- ai-workflow-review:review-hash -->\n\n" +
          AI_WORKFLOW_COMMENT_MARKER,
      });
    });

    // Ownership needs the marker AND our authorship, so neither of these is ours.
    // The pre-marker thread is the accepted cost: it stays open for good, which is
    // the safe direction now that the sweep writes on other people's threads.
    it("touches neither a pre-marker thread nor a marker somebody else pasted", async () => {
      const body = "**High**: Quoted from our review.";
      stubReviewThreads([
        thread({
          id: "thread-legacy",
          commentId: "comment-node-legacy",
          body: "Reported before this adapter marked its findings.",
          viewerDidAuthor: true,
        }),
        // Carries our marker, written by somebody else.
        thread({
          id: "thread-impostor",
          body: `${body}\n\n${findingMarker("src/index.ts", body)}`,
          viewerDidAuthor: false,
        }),
      ]);
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 710 },
      });

      await ghAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "approve",
        summary: "Nothing left.",
        comments: [],
        commentFindingDigests: [],
      });

      expect(graphqlCalls("minimizeComment")).toEqual([]);
      expect(graphqlCalls("resolveReviewThread")).toEqual([]);
    });

    // Sweeping before the review exists left the pull request collapsed and
    // review-less: every old thread hidden, nothing published to replace them.
    it("hides nothing when the review itself fails to publish", async () => {
      stubReviewThreads([
        thread({
          id: "thread-settled",
          commentId: "comment-node-settled",
          body: `Gone.\n\n${findingMarker("src/gone.ts", "Gone.")}`,
        }),
      ]);
      mockOctokit.pulls.createReview.mockRejectedValueOnce(
        Object.assign(new Error("GitHub is down"), { status: 500 }),
      );

      await expect(
        ghAdapter().publishPRReview(42, {
          idempotencyKey: "review-hash",
          headSha: "next-head",
          decision: "approve",
          summary: "Nothing left.",
          comments: [],
          commentFindingDigests: [],
        }),
      ).rejects.toThrow("GitHub is down");

      expect(graphqlCalls("minimizeComment")).toEqual([]);
      expect(mockOctokit.issues.createComment).not.toHaveBeenCalled();
    });

    it("still publishes when GitHub refuses to hide an outdated comment", async () => {
      stubReviewThreads([
        thread({
          id: "thread-settled",
          body: `Fixed.\n\n${findingMarker("src/gone.ts", "Fixed.")}`,
        }),
      ]);
      mockOctokit.graphql.mockImplementation(async (query: string) => {
        if (String(query).includes("reviewThreads(")) {
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    thread({
                      id: "thread-settled",
                      body: `Fixed.\n\n${findingMarker("src/gone.ts", "Fixed.")}`,
                    }),
                  ],
                },
              },
            },
          };
        }
        if (String(query).includes("minimizeComment")) {
          throw Object.assign(new Error("Resource not accessible"), {
            status: 403,
          });
        }
        return {};
      });
      mockOctokit.pulls.createReview.mockResolvedValueOnce({
        data: { id: 711 },
      });

      await expect(
        ghAdapter().publishPRReview(42, {
          idempotencyKey: "review-hash",
          headSha: "next-head",
          decision: "approve",
          summary: "Nothing left.",
          comments: [],
          commentFindingDigests: [],
        }),
      ).resolves.toEqual({ id: "711", commentIds: [] });

      // Collapsing an old comment is presentation and the round's findings are
      // already published by then, so a repository that forbids it must not cost
      // the pull request its review.
      expect(graphqlCalls("minimizeComment")).toHaveLength(1);
      expect(mockOctokit.issues.createComment).toHaveBeenCalledTimes(1);
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
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "Handle this failure." }),
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
        commentFindingDigests: [
          reviewFindingDigest({
            path: "src/index.ts",
            body: "**High**: Handle this failure.\n\nReported by 3 of 3 reviewers.",
          }),
          reviewFindingDigest({
            path: "src/other.ts",
            body: "**Medium**: Rename this helper.",
          }),
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
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "Handle this failure." }),
        ],
      });

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledTimes(2);
      expect(mockOctokit.pulls.createReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          event: "COMMENT",
          comments: [
            expect.objectContaining({
              path: "src/index.ts",
              body: expect.stringContaining("Handle this failure."),
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
        commentFindingDigests: [],
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
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "Handle this failure." }),
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
          commentFindingDigests: [],
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

  describe("review ledger", () => {
    // The adapter fires several distinct GraphQL documents at one mock, so route
    // them by operation name and let a test state only the responses it needs.
    function mockLedgerGraphql(responses: {
      viewer?: { login: string } | null;
      threadPages?: unknown[];
      node?: unknown;
    }) {
      const pages = [...(responses.threadPages ?? [])];
      mockOctokit.graphql.mockImplementation(async (query: string) => {
        if (query.includes("ledgerViewer")) return { viewer: responses.viewer ?? null };
        if (query.includes("ledgerReviewThreads")) {
          return pages.shift() ?? emptyThreadPage();
        }
        if (query.includes("ledgerReviewThreadNode")) return { node: responses.node ?? null };
        return {};
      });
    }

    function threadPage(nodes: unknown[], pageInfo?: { hasNextPage: boolean; endCursor: string | null }) {
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: pageInfo ?? { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      };
    }

    function emptyThreadPage() {
      return threadPage([]);
    }

    it("drops resolved inline threads from the feed", async () => {
      mockLedgerGraphql({
        viewer: { login: "aiw-bot" },
        threadPages: [
          threadPage([
            {
              id: "PRRT_done",
              isResolved: true,
              path: "src/a.ts",
              line: 10,
              comments: {
                nodes: [
                  {
                    id: "PRRC_1",
                    databaseId: 1,
                    body: "already handled",
                    createdAt: "2026-08-21T10:00:00Z",
                    viewerDidAuthor: false,
                    author: { login: "reviewer", __typename: "User" },
                  },
                ],
              },
            },
            {
              id: "PRRT_open",
              isResolved: false,
              path: "src/b.ts",
              line: 20,
              comments: {
                nodes: [
                  {
                    id: "PRRC_2",
                    databaseId: 2,
                    body: "still open",
                    createdAt: "2026-08-21T11:00:00Z",
                    viewerDidAuthor: false,
                    author: { login: "reviewer", __typename: "User" },
                  },
                ],
              },
            },
          ]),
        ],
      });

      const feed = await ghAdapter().listReviewThreads(42);

      expect(feed.threads.map((thread) => thread.threadId)).toEqual(["PRRT_open"]);
      expect(feed.truncated).toBe(0);
    });

    it("classifies an inline thread by who opened it", async () => {
      mockLedgerGraphql({
        viewer: { login: "aiw-bot" },
        threadPages: [
          threadPage([
            {
              id: "PRRT_ours",
              isResolved: false,
              path: "src/a.ts",
              line: 1,
              comments: {
                nodes: [
                  {
                    id: "PRRC_1",
                    databaseId: 1,
                    body: "we opened this",
                    createdAt: "2026-08-21T10:00:00Z",
                    viewerDidAuthor: true,
                    author: { login: "aiw-bot", __typename: "Bot" },
                  },
                ],
              },
            },
            {
              id: "PRRT_robot",
              isResolved: false,
              path: "src/b.ts",
              line: 2,
              comments: {
                nodes: [
                  {
                    id: "PRRC_2",
                    databaseId: 2,
                    body: "another bot opened this",
                    createdAt: "2026-08-21T10:01:00Z",
                    viewerDidAuthor: false,
                    author: { login: "coderabbitai", __typename: "Bot" },
                  },
                ],
              },
            },
            {
              id: "PRRT_person",
              isResolved: false,
              path: "src/c.ts",
              line: 3,
              comments: {
                nodes: [
                  {
                    id: "PRRC_3",
                    databaseId: 3,
                    body: "a person opened this",
                    createdAt: "2026-08-21T10:02:00Z",
                    viewerDidAuthor: false,
                    author: { login: "reviewer", __typename: "User" },
                  },
                ],
              },
            },
          ]),
        ],
      });

      const feed = await ghAdapter().listReviewThreads(42);
      const sources = Object.fromEntries(
        feed.threads.map((thread) => [thread.threadId, thread.source]),
      );

      expect(sources).toEqual({
        PRRT_ours: "bot",
        PRRT_robot: "third_party",
        PRRT_person: "human",
      });
    });

    it("treats an inline thread whose last note is a ledger reply as awaiting a human", async () => {
      mockLedgerGraphql({
        viewer: { login: "aiw-bot" },
        threadPages: [
          threadPage([
            {
              id: "PRRT_answered",
              isResolved: false,
              path: "src/a.ts",
              line: 4,
              comments: {
                nodes: [
                  {
                    id: "PRRC_1",
                    databaseId: 1,
                    body: "please rename this",
                    createdAt: "2026-08-21T10:00:00Z",
                    viewerDidAuthor: false,
                    author: { login: "reviewer", __typename: "User" },
                  },
                  {
                    id: "PRRC_2",
                    databaseId: 2,
                    body: "renamed. <!-- ai-workflow:ledger:PRRT_answered --> <!-- ai-workflow:bot -->",
                    createdAt: "2026-08-21T10:05:00Z",
                    viewerDidAuthor: true,
                    author: { login: "aiw-bot", __typename: "Bot" },
                  },
                ],
              },
            },
          ]),
        ],
      });

      const feed = await ghAdapter().listReviewThreads(42);

      expect(feed.threads).toHaveLength(1);
      expect(feed.threads[0]).toMatchObject({
        threadId: "PRRT_answered",
        awaitingHuman: true,
        source: "human",
      });
      expect(feed.threads[0]?.notes[1]?.isLedgerReply).toBe(true);
      expect(feed.truncated).toBe(0);
    });

    it("turns general pull request comments into unresolvable threads", async () => {
      mockLedgerGraphql({ viewer: { login: "aiw-bot" }, threadPages: [emptyThreadPage()] });
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.issues.listComments) {
          return [
            {
              id: 900,
              user: { login: "reviewer", type: "User" },
              body: "the whole approach needs rethinking",
              created_at: "2026-08-21T09:00:00Z",
            },
            {
              id: 901,
              user: { login: "coderabbitai", type: "Bot" },
              body: "automated summary",
              created_at: "2026-08-21T09:01:00Z",
            },
            {
              id: 902,
              user: { login: "aiw-bot", type: "Bot" },
              body: "our own status note",
              created_at: "2026-08-21T09:02:00Z",
            },
          ];
        }
        return [];
      });

      const feed = await ghAdapter().listReviewThreads(42);

      expect(
        Object.fromEntries(feed.threads.map((thread) => [thread.threadId, thread.source])),
      ).toEqual({
        "issue-comment:900": "human",
        "issue-comment:901": "third_party",
        "issue-comment:902": "bot",
      });
      const first = feed.threads[0];
      expect(first).toMatchObject({
        threadId: "issue-comment:900",
        alias: "T1",
        resolvable: false,
        awaitingHuman: false,
      });
      expect(first?.filePath).toBeUndefined();
      expect(first?.line).toBeUndefined();
      expect(first?.notes).toEqual([
        {
          author: "reviewer",
          body: "the whole approach needs rethinking",
          createdAt: "2026-08-21T09:00:00Z",
          isLedgerReply: false,
        },
      ]);
    });

    it("folds a ledger reply comment into the general thread it answers", async () => {
      mockLedgerGraphql({ viewer: { login: "aiw-bot" }, threadPages: [emptyThreadPage()] });
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.issues.listComments) {
          return [
            {
              id: 900,
              user: { login: "reviewer", type: "User" },
              body: "the whole approach needs rethinking",
              created_at: "2026-08-21T09:00:00Z",
            },
            {
              id: 903,
              user: { login: "aiw-bot", type: "Bot" },
              body: "reworked it. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
              created_at: "2026-08-21T09:30:00Z",
            },
          ];
        }
        return [];
      });

      const feed = await ghAdapter().listReviewThreads(42);

      expect(feed.threads).toHaveLength(1);
      expect(feed.threads[0]).toMatchObject({
        threadId: "issue-comment:900",
        alias: "T1",
        awaitingHuman: true,
      });
    });

    it("carries a review summary body as its own thread and ignores empty reviews", async () => {
      mockLedgerGraphql({ viewer: { login: "aiw-bot" }, threadPages: [emptyThreadPage()] });
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.pulls.listReviews) {
          return [
            {
              id: 700,
              user: { login: "reviewer", type: "User" },
              state: "CHANGES_REQUESTED",
              body: "please split this into two commits",
              submitted_at: "2026-08-21T08:00:00Z",
            },
            {
              id: 701,
              user: { login: "reviewer", type: "User" },
              state: "APPROVED",
              body: "",
              submitted_at: "2026-08-21T08:05:00Z",
            },
          ];
        }
        return [];
      });

      const feed = await ghAdapter().listReviewThreads(42);

      expect(feed.threads).toHaveLength(1);
      expect(feed.threads[0]).toMatchObject({
        threadId: "review:700",
        resolvable: false,
        source: "human",
      });
      expect(feed.threads[0]?.notes[0]?.body).toBe("please split this into two commits");
    });

    it("aliases threads T1..Tn by first note across inline and general threads", async () => {
      mockLedgerGraphql({
        viewer: { login: "aiw-bot" },
        threadPages: [
          threadPage([
            {
              id: "PRRT_answered",
              isResolved: false,
              path: "src/answered.ts",
              line: 7,
              comments: {
                nodes: [
                  {
                    id: "PRRC_0",
                    databaseId: 10,
                    body: "oldest of them all",
                    createdAt: "2026-08-21T08:00:00Z",
                    viewerDidAuthor: false,
                    author: { login: "reviewer", __typename: "User" },
                  },
                  {
                    id: "PRRC_0b",
                    databaseId: 11,
                    body: "done. <!-- ai-workflow:ledger:PRRT_answered --> <!-- ai-workflow:bot -->",
                    createdAt: "2026-08-21T08:30:00Z",
                    viewerDidAuthor: true,
                    author: { login: "aiw-bot", __typename: "Bot" },
                  },
                ],
              },
            },
            {
              id: "PRRT_second",
              isResolved: false,
              path: "src/b.ts",
              line: 42,
              comments: {
                nodes: [
                  {
                    id: "PRRC_1",
                    databaseId: 1,
                    body: "second oldest",
                    createdAt: "2026-08-21T10:00:00Z",
                    viewerDidAuthor: false,
                    author: { login: "reviewer", __typename: "User" },
                  },
                ],
              },
            },
            {
              id: "PRRT_fourth",
              isResolved: false,
              path: "src/d.ts",
              line: 3,
              comments: {
                nodes: [
                  {
                    id: "PRRC_2",
                    databaseId: 2,
                    body: "newest",
                    createdAt: "2026-08-21T12:00:00Z",
                    viewerDidAuthor: false,
                    author: { login: "reviewer", __typename: "User" },
                  },
                ],
              },
            },
          ]),
        ],
      });
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.issues.listComments) {
          return [
            {
              id: 900,
              user: { login: "reviewer", type: "User" },
              body: "oldest work item",
              created_at: "2026-08-21T09:00:00Z",
            },
            {
              id: 901,
              user: { login: "reviewer", type: "User" },
              body: "third oldest",
              created_at: "2026-08-21T11:00:00Z",
            },
          ];
        }
        return [];
      });

      const feed = await ghAdapter().listReviewThreads(42);

      expect(feed.threads.map((thread) => [thread.alias, thread.threadId])).toEqual([
        ["T1", "issue-comment:900"],
        ["T2", "PRRT_second"],
        ["T3", "issue-comment:901"],
        ["T4", "PRRT_fourth"],
        // Answered already, so it trails the work items no matter how old it is.
        ["T5", "PRRT_answered"],
      ]);
      expect(feed.threads[1]).toMatchObject({ filePath: "src/b.ts", line: 42 });
      expect(feed.truncated).toBe(0);
    });

    it("keeps twenty work items and reports the rest as truncated", async () => {
      const nodes = Array.from({ length: 22 }, (_unused, index) => ({
        id: `PRRT_${String(index).padStart(2, "0")}`,
        isResolved: false,
        path: "src/a.ts",
        line: index + 1,
        comments: {
          nodes: [
            {
              id: `PRRC_${index}`,
              databaseId: index,
              body: `finding ${index}`,
              createdAt: `2026-08-21T10:${String(index).padStart(2, "0")}:00Z`,
              viewerDidAuthor: false,
              author: { login: "reviewer", __typename: "User" },
            },
          ],
        },
      }));
      mockLedgerGraphql({ viewer: { login: "aiw-bot" }, threadPages: [threadPage(nodes)] });

      const feed = await ghAdapter().listReviewThreads(42);

      expect(feed.threads).toHaveLength(20);
      expect(feed.threads[0]?.threadId).toBe("PRRT_00");
      expect(feed.threads[19]).toMatchObject({ alias: "T20", threadId: "PRRT_19" });
      expect(feed.truncated).toBe(2);
    });

    function ledgerThread(overrides: Partial<ReviewThread> & { threadId: string }): ReviewThread {
      return {
        alias: "T1",
        source: "human",
        resolvable: true,
        awaitingHuman: false,
        notes: [
          {
            author: "reviewer",
            body: "please rename this symbol",
            createdAt: "2026-08-21T10:00:00Z",
            isLedgerReply: false,
          },
        ],
        ...overrides,
      };
    }

    function resolveMutationCalls() {
      return mockOctokit.graphql.mock.calls.filter((call) =>
        String(call[0]).includes("resolveReviewThread"),
      );
    }

    it("does not answer an inline thread twice without new human activity", async () => {
      mockLedgerGraphql({
        node: {
          isResolved: false,
          comments: {
            nodes: [
              {
                databaseId: 1,
                body: "please rename this symbol",
                createdAt: "2026-08-21T10:00:00Z",
                viewerDidAuthor: false,
                author: { login: "reviewer" },
              },
              {
                databaseId: 2,
                body: "renamed. <!-- ai-workflow:ledger:PRRT_x --> <!-- ai-workflow:bot -->",
                createdAt: "2026-08-21T10:05:00Z",
                viewerDidAuthor: true,
                author: { login: "aiw-bot" },
              },
            ],
          },
        },
      });

      const result = await ghAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread({ threadId: "PRRT_x" }),
        body: "renamed. <!-- ai-workflow:ledger:PRRT_x --> <!-- ai-workflow:bot -->",
        resolve: true,
        snapshotAt: "2026-08-21T11:00:00Z",
      });

      expect(result).toEqual({ action: "skipped_existing_reply" });
      expect(mockOctokit.pulls.createReplyForReviewComment).not.toHaveBeenCalled();
      expect(resolveMutationCalls()).toHaveLength(0);
    });

    it("replies without resolving when a human spoke after the snapshot", async () => {
      mockLedgerGraphql({
        node: {
          isResolved: false,
          comments: {
            nodes: [
              {
                databaseId: 1,
                body: "please rename this symbol",
                createdAt: "2026-08-21T10:00:00Z",
                viewerDidAuthor: false,
                author: { login: "reviewer" },
              },
              {
                databaseId: 3,
                body: "actually, leave it, I changed my mind",
                createdAt: "2026-08-21T11:30:00Z",
                viewerDidAuthor: false,
                author: { login: "reviewer" },
              },
            ],
          },
        },
      });

      const result = await ghAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread({ threadId: "PRRT_x" }),
        body: "renamed. <!-- ai-workflow:ledger:PRRT_x --> <!-- ai-workflow:bot -->",
        resolve: true,
        snapshotAt: "2026-08-21T11:00:00Z",
      });

      expect(result).toEqual({ action: "replied_without_resolve_human_activity" });
      // The reply is addressed to the thread's first comment, the only id GitHub's
      // REST reply endpoint accepts.
      expect(mockOctokit.pulls.createReplyForReviewComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
        comment_id: 1,
        body: "renamed. <!-- ai-workflow:ledger:PRRT_x --> <!-- ai-workflow:bot -->",
      });
      expect(resolveMutationCalls()).toHaveLength(0);
    });

    it("replies and resolves an untouched inline thread", async () => {
      mockLedgerGraphql({
        node: {
          isResolved: false,
          comments: {
            nodes: [
              {
                databaseId: 1,
                body: "please rename this symbol",
                createdAt: "2026-08-21T10:00:00Z",
                viewerDidAuthor: false,
                author: { login: "reviewer" },
              },
            ],
          },
        },
      });

      const result = await ghAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread({ threadId: "PRRT_x" }),
        body: "renamed. <!-- ai-workflow:ledger:PRRT_x --> <!-- ai-workflow:bot -->",
        resolve: true,
        snapshotAt: "2026-08-21T11:00:00Z",
      });

      expect(result).toEqual({ action: "replied_and_resolved" });
      expect(mockOctokit.pulls.createReplyForReviewComment).toHaveBeenCalledOnce();
      expect(resolveMutationCalls()).toEqual([
        [expect.stringContaining("resolveReviewThread"), { threadId: "PRRT_x" }],
      ]);
    });

    it("replies without resolving when the disposition does not claim a fix", async () => {
      mockLedgerGraphql({
        node: {
          isResolved: false,
          comments: {
            nodes: [
              {
                databaseId: 1,
                body: "why is this here at all?",
                createdAt: "2026-08-21T10:00:00Z",
                viewerDidAuthor: false,
                author: { login: "reviewer" },
              },
            ],
          },
        },
      });

      const result = await ghAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread({ threadId: "PRRT_x" }),
        body: "it guards the retry path. <!-- ai-workflow:ledger:PRRT_x --> <!-- ai-workflow:bot -->",
        resolve: false,
        snapshotAt: "2026-08-21T11:00:00Z",
      });

      expect(result).toEqual({ action: "replied" });
      expect(mockOctokit.pulls.createReplyForReviewComment).toHaveBeenCalledOnce();
      expect(resolveMutationCalls()).toHaveLength(0);
    });

    function generalThread(body: string, createdAt = "2026-08-21T09:00:00Z") {
      return ledgerThread({
        threadId: "issue-comment:900",
        resolvable: false,
        notes: [{ author: "reviewer", body, createdAt, isLedgerReply: false }],
      });
    }

    it("answers a general thread with a quote and never resolves it", async () => {
      mockLedgerGraphql({ viewer: { login: "aiw-bot" } });
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.issues.listComments) {
          return [
            {
              id: 900,
              user: { login: "reviewer", type: "User" },
              body: "the whole approach needs rethinking\nand here is why",
              created_at: "2026-08-21T09:00:00Z",
            },
          ];
        }
        return [];
      });

      const result = await ghAdapter().settleReviewThread({
        prId: 42,
        thread: generalThread("the whole approach needs rethinking\nand here is why"),
        // `resolve` is honoured only by threads GitHub can resolve; this one cannot.
        resolve: true,
        body: "reworked it. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
        snapshotAt: "2026-08-21T11:00:00Z",
      });

      expect(result).toEqual({ action: "replied" });
      expect(resolveMutationCalls()).toHaveLength(0);
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body:
          "> the whole approach needs rethinking\n\n" +
          "reworked it. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
      });
    });

    it("clips the quoted line of a general thread at 200 characters", async () => {
      mockLedgerGraphql({ viewer: { login: "aiw-bot" } });
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.issues.listComments) {
          return [
            {
              id: 900,
              user: { login: "reviewer", type: "User" },
              body: "a".repeat(250),
              created_at: "2026-08-21T09:00:00Z",
            },
          ];
        }
        return [];
      });

      await ghAdapter().settleReviewThread({
        prId: 42,
        thread: generalThread("a".repeat(250)),
        resolve: false,
        body: "noted. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
        snapshotAt: "2026-08-21T11:00:00Z",
      });

      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body:
            `> ${"a".repeat(200)}\n\n` +
            "noted. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
        }),
      );
    });

    it("does not answer a general thread twice without new human activity", async () => {
      mockLedgerGraphql({ viewer: { login: "aiw-bot" } });
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.issues.listComments) {
          return [
            {
              id: 900,
              user: { login: "reviewer", type: "User" },
              body: "the whole approach needs rethinking",
              created_at: "2026-08-21T09:00:00Z",
            },
            {
              id: 903,
              user: { login: "aiw-bot", type: "Bot" },
              body: "reworked it. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
              created_at: "2026-08-21T09:30:00Z",
            },
          ];
        }
        return [];
      });

      const result = await ghAdapter().settleReviewThread({
        prId: 42,
        thread: generalThread("the whole approach needs rethinking"),
        resolve: false,
        body: "reworked it again. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
        snapshotAt: "2026-08-21T11:00:00Z",
      });

      expect(result).toEqual({ action: "skipped_existing_reply" });
      expect(mockOctokit.issues.createComment).not.toHaveBeenCalled();
    });

    it("answers a general thread again when a human commented after the snapshot", async () => {
      mockLedgerGraphql({ viewer: { login: "aiw-bot" } });
      mockOctokit.paginate.mockImplementation(async (endpoint: unknown) => {
        if (endpoint === mockOctokit.issues.listComments) {
          return [
            {
              id: 900,
              user: { login: "reviewer", type: "User" },
              body: "the whole approach needs rethinking",
              created_at: "2026-08-21T09:00:00Z",
            },
            {
              id: 903,
              user: { login: "aiw-bot", type: "Bot" },
              body: "reworked it. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
              created_at: "2026-08-21T09:30:00Z",
            },
            {
              id: 904,
              user: { login: "reviewer", type: "User" },
              body: "that is not what I meant",
              created_at: "2026-08-21T11:30:00Z",
            },
          ];
        }
        return [];
      });

      const result = await ghAdapter().settleReviewThread({
        prId: 42,
        thread: generalThread("the whole approach needs rethinking"),
        resolve: true,
        body: "taking another look. <!-- ai-workflow:ledger:issue-comment:900 --> <!-- ai-workflow:bot -->",
        snapshotAt: "2026-08-21T11:00:00Z",
      });

      expect(result).toEqual({ action: "replied_without_resolve_human_activity" });
      expect(mockOctokit.issues.createComment).toHaveBeenCalledOnce();
      expect(resolveMutationCalls()).toHaveLength(0);
    });

    it("posts a run failure note once per run", async () => {
      mockOctokit.paginate.mockResolvedValue([]);

      await ghAdapter().postRunFailureNote({
        prId: 42,
        runId: "wrun_1",
        body: "The review run failed before it could answer the open threads.",
      });

      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body:
          "The review run failed before it could answer the open threads.\n\n" +
          "<!-- ai-workflow:ledger-failure:wrun_1 --> <!-- ai-workflow:bot -->",
      });
    });

    it("does not repeat a run failure note already on the pull request", async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 905,
          user: { login: "aiw-bot", type: "Bot" },
          body: "The review run failed. <!-- ai-workflow:ledger-failure:wrun_1 --> <!-- ai-workflow:bot -->",
          created_at: "2026-08-21T09:00:00Z",
        },
      ]);

      await ghAdapter().postRunFailureNote({
        prId: 42,
        runId: "wrun_1",
        body: "The review run failed before it could answer the open threads.",
      });

      expect(mockOctokit.issues.createComment).not.toHaveBeenCalled();
    });

    it("follows the review thread pagination cursor to the last page", async () => {
      mockLedgerGraphql({
        viewer: { login: "aiw-bot" },
        threadPages: [
          threadPage(
            [
              {
                id: "PRRT_page1",
                isResolved: false,
                path: "src/a.ts",
                line: 1,
                comments: {
                  nodes: [
                    {
                      id: "PRRC_1",
                      databaseId: 1,
                      body: "first page finding",
                      createdAt: "2026-08-21T10:00:00Z",
                      viewerDidAuthor: false,
                      author: { login: "reviewer", __typename: "User" },
                    },
                  ],
                },
              },
            ],
            { hasNextPage: true, endCursor: "c1" },
          ),
          threadPage([
            {
              id: "PRRT_page2",
              isResolved: false,
              path: "src/b.ts",
              line: 2,
              comments: {
                nodes: [
                  {
                    id: "PRRC_2",
                    databaseId: 2,
                    body: "second page finding",
                    createdAt: "2026-08-21T10:05:00Z",
                    viewerDidAuthor: false,
                    author: { login: "reviewer", __typename: "User" },
                  },
                ],
              },
            },
          ]),
        ],
      });

      const feed = await ghAdapter().listReviewThreads(42);

      // A pull request past a hundred threads must not silently lose the tail:
      // dropped findings would read to the agent as findings that do not exist.
      expect(feed.threads.map((thread) => thread.threadId)).toEqual([
        "PRRT_page1",
        "PRRT_page2",
      ]);
      const threadQueryCalls = mockOctokit.graphql.mock.calls.filter((call) =>
        String(call[0]).includes("ledgerReviewThreads"),
      );
      expect(threadQueryCalls).toHaveLength(2);
      expect(threadQueryCalls[0]?.[1]).toEqual({
        owner: "test-org",
        repo: "test-repo",
        number: 42,
        cursor: null,
      });
      // The second page is requested from the cursor the first page handed back.
      expect(threadQueryCalls[1]?.[1]).toEqual({
        owner: "test-org",
        repo: "test-repo",
        number: 42,
        cursor: "c1",
      });
    });
  });
});
