import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabAdapter } from "./gitlab.js";
import { reviewFindingDigest } from "./types.js";
import type { ReviewThread } from "./types.js";
import { AI_WORKFLOW_COMMENT_MARKER } from "../../lib/vcs-bot-identity.js";

const mockBranches = {
  create: vi.fn(),
  remove: vi.fn(),
  show: vi.fn(),
};

const mockRepositoryFiles = {
  create: vi.fn(),
  show: vi.fn(),
};

const mockCommits = {
  create: vi.fn(),
};

const mockMergeRequests = {
  create: vi.fn(),
  all: vi.fn(),
  show: vi.fn(),
  allPipelines: vi.fn(),
};

const mockMergeRequestNotes = {
  all: vi.fn(),
};

const mockMergeRequestDiscussions = {
  all: vi.fn(),
};

const mockJobs = {
  all: vi.fn(),
  showLog: vi.fn(),
};
const mockPipelines = {
  show: vi.fn(),
};

const mockFetch = vi.fn();

function gitLabResponse(
  body: unknown,
  options: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
) {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: options.statusText ?? "",
    headers: new Headers(options.headers ?? {}),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

vi.mock("@gitbeaker/rest", () => ({
  Gitlab: vi.fn(() => ({
    Branches: mockBranches,
    RepositoryFiles: mockRepositoryFiles,
    Commits: mockCommits,
    MergeRequests: mockMergeRequests,
    MergeRequestNotes: mockMergeRequestNotes,
    MergeRequestDiscussions: mockMergeRequestDiscussions,
    Jobs: mockJobs,
    Pipelines: mockPipelines,
  })),
}));

function glAdapter() {
  return new GitLabAdapter({
    token: "glpat-xxxxxxxxxxxx",
    projectId: "blazity/demo-app",
    baseBranch: "main",
  });
}

describe("GitLabAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  describe("branch ownership operations", () => {
    it("creates branch from base ref", async () => {
      mockBranches.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await expect(
        adapter.createBranchIfMissing("feat/test", "main"),
      ).resolves.toBe("created");

      expect(mockBranches.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
        "main",
      );
    });

    it("seeds empty repo on 404 then creates branch", async () => {
      const error = new Error("404 Branch Not Found") as any;
      error.cause = { response: { status: 404 } };
      mockBranches.create.mockRejectedValueOnce(error);
      mockRepositoryFiles.create.mockResolvedValueOnce({
        branch: "main",
      });
      mockBranches.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await expect(
        adapter.createBranchIfMissing("feat/test", "main"),
      ).resolves.toBe("created");

      expect(mockRepositoryFiles.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "README.md",
        "main",
        "Initial commit",
        "# Repository\n",
      );
      expect(mockBranches.create).toHaveBeenCalledTimes(2);
    });

    it("reports an existing branch without deleting it on 400", async () => {
      const error = new Error("Branch already exists") as any;
      error.cause = { response: { status: 400 } };
      mockBranches.create.mockRejectedValueOnce(error);

      const adapter = glAdapter();
      await expect(
        adapter.createBranchIfMissing("feat/test", "main"),
      ).resolves.toBe("existing");

      expect(mockBranches.remove).not.toHaveBeenCalled();
      expect(mockBranches.create).toHaveBeenCalledOnce();
    });

    it("resets only through the explicit owned-branch operation", async () => {
      mockBranches.remove.mockResolvedValueOnce({});
      mockBranches.create.mockResolvedValueOnce({});

      await glAdapter().resetOwnedBranch("feat/test", "main");

      expect(mockBranches.remove).toHaveBeenCalledWith("blazity/demo-app", "feat/test");
      expect(mockBranches.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
        "main",
      );
    });

    it("rethrows other 400 errors (invalid ref, invalid name) without deleting branch", async () => {
      const error = new Error("Invalid branch name") as any;
      error.cause = { response: { status: 400 } };
      mockBranches.create.mockRejectedValueOnce(error);

      const adapter = glAdapter();
      await expect(
        adapter.createBranchIfMissing("bad..name", "main"),
      ).rejects.toThrow("Invalid branch name");
      expect(mockBranches.remove).not.toHaveBeenCalled();
    });

    it("handles alternate gitbeaker error shapes (response.statusCode)", async () => {
      const error = new Error("404 Branch Not Found") as any;
      error.response = { statusCode: 404 };
      mockBranches.create.mockRejectedValueOnce(error);
      mockRepositoryFiles.create.mockResolvedValueOnce({ branch: "main" });
      mockBranches.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.createBranchIfMissing("feat/test", "main");

      expect(mockRepositoryFiles.create).toHaveBeenCalled();
    });
  });

  describe("createPR", () => {
    it("creates a merge request", async () => {
      mockMergeRequests.create.mockResolvedValueOnce({
        iid: 42,
        web_url: "https://gitlab.com/blazity/demo-app/-/merge_requests/42",
      });

      const adapter = glAdapter();
      const pr = await adapter.createPR("feat/test", "Add feature", "Description");

      expect(pr.id).toBe(42);
      expect(pr.url).toContain("/merge_requests/42");
      expect(pr.branch).toBe("feat/test");
      expect(mockMergeRequests.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
        "main",
        "Add feature",
        { description: "Description" },
      );
    });

    it("throws FatalError on 409", async () => {
      const error = new Error("MR already exists") as any;
      error.cause = { response: { status: 409 } };
      mockMergeRequests.create.mockRejectedValueOnce(error);

      const adapter = glAdapter();
      await expect(
        adapter.createPR("feat/test", "Title", "Body"),
      ).rejects.toThrow("MR already exists");
    });

    it("throws FatalError on 404", async () => {
      const error = new Error("Project not found") as any;
      error.cause = { response: { status: 404 } };
      mockMergeRequests.create.mockRejectedValueOnce(error);

      const adapter = glAdapter();
      await expect(
        adapter.createPR("feat/test", "Title", "Body"),
      ).rejects.toThrow("Project not found");
    });

    it.each([400, 422])("throws FatalError on deterministic %i validation failures", async (status) => {
      const error = new Error("Merge request policy rejected the request") as any;
      error.cause = { response: { status } };
      mockMergeRequests.create.mockRejectedValueOnce(error);

      const caught = await glAdapter()
        .createPR("feat/test", "Title", "Body")
        .catch((failure) => failure as Error);

      expect(caught).toMatchObject({
        name: "FatalError",
        message: "Merge request policy rejected the request",
      });
    });
  });

  describe("push", () => {
    it("marks existing files as update and new files as create", async () => {
      // src/index.ts already exists on branch; src/new.ts does not.
      mockRepositoryFiles.show.mockImplementation((_pid: string, path: string) => {
        if (path === "src/new.ts") {
          const err = new Error("404") as any;
          err.cause = { response: { status: 404 } };
          return Promise.reject(err);
        }
        return Promise.resolve({ file_path: path });
      });
      mockCommits.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.push("feat/test", [
        { path: "src/index.ts", content: "console.log('hello');" },
        { path: "src/new.ts", content: "export const add = (a: number, b: number) => a + b;" },
      ]);

      expect(mockCommits.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
        "feat: agent implementation",
        [
          { action: "update", filePath: "src/index.ts", content: "console.log('hello');" },
          { action: "create", filePath: "src/new.ts", content: "export const add = (a: number, b: number) => a + b;" },
        ],
      );
    });

    it("uses custom commit message when provided", async () => {
      mockRepositoryFiles.show.mockResolvedValueOnce({ file_path: "a.ts" });
      mockCommits.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.push(
        "feat/test",
        [{ path: "a.ts", content: "x" }],
        { message: "chore: custom message" },
      );

      expect(mockCommits.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
        "chore: custom message",
        expect.any(Array),
      );
    });

    it("rethrows non-404 errors from file existence probe", async () => {
      const err = new Error("500 Internal Server Error") as any;
      err.cause = { response: { status: 500 } };
      mockRepositoryFiles.show.mockRejectedValueOnce(err);

      const adapter = glAdapter();
      await expect(
        adapter.push("feat/test", [{ path: "a.ts", content: "x" }]),
      ).rejects.toThrow("500 Internal Server Error");
      expect(mockCommits.create).not.toHaveBeenCalled();
    });

    it("throws FatalError when mergeParentSha is requested (unsupported on GitLab)", async () => {
      const adapter = glAdapter();
      await expect(
        adapter.push(
          "feat/test",
          [{ path: "a.ts", content: "x" }],
          { mergeParentSha: "deadbeef" },
        ),
      ).rejects.toThrow(/does not support merge-commit push/);
      expect(mockCommits.create).not.toHaveBeenCalled();
    });
  });

  describe("getBranchSha", () => {
    it("returns the commit SHA of a branch", async () => {
      mockBranches.show.mockResolvedValueOnce({
        commit: { id: "abc123def456" },
      });

      const adapter = glAdapter();
      const sha = await adapter.getBranchSha("feat/test");

      expect(sha).toBe("abc123def456");
      expect(mockBranches.show).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
      );
    });

    it("returns null only for an authoritatively missing branch", async () => {
      mockBranches.show.mockRejectedValueOnce(
        Object.assign(new Error("Not Found"), { response: { status: 404 } }),
      );

      await expect(
        glAdapter().getBranchShaIfExists("feat/missing"),
      ).resolves.toBeNull();
    });
  });

  describe("getPRHead", () => {
    it("reads the authoritative open MR identity and current head-pipeline state", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({
        diff_refs: { head_sha: "source-head-sha" },
        target_branch: "release",
        state: "opened",
        head_pipeline: { id: 901, status: "failed" },
      });
      mockJobs.all.mockResolvedValueOnce([
        { id: 11, name: "lint", status: "success" },
        { id: 12, name: "test", status: "failed" },
      ]);

      const adapter = glAdapter();

      await expect(adapter.getPRHead(42)).resolves.toEqual({
        headSha: "source-head-sha",
        baseRef: "release",
        state: "open",
        headPipelineId: 901,
        headPipelineStatus: "failed",
        headPipelineFailedChecks: [{ id: 12, name: "test" }],
      });
      expect(mockMergeRequests.show).toHaveBeenCalledWith("blazity/demo-app", 42);
      expect(mockJobs.all).toHaveBeenCalledWith("blazity/demo-app", {
        pipelineId: 901,
      });
      expect(mockBranches.show).not.toHaveBeenCalled();
    });

    it("normalizes GitLab's merged lifecycle state", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({
        diff_refs: { head_sha: "source-head-sha" },
        target_branch: "main",
        state: "merged",
      });

      await expect(glAdapter().getPRHead(42)).resolves.toEqual({
        headSha: "source-head-sha",
        baseRef: "main",
        state: "merged",
      });
    });
  });

  describe("getManualDispatchPullRequest", () => {
    it("returns current MR pipeline failures and human review comments", async () => {
      mockMergeRequests.show
        .mockResolvedValueOnce({
          web_url: "https://gitlab.com/blazity/demo-app/-/merge_requests/42",
          source_branch: "feature/manual",
          target_branch: "main",
          title: "Manual dispatch",
          author: { username: "alice" },
          draft: false,
          state: "opened",
          diff_refs: { head_sha: "head-sha" },
          head_pipeline: { id: 901, status: "failed" },
        })
        .mockResolvedValueOnce({
          target_branch: "main",
          state: "opened",
          diff_refs: { head_sha: "head-sha" },
          head_pipeline: { id: 901, status: "failed" },
        });
      mockJobs.all.mockResolvedValueOnce([
        { id: 11, name: "lint", status: "failed" },
      ]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        {
          author: { username: "reviewer" },
          body: "Please cover the retry path.",
          system: false,
          type: null,
        },
      ]);
      mockPipelines.show.mockResolvedValueOnce({
        id: 901,
        source: "merge_request_event",
      });

      await expect(
        glAdapter().getManualDispatchPullRequest(42),
      ).resolves.toMatchObject({
        prNumber: 42,
        headRef: "feature/manual",
        headSha: "head-sha",
        baseRef: "main",
        state: "open",
        pipelineId: 901,
        pipelineSource: "merge_request_event",
        failedChecks: [{ name: "lint", conclusion: "failed" }],
        reviews: [
          {
            state: "commented",
            author: "reviewer",
            body: "Please cover the retry path.",
          },
        ],
      });
    });
  });

  describe("findPR", () => {
    it("returns null when no MR exists", async () => {
      mockMergeRequests.all.mockResolvedValueOnce([]);

      const adapter = glAdapter();
      const pr = await adapter.findPR("feat/test");
      expect(pr).toBeNull();
    });

    it("returns MR when one exists", async () => {
      mockMergeRequests.all.mockResolvedValueOnce([
        {
          iid: 42,
          web_url: "https://gitlab.com/blazity/demo-app/-/merge_requests/42",
          source_branch: "feat/test",
        },
      ]);

      const adapter = glAdapter();
      const pr = await adapter.findPR("feat/test");
      expect(pr).not.toBeNull();
      expect(pr!.id).toBe(42);
      expect(pr!.branch).toBe("feat/test");
      expect(mockMergeRequests.all).toHaveBeenCalledWith({
        projectId: "blazity/demo-app",
        sourceBranch: "feat/test",
        targetBranch: "main",
        state: "opened",
      });
    });
  });

  describe("getPRHeadSha", () => {
    it("returns the provider's current merge request head", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({ sha: "current-head" });

      await expect(glAdapter().getPRHeadSha(42)).resolves.toBe("current-head");
      expect(mockMergeRequests.show).toHaveBeenCalledWith("blazity/demo-app", 42);
    });

    it("throws FatalError when the merge request is deterministically unavailable", async () => {
      const error = new Error("Merge request not found") as any;
      error.cause = { response: { status: 404 } };
      mockMergeRequests.show.mockRejectedValueOnce(error);

      const caught = await glAdapter().getPRHeadSha(42).catch((failure) => failure as Error);

      expect(caught).toMatchObject({ name: "FatalError", message: "Merge request not found" });
    });
  });

  describe("getPRComments", () => {
    it("combines discussion notes and general notes", async () => {
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          notes: [
            {
              author: { username: "reviewer1" },
              body: "Inline comment on line 10",
              system: false,
              type: "DiffNote",
              position: { new_path: "src/index.ts", new_line: 10 },
            },
          ],
        },
      ]);
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        {
          author: { username: "reviewer2" },
          body: "General comment",
          system: false,
          type: null,
        },
      ]);

      const adapter = glAdapter();
      const comments = await adapter.getPRComments(42);

      expect(comments).toHaveLength(2);
      expect(comments[0]).toEqual({
        author: "reviewer1",
        body: "Inline comment on line 10",
        liked: false,
        filePath: "src/index.ts",
        startLine: 10,
        endLine: 10,
      });
      expect(comments[1]).toEqual({
        author: "reviewer2",
        body: "General comment",
        liked: false,
      });
    });
  });

  describe("postPRComment", () => {
    it("posts an MR note and returns a reconstructed deep link", async () => {
      mockFetch.mockResolvedValueOnce(gitLabResponse({ id: 555 }, { status: 201 }));

      const adapter = glAdapter();
      const result = await adapter.postPRComment(42, "Please rebase");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes",
        expect.objectContaining({
          method: "POST",
          headers: {
            "PRIVATE-TOKEN": "glpat-xxxxxxxxxxxx",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: "Please rebase" }),
        }),
      );
      expect(result).toEqual({
        url: "https://gitlab.com/blazity/demo-app/-/merge_requests/42#note_555",
      });
    });

    it("returns url null when the project id is numeric (no derivable web path)", async () => {
      mockFetch.mockResolvedValueOnce(gitLabResponse({ id: 555 }, { status: 201 }));

      const adapter = new GitLabAdapter({
        token: "glpat-xxxxxxxxxxxx",
        projectId: "12345",
        baseBranch: "main",
      });
      const result = await adapter.postPRComment(42, "hi");

      expect(result).toEqual({ url: null });
    });
  });

  describe("publishPRReview", () => {
    const findingMarker = (path: string, body: string) =>
      `<!-- ai-workflow-review-finding:${reviewFindingDigest({ path, body })} -->`;

    // The token's own username. A discussion counts as this workflow's only when
    // its opening note carries a finding marker AND was written by this account,
    // so every owned fixture below names it and the adapter looks it up via /user.
    const BOT = "ai-workflow-bot";
    const botNote = (body: string, resolved = false) => ({
      body,
      resolved,
      author: { username: BOT },
    });
    const stubCurrentUser = () =>
      mockFetch.mockResolvedValueOnce(gitLabResponse({ username: BOT }));

    it("retries approval when this head is already summarised", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        {
          id: 555,
          body:
            "Approved.\n\n<!-- ai-workflow-review:review-hash -->\n\n" +
            "<!-- ai-workflow-review-head:reviewed-head -->",
        },
      ]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockFetch.mockResolvedValueOnce(gitLabResponse({}));

      const result = await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "approve",
        summary: "Approved.",
        comments: [],
        commentFindingDigests: [],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/approve",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ sha: "reviewed-head" }),
        }),
      );
      expect(result).toEqual({ id: "555", commentIds: [] });
    });

    it("returns aligned discussion ids when replaying a marked review", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        {
          id: 555,
          body:
            "Published.\n\n<!-- ai-workflow-review:review-hash -->\n\n" +
            "<!-- ai-workflow-review-head:reviewed-head -->",
        },
      ]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-1",
          notes: [
            {
              body: "<!-- ai-workflow-review-comment:review-hash:0 -->",
            },
          ],
        },
        {
          notes: [
            {
              body: "<!-- ai-workflow-review-comment:review-hash:1 -->",
            },
          ],
        },
      ]);

      const result = await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "Published.",
        comments: [
          {
            path: "src/index.ts",
            body: "First",
            startLine: 10,
            endLine: 10,
          },
          {
            path: "src/index.ts",
            body: "Second",
            startLine: 12,
            endLine: 12,
          },
        ],
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "First" }),
          reviewFindingDigest({ path: "src/index.ts", body: "Second" }),
        ],
      });

      expect(result).toEqual({
        id: "555",
        commentIds: ["discussion-1", null],
      });
    });

    it("adopts a summary and its discussions from a prior key", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        {
          id: 555,
          body:
            "Published before the key was stable.\n\n" +
            "<!-- ai-workflow-review:old-content-hash -->",
        },
      ]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-1",
          notes: [
            {
              body: "<!-- ai-workflow-review-comment:old-content-hash:0 -->",
            },
          ],
        },
      ]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "reviewed-head",
        diff_refs: {
          base_sha: "base",
          start_sha: "start",
          head_sha: "reviewed-head",
        },
      });
      mockFetch.mockResolvedValueOnce(gitLabResponse({ id: 555 }, { status: 200 }));

      const result = await glAdapter().publishPRReview(42, {
        idempotencyKey: "round-key",
        priorIdempotencyKeys: ["old-content-hash"],
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "The same review.",
        comments: [
          {
            path: "src/index.ts",
            body: "First",
            startLine: 10,
            endLine: 10,
          },
        ],
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "First" }),
        ],
      });

      // Both marker families have to accept the prior key, not just the summary
      // note: recognising the note alone would leave every inline discussion to
      // be posted a second time, and recognising neither would resolve a thread
      // whose finding still stands.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes/555",
        expect.objectContaining({ method: "PUT" }),
      );
      expect(result).toEqual({ id: "555", commentIds: ["discussion-1"] });
    });

    // AIW-236's main requirement. Measured on our own PR #224, two rounds of
    // CodeRabbit left thirteen live threads and resolved or collapsed none.
    //
    // GitLab's only way to collapse a thread is to resolve it, and that word claims
    // the defect is gone. The note is what stops the strip from lying, so it goes in
    // first and the resolve follows.
    it("explains a superseded discussion before resolving it", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-settled",
          notes: [
            botNote(
              `Fixed since.\n\n${findingMarker("src/gone.ts", "Fixed since.")}`,
            ),
          ],
        },
        // Somebody else's thread, which this workflow has no business touching.
        {
          id: "discussion-human",
          notes: [{ body: "Please rename this.", author: { username: "dev" } }],
        },
      ]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      stubCurrentUser();
      mockFetch
        .mockResolvedValueOnce(gitLabResponse({ id: 556 }, { status: 201 }))
        .mockResolvedValueOnce(gitLabResponse({}, { status: 201 }))
        .mockResolvedValueOnce(gitLabResponse({}, { status: 200 }));

      await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "Nothing left there.",
        comments: [],
        commentFindingDigests: [],
      });

      // /user, the summary note, then the explanation and the resolve. The sweep
      // runs last: before the summary exists, a failure here would leave the merge
      // request collapsed and unreviewed.
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch.mock.calls[0]![0]).toBe("https://gitlab.com/api/v4/user");
      expect(mockFetch.mock.calls[2]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/discussions/discussion-settled/notes",
      );
      const explanation = JSON.parse(String(mockFetch.mock.calls[2]![1]?.body));
      expect(explanation.body).toContain("superseded, not verified as fixed");
      expect(explanation.body).toContain(AI_WORKFLOW_COMMENT_MARKER);
      expect(mockFetch.mock.calls[3]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/discussions/discussion-settled",
      );
      expect(mockFetch.mock.calls[3]![1]).toEqual(
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ resolved: true }),
        }),
      );
    });

    // The case the digest cannot tell from a repair. Agent prose is regenerated
    // every round, so the same defect routinely returns under new wording.
    it("retires the old discussion and opens a new one when a finding is reworded", async () => {
      const before = "**High**: This can throw on an empty list.";
      const after = "**High**: An empty list makes this throw.";
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-reworded",
          notes: [
            botNote(`${before}\n\n${findingMarker("src/index.ts", before)}`),
          ],
        },
      ]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      stubCurrentUser();
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse({ id: "discussion-new" }, { status: 201 }),
        )
        .mockResolvedValueOnce(gitLabResponse({ id: 560 }, { status: 201 }))
        .mockResolvedValueOnce(gitLabResponse({}, { status: 201 }))
        .mockResolvedValueOnce(gitLabResponse({}, { status: 200 }));

      const result = await glAdapter().publishPRReview(42, {
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

      const posted = JSON.parse(String(mockFetch.mock.calls[1]![1]?.body));
      expect(posted.body).toContain(after);
      expect(result.commentIds).toEqual(["discussion-new"]);
      // The stale one is explained and resolved, never silently left behind.
      expect(mockFetch.mock.calls[4]![1]).toEqual(
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ resolved: true }),
        }),
      );
    });

    // The path production actually takes. The workflow passes its own digests, and
    // they are deliberately NOT what the body hashes to: a published body carries
    // the agreement note and the identity excludes it. An adapter that re-derived
    // from the body would open discussions under one identity and look them up
    // under another.
    const callerDigest = "0123456789abcdef0123456789abcdef";
    const notedBody = "**High**: Still broken.\n\nBoth reviewers reported this.";

    it("marks a new discussion with the caller's digest, not the body's", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse({ id: "discussion-new" }, { status: 201 }),
        )
        .mockResolvedValueOnce(gitLabResponse({ id: 562 }, { status: 201 }));

      await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          { path: "src/index.ts", body: notedBody, startLine: 9, endLine: 9 },
        ],
        commentFindingDigests: [callerDigest],
      });

      const posted = JSON.parse(String(mockFetch.mock.calls[0]![1]?.body));
      expect(posted.body).toContain(
        `<!-- ai-workflow-review-finding:${callerDigest} -->`,
      );
      expect(posted.body).not.toContain(
        reviewFindingDigest({ path: "src/index.ts", body: notedBody }),
      );
    });

    it("recognises an existing discussion by the caller's digest", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-open",
          // Opened last round, under wording this round no longer uses.
          notes: [
            botNote(
              `Older wording.\n\n<!-- ai-workflow-review-finding:${callerDigest} -->`,
            ),
          ],
        },
      ]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      stubCurrentUser();
      mockFetch.mockResolvedValueOnce(
        gitLabResponse({ id: 563 }, { status: 201 }),
      );

      const result = await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "One finding.",
        comments: [
          { path: "src/index.ts", body: notedBody, startLine: 9, endLine: 9 },
        ],
        commentFindingDigests: [callerDigest],
      });

      // Carried over: /user and the summary note only. No second copy of the
      // finding, and no resolve on a discussion this round still reports.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.commentIds).toEqual(["discussion-open"]);
      expect(mockFetch.mock.calls[1]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes",
      );
    });

    // The condition the plan set. GitLab hands the adapter every note in the
    // discussion, and it previously read only the first.
    it("leaves a discussion alone once a human has replied in it", async () => {
      const body = "**Nit**: Rename this.";
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-discussed",
          notes: [
            botNote(`${body}\n\n${findingMarker("src/index.ts", body)}`),
            { body: "Why?", author: { username: "dev" } },
          ],
        },
      ]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      stubCurrentUser();
      mockFetch
        .mockResolvedValueOnce(gitLabResponse({ id: 561 }, { status: 201 }))
        .mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));

      // This round no longer reports the finding, so the sweep would otherwise
      // resolve the thread and stamp the reader's question as settled.
      await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "approve",
        summary: "Nothing left.",
        comments: [],
        commentFindingDigests: [],
      });

      // /user, the summary note, the approval. No explanation note, no resolve.
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[1]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes",
      );
      expect(
        mockFetch.mock.calls.some(([url]) =>
          String(url).includes("/discussions/"),
        ),
      ).toBe(false);
    });

    // A finding the inline cap pushed into the summary is still standing. Resolving
    // its thread would put "resolved" on the thread and "still open" in the summary
    // for one defect, which is worse than either alone.
    it("keeps the discussion of a finding this round reports into the summary", async () => {
      const body = "**Nit**: Demoted by the cap this round.";
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-deferred",
          notes: [botNote(`${body}\n\n${findingMarker("src/index.ts", body)}`)],
        },
      ]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      stubCurrentUser();
      mockFetch.mockResolvedValueOnce(gitLabResponse({ id: 559 }, { status: 201 }));

      await glAdapter().publishPRReview(42, {
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

      // /user and the summary note: no explanation note and no resolve went out.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes",
      );
    });

    it("posts a discussion only for the findings this round adds", async () => {
      const kept = "**High**: Still broken.";
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-open",
          notes: [botNote(`${kept}\n\n${findingMarker("src/index.ts", kept)}`)],
        },
      ]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      stubCurrentUser();
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse({ id: "discussion-new" }, { status: 201 }),
        )
        .mockResolvedValueOnce(gitLabResponse({ id: 557 }, { status: 201 }));

      const result = await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        // The finding came back at a different line after a rebase. The digest
        // carries no position, so the discussion is recognised, kept unresolved and
        // not restated.
        headSha: "next-head",
        decision: "request_changes",
        summary: "Two findings.",
        comments: [
          { path: "src/index.ts", body: kept, startLine: 40, endLine: 40 },
          { path: "src/new.ts", body: "**Nit**: New one.", startLine: 7, endLine: 7 },
        ],
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: kept }),
          reviewFindingDigest({ path: "src/new.ts", body: "**Nit**: New one." }),
        ],
      });

      // Three calls: /user, the new discussion and the summary. No resolve, and no
      // second copy of the finding already under discussion.
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const posted = JSON.parse(String(mockFetch.mock.calls[1]![1]?.body));
      expect(posted.body).toContain("**Nit**: New one.");
      expect(result.commentIds).toEqual(["discussion-open", "discussion-new"]);
      // The carried-over finding is named in the summary. Without it the finding
      // would be in no artifact a reader treats as current, and an unfixed finding
      // would read as fixed.
      const note = JSON.parse(String(mockFetch.mock.calls[2]![1]?.body));
      expect(note.body).toContain(
        "### Findings already open on this merge request",
      );
      expect(note.body).toContain("- `src/index.ts:40` — **High**: Still broken.");
    });

    it("edits the one summary note instead of adding another", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        { id: 999, body: "A human said something else." },
        {
          id: 555,
          body:
            "Round one.\n\n<!-- ai-workflow-review:review-hash -->\n\n" +
            "<!-- ai-workflow-review-head:earlier-head -->",
        },
      ]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      mockFetch.mockResolvedValueOnce(gitLabResponse({ id: 555 }, { status: 200 }));

      const result = await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "request_changes",
        summary: "Round two.",
        comments: [],
        commentFindingDigests: [],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes/555",
      );
      const note = JSON.parse(String(mockFetch.mock.calls[0]![1]?.body));
      expect(note.body).toBe(
        "Round two.\n\n<!-- ai-workflow-review:review-hash -->\n\n" +
          "<!-- ai-workflow-review-head:next-head -->\n\n" +
          // Without it, an installation with no matchable bot login treats its own
          // summary as a human comment and starts another round.
          AI_WORKFLOW_COMMENT_MARKER,
      );
      expect(result.id).toBe("555");
    });

    // Ownership needs the finding marker AND our authorship, so neither of these
    // is ours. The pre-marker discussion is the accepted cost: it stays open for
    // good, which is the safe direction now that retiring writes a note and a
    // "Resolved" strip onto whatever it touches.
    it("touches neither a pre-marker discussion nor a marker somebody else pasted", async () => {
      const body = "**High**: Quoted from our review.";
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "discussion-legacy",
          notes: [
            {
              body: "Reported earlier.\n\n<!-- ai-workflow-review-comment:old-hash:3 -->",
              resolved: false,
              author: { username: BOT },
            },
          ],
        },
        {
          id: "discussion-impostor",
          notes: [
            {
              body: `${body}\n\n${findingMarker("src/index.ts", body)}`,
              resolved: false,
              author: { username: "dev" },
            },
          ],
        },
      ]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "next-head",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "next-head" },
      });
      stubCurrentUser();
      mockFetch
        .mockResolvedValueOnce(gitLabResponse({ id: 558 }, { status: 201 }))
        .mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));

      await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "next-head",
        decision: "approve",
        summary: "Nothing left.",
        comments: [],
        commentFindingDigests: [],
      });

      // /user, the summary note, the approval. Nothing resolved, nothing explained.
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[1]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes",
      );
      expect(
        mockFetch.mock.calls.some(([url]) =>
          String(url).includes("/discussions/"),
        ),
      ).toBe(false);
    });

    // GitLab forbids an author approving their own merge request, and MR approvals
    // are a paid-tier feature; either way the /approve call is refused. The review
    // is already on the merge request by then, so a refused approval must degrade
    // to a warning rather than discard a completed review.
    it("publishes the review even when GitLab refuses the approval", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "reviewed-head",
        diff_refs: {
          base_sha: "base",
          start_sha: "start",
          head_sha: "reviewed-head",
        },
      });
      mockFetch
        .mockResolvedValueOnce(gitLabResponse({ id: 555 }, { status: 201 }))
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "You cannot approve your own merge request" },
            { status: 403, statusText: "Forbidden" },
          ),
        );

      const result = await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "approve",
        summary: "Approved.",
        comments: [],
        commentFindingDigests: [],
      });

      expect(result).toEqual({ id: "555", commentIds: [] });
      // The summary note was posted, then the approval was attempted and refused.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes",
      );
      expect(mockFetch.mock.calls[1]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/approve",
      );
    });

    it("publishes GitLab multiline positions and preserves id alignment", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "reviewed-head",
        diff_refs: {
          base_sha: "base",
          start_sha: "start",
          head_sha: "reviewed-head",
        },
      });
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "position is invalid" },
            { status: 400, statusText: "Bad Request" },
          ),
        )
        .mockResolvedValueOnce(
          gitLabResponse({ id: "discussion-2" }, { status: 201 }),
        )
        .mockResolvedValueOnce(gitLabResponse({ id: 555 }, { status: 201 }));

      const result = await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "Published.",
        comments: [
          {
            path: "src/index.ts",
            body: "Rejected",
            startLine: 8,
            endLine: 8,
          },
          {
            path: "src/index.ts",
            body: "Range",
            startLine: 10,
            endLine: 12,
            startOldLine: null,
            endOldLine: 11,
          },
        ],
        commentFindingDigests: [
          reviewFindingDigest({ path: "src/index.ts", body: "Rejected" }),
          reviewFindingDigest({ path: "src/index.ts", body: "Range" }),
        ],
      });

      const discussionRequest = mockFetch.mock.calls[1]?.[1];
      const discussionBody = JSON.parse(String(discussionRequest?.body));
      expect(discussionBody.position).toEqual({
        position_type: "text",
        base_sha: "base",
        start_sha: "start",
        head_sha: "reviewed-head",
        old_path: "src/index.ts",
        new_path: "src/index.ts",
        new_line: 12,
        line_range: {
          start: {
            line_code:
              "c5fb850250c7443c48a6c12b5cf6916773da31f1_0_10",
            type: "new",
            new_line: 10,
          },
          end: {
            line_code:
              "c5fb850250c7443c48a6c12b5cf6916773da31f1_11_12",
            type: "old",
            old_line: 11,
            new_line: 12,
          },
        },
      });
      expect(result).toEqual({
        id: "555",
        commentIds: [null, "discussion-2"],
      });
      const noteRequest = mockFetch.mock.calls[2]?.[1];
      const noteBody = JSON.parse(String(noteRequest?.body));
      expect(noteBody.body).toContain(
        "### Additional findings not placed inline",
      );
      expect(noteBody.body).toContain(
        "- `src/index.ts:8` — Rejected",
      );
    });

    // GitLab rejects an inline position per comment, so this fallback list is
    // the path Arthur's two GitLab repositories exercise most. A merged comment
    // carries its agreement note after a blank line, and an unindented blank
    // line closes the markdown list, detaching the note from its finding.
    it("keeps a merged comment's agreement note inside its own bullet", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "reviewed-head",
        diff_refs: {
          base_sha: "base",
          start_sha: "start",
          head_sha: "reviewed-head",
        },
      });
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "position is invalid" },
            { status: 400, statusText: "Bad Request" },
          ),
        )
        .mockResolvedValueOnce(gitLabResponse({ id: 556 }, { status: 201 }));

      await glAdapter().publishPRReview(42, {
        idempotencyKey: "review-hash",
        headSha: "reviewed-head",
        decision: "request_changes",
        summary: "Published.",
        comments: [
          {
            path: "src/index.ts",
            body: "**High**: Handle this failure.\n\nReported by 3 of 3 reviewers.",
            startLine: 8,
            endLine: 8,
          },
        ],
        commentFindingDigests: [
          reviewFindingDigest({
            path: "src/index.ts",
            body: "**High**: Handle this failure.\n\nReported by 3 of 3 reviewers.",
          }),
        ],
      });

      const noteBody = JSON.parse(String(mockFetch.mock.calls[1]?.[1]?.body));
      expect(noteBody.body).toContain(
        "- `src/index.ts:8` — **High**: Handle this failure.\n\n  Reported by 3 of 3 reviewers.",
      );
    });

    it("propagates GitLab server failures instead of degrading them to the summary", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "reviewed-head",
        diff_refs: {
          base_sha: "base",
          start_sha: "start",
          head_sha: "reviewed-head",
        },
      });
      mockFetch.mockResolvedValueOnce(
        gitLabResponse(
          { message: "server failure" },
          { status: 500, statusText: "Internal Server Error" },
        ),
      );

      await expect(
        glAdapter().publishPRReview(42, {
          idempotencyKey: "review-hash",
          headSha: "reviewed-head",
          decision: "request_changes",
          summary: "Published.",
          comments: [
            {
              path: "src/index.ts",
              body: "Retry this publication.",
              startLine: 8,
              endLine: 8,
            },
          ],
          commentFindingDigests: [
            reviewFindingDigest({ path: "src/index.ts", body: "Retry this publication." }),
          ],
        }),
      ).rejects.toThrow();
    });

    it("uses the idempotency key when GitLab omits a summary-note id", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([]);
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([]);
      mockMergeRequests.show.mockResolvedValueOnce({
        sha: "reviewed-head",
        diff_refs: {
          base_sha: "base",
          start_sha: "start",
          head_sha: "reviewed-head",
        },
      });
      mockFetch.mockResolvedValueOnce(
        gitLabResponse({}, { status: 201 }),
      );

      await expect(
        glAdapter().publishPRReview(42, {
          idempotencyKey: "review-hash",
          headSha: "reviewed-head",
          decision: "request_changes",
          summary: "Published.",
          comments: [],
          commentFindingDigests: [],
        }),
      ).resolves.toEqual({
        id: "review-hash",
        commentIds: [],
      });
    });
  });

  describe("getCheckRunResults", () => {
    it("maps GitLab CI job statuses to CheckRunResult", async () => {
      mockMergeRequests.allPipelines.mockResolvedValueOnce([
        { id: 100, status: "failed" },
      ]);
      mockJobs.all.mockResolvedValueOnce([
        { id: 1, name: "lint", status: "success" },
        { id: 2, name: "test", status: "failed" },
        { id: 3, name: "build", status: "running" },
      ]);
      mockJobs.showLog.mockResolvedValueOnce("Error: test failed on line 42");

      const adapter = glAdapter();
      const results = await adapter.getCheckRunResults(42);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({
        name: "lint",
        status: "completed",
        conclusion: "success",
      });
      expect(results[1]).toEqual({
        name: "test",
        status: "completed",
        conclusion: "failure",
        logs: "Error: test failed on line 42",
      });
      expect(results[2]).toEqual({
        name: "build",
        status: "in_progress",
        conclusion: null,
      });
    });
  });

  describe("getPRConflictStatus", () => {
    it("returns true when MR has conflicts", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({ has_conflicts: true });

      const adapter = glAdapter();
      const hasConflicts = await adapter.getPRConflictStatus(42);
      expect(hasConflicts).toBe(true);
    });

    it("returns false when MR has no conflicts", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({ has_conflicts: false });

      const adapter = glAdapter();
      const hasConflicts = await adapter.getPRConflictStatus(42);
      expect(hasConflicts).toBe(false);
    });
  });

  describe("nested namespace project id", () => {
    function nestedAdapter() {
      return new GitLabAdapter({
        token: "glpat-xxxxxxxxxxxx",
        projectId: "group/subgroup/repo",
        baseBranch: "main",
      });
    }

    it("carries a nested project path through promotion branch and MR operations", async () => {
      mockBranches.create.mockResolvedValue({});
      mockBranches.remove.mockResolvedValueOnce({});
      mockMergeRequests.all.mockResolvedValueOnce([]);

      const adapter = nestedAdapter();
      await adapter.createBranchIfMissing("feat/test", "main");
      await adapter.resetOwnedBranch("feat/test", "main");
      await adapter.findPR("feat/test");

      expect(mockBranches.create).toHaveBeenCalledWith(
        "group/subgroup/repo",
        "feat/test",
        "main",
      );
      expect(mockBranches.remove).toHaveBeenCalledWith(
        "group/subgroup/repo",
        "feat/test",
      );
      expect(mockMergeRequests.all).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "group/subgroup/repo" }),
      );
    });

    it("url-encodes the nested project path in hand-rolled REST gate statuses", async () => {
      mockFetch.mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));

      const adapter = nestedAdapter();
      await adapter.createGateStatus("blazebot / code-hygiene", "sha1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Frepo/statuses/sha1",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("gate statuses", () => {
    it("creates a GitLab commit status and returns a gate status ref", async () => {
      mockFetch.mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));

      const adapter = glAdapter();
      const ref = await adapter.createGateStatus("blazebot / code-hygiene", "sha1");

      expect(ref).toEqual({
        provider: "gitlab",
        name: "blazebot / code-hygiene",
        headSha: "sha1",
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/statuses/sha1",
        expect.objectContaining({
          method: "POST",
          headers: {
            "PRIVATE-TOKEN": "glpat-xxxxxxxxxxxx",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            state: "running",
            name: "blazebot / code-hygiene",
          }),
        }),
      );
    });

    it("maps a completed failure update to failed with summary description", async () => {
      mockFetch.mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));

      const adapter = glAdapter();
      await adapter.updateGateStatus(
        {
          provider: "gitlab",
          name: "blazebot / code-hygiene",
          headSha: "sha1",
        },
        {
          status: "completed",
          conclusion: "failure",
          summary: "Tests failed",
        },
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/statuses/sha1",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            state: "failed",
            name: "blazebot / code-hygiene",
            description: "Tests failed",
          }),
        }),
      );
    });

    it("keeps the cause and the whole diagnostic ID inside GitLab's 255 limit", async () => {
      mockFetch.mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));
      // The real shape a failed pr_trigger run posts here: generic 50 + " (" +
      // a 160-character cause snippet + ")" + " Diagnostic ID: " + a
      // 59-character ID = 288 characters, so the old head slice at 255 dropped
      // the verdict and left a diagnostic ID that correlated with nothing.
      const diagnosticId =
        "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1";
      const summary =
        "An external service could not complete this block. " +
        "(github:Blazity/ai-workflow-prod: canonical clone failed: Clon [...] " +
        "ss 'https://github.com/Blazity/ai-workflow-prod.git/': The requested URL returned error: 403) " +
        `Diagnostic ID: ${diagnosticId}`;
      expect(summary.length).toBe(288);

      const adapter = glAdapter();
      await adapter.updateGateStatus(
        { provider: "gitlab", name: "blazebot / code-hygiene", headSha: "sha1" },
        { status: "completed", conclusion: "failure", summary },
      );

      const body = JSON.parse(
        (mockFetch.mock.calls.at(-1)?.[1] as { body: string }).body,
      ) as { description: string };
      expect(body.description.length).toBeLessThanOrEqual(255);
      expect(body.description).toContain("The requested URL returned error: 403");
      expect(body.description).toContain(diagnosticId);
    });

    it("keeps a non-verdict conclusion out of a green GitLab status", async () => {
      // GitLab has fewer states than GitHub has conclusions, so this mapping is
      // lossy: "neutral" lands on "success", which would show a review that
      // never ran as an approval. "cancelled" is the conclusion a settled but
      // unfinished check may carry.
      const states: Record<string, string> = {};
      for (const conclusion of ["cancelled", "neutral"] as const) {
        mockFetch.mockReset().mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));
        await glAdapter().updateGateStatus(
          { provider: "gitlab", name: "blazebot / code-hygiene", headSha: "sha1" },
          { status: "completed", conclusion, summary: "The review did not run." },
        );
        states[conclusion] = (
          JSON.parse((mockFetch.mock.calls.at(-1)?.[1] as { body: string }).body) as {
            state: string;
          }
        ).state;
      }

      expect(states.cancelled).toBe("canceled");
      expect(states.cancelled).not.toBe("success");
      expect(states.neutral).toBe("success");
    });

    it("rejects gate status refs from other providers", async () => {
      const adapter = glAdapter();

      await expect(
        adapter.updateGateStatus(
          { provider: "github", id: 123 },
          { status: "completed", conclusion: "success" },
        ),
      ).rejects.toThrow("GitLabAdapter cannot update github gate status");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("retries a transient 409 from GitLab commit status creation", async () => {
      vi.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "update already in progress" },
            { status: 409, statusText: "Conflict" },
          ),
        )
        .mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));

      const adapter = glAdapter();
      const update = adapter.updateGateStatus(
        {
          provider: "gitlab",
          name: "blazebot / code-hygiene",
          headSha: "sha1",
        },
        { status: "completed", conclusion: "success" },
      );
      await vi.advanceTimersByTimeAsync(500);
      await update;
      vi.useRealTimers();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/statuses/sha1",
        expect.objectContaining({ method: "POST" }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/statuses/sha1",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("backs off before retrying GitLab commit status 409 conflicts", async () => {
      vi.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "update already in progress" },
            { status: 409, statusText: "Conflict" },
          ),
        )
        .mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));

      const adapter = glAdapter();
      const update = adapter.updateGateStatus(
        {
          provider: "gitlab",
          name: "blazebot / code-hygiene",
          headSha: "sha1",
        },
        { status: "completed", conclusion: "success" },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await update;
      vi.useRealTimers();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries repeated transient 409 responses before success", async () => {
      vi.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "update already in progress" },
            { status: 409, statusText: "Conflict" },
          ),
        )
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "still updating" },
            { status: 409, statusText: "Conflict" },
          ),
        )
        .mockResolvedValueOnce(gitLabResponse({}, { status: 201 }));

      const adapter = glAdapter();
      const update = adapter.updateGateStatus(
        {
          provider: "gitlab",
          name: "blazebot / code-hygiene",
          headSha: "sha1",
        },
        { status: "completed", conclusion: "success" },
      );
      await vi.advanceTimersByTimeAsync(1500);
      await update;
      vi.useRealTimers();

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("throws the final GitLab REST error after exhausting 409 retries", async () => {
      vi.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "first conflict" },
            { status: 409, statusText: "Conflict" },
          ),
        )
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "second conflict" },
            { status: 409, statusText: "Conflict" },
          ),
        )
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "final conflict" },
            { status: 409, statusText: "Conflict" },
          ),
        )
        .mockResolvedValueOnce(
          gitLabResponse(
            { message: "exhausted conflict" },
            { status: 409, statusText: "Conflict" },
          ),
        );

      const adapter = glAdapter();
      const update = adapter.updateGateStatus(
        {
          provider: "gitlab",
          name: "blazebot / code-hygiene",
          headSha: "sha1",
        },
        { status: "completed", conclusion: "success" },
      );
      const expectedError = expect(update).rejects.toThrow(
        'GitLab REST POST /projects/blazity%2Fdemo-app/statuses/sha1 failed with 409 Conflict: {"message":"exhausted conflict"}',
      );
      await vi.advanceTimersByTimeAsync(3500);
      await expectedError;
      vi.useRealTimers();
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe("listPRFiles", () => {
    it("calls GitLab MR diffs and maps provider-neutral PR files", async () => {
      mockFetch.mockResolvedValueOnce(
        gitLabResponse([
          {
            old_path: "src/new.ts",
            new_path: "src/new.ts",
            diff: "@@ -0,0 +1,2 @@\n+one\n+two",
            new_file: true,
            deleted_file: false,
            renamed_file: false,
          },
          {
            old_path: "src/removed.ts",
            new_path: "src/removed.ts",
            diff: "@@ -1,2 +0,0 @@\n-one\n-two",
            new_file: false,
            deleted_file: true,
            renamed_file: false,
          },
          {
            old_path: "src/old.ts",
            new_path: "src/renamed.ts",
            diff: "@@ -1 +1 @@\n-old\n+new",
            new_file: false,
            deleted_file: false,
            renamed_file: true,
          },
          {
            old_path: "src/modified.ts",
            new_path: "src/modified.ts",
            diff: "@@ -1,2 +1,2 @@\n unchanged\n-old\n+new",
            new_file: false,
            deleted_file: false,
            renamed_file: false,
          },
        ]),
      );

      const adapter = glAdapter();
      const files = await adapter.listPRFiles(42);

      expect(files).toEqual([
        {
          path: "src/new.ts",
          changeType: "added",
          patch: "@@ -0,0 +1,2 @@\n+one\n+two",
          additions: 2,
          deletions: 0,
        },
        {
          path: "src/removed.ts",
          changeType: "removed",
          patch: "@@ -1,2 +0,0 @@\n-one\n-two",
          additions: 0,
          deletions: 2,
        },
        {
          path: "src/renamed.ts",
          changeType: "renamed",
          patch: "@@ -1 +1 @@\n-old\n+new",
          additions: 1,
          deletions: 1,
        },
        {
          path: "src/modified.ts",
          changeType: "modified",
          patch: "@@ -1,2 +1,2 @@\n unchanged\n-old\n+new",
          additions: 1,
          deletions: 1,
        },
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/diffs?page=1&per_page=100",
        expect.objectContaining({
          method: "GET",
          headers: {
            "PRIVATE-TOKEN": "glpat-xxxxxxxxxxxx",
          },
        }),
      );
    });

    it("fetches every GitLab MR diffs page", async () => {
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse(
            [
              {
                old_path: "src/one.ts",
                new_path: "src/one.ts",
                diff: "@@ one",
                new_file: false,
                deleted_file: false,
                renamed_file: false,
              },
            ],
            { headers: { "x-next-page": "2" } },
          ),
        )
        .mockResolvedValueOnce(
          gitLabResponse([
            {
              old_path: "src/two.ts",
              new_path: "src/two.ts",
              diff: "@@ two",
              new_file: false,
              deleted_file: false,
              renamed_file: false,
            },
          ]),
        );

      const adapter = glAdapter();
      const files = await adapter.listPRFiles(42);

      expect(files.map((file) => file.path)).toEqual(["src/one.ts", "src/two.ts"]);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/diffs?page=1&per_page=100",
        expect.objectContaining({ method: "GET" }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/diffs?page=2&per_page=100",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("follows GitLab Link pagination when x-next-page is absent", async () => {
      mockFetch
        .mockResolvedValueOnce(
          gitLabResponse(
            [
              {
                old_path: "src/one.ts",
                new_path: "src/one.ts",
                diff: "@@ one",
                new_file: false,
                deleted_file: false,
                renamed_file: false,
              },
            ],
            {
              headers: {
                Link: '<https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/diffs?page=2&per_page=100>; rel="next"',
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          gitLabResponse([
            {
              old_path: "src/two.ts",
              new_path: "src/two.ts",
              diff: "@@ two",
              new_file: false,
              deleted_file: false,
              renamed_file: false,
            },
          ]),
        );

      const adapter = glAdapter();
      const files = await adapter.listPRFiles(42);

      expect(files).toEqual([
        {
          path: "src/one.ts",
          changeType: "modified",
          patch: "@@ one",
          additions: 0,
          deletions: 0,
        },
        {
          path: "src/two.ts",
          changeType: "modified",
          patch: "@@ two",
          additions: 0,
          deletions: 0,
        },
      ]);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/diffs?page=1&per_page=100",
        expect.objectContaining({ method: "GET" }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/diffs?page=2&per_page=100",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it.each(["collapsed", "too_large"] as const)(
      "keeps a GitLab MR diff item when it is %s",
      async (partialFlag) => {
        mockFetch.mockResolvedValueOnce(
          gitLabResponse([
            {
              old_path: "src/huge.ts",
              new_path: "src/huge.ts",
              new_file: false,
              deleted_file: false,
              renamed_file: false,
              [partialFlag]: true,
            },
          ]),
        );

        const adapter = glAdapter();
        await expect(adapter.listPRFiles(42)).resolves.toEqual([
          {
            path: "src/huge.ts",
            changeType: "modified",
            additions: 0,
            deletions: 0,
          },
        ]);
      },
    );
  });

  describe("listReviewThreads", () => {
    // The token's own username. Source classification hangs off it, so every
    // fixture below names it explicitly and the adapter looks it up via /user.
    const BOT = "ai-workflow-bot";
    const stubCurrentUser = () =>
      mockFetch.mockResolvedValueOnce(gitLabResponse({ username: BOT }));

    it("drops resolved discussions and system notes", async () => {
      stubCurrentUser();
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "d-resolved",
          notes: [
            {
              body: "Already handled.",
              author: { username: "dev" },
              created_at: "2026-08-21T10:00:00.000Z",
              resolved: true,
            },
          ],
        },
        {
          id: "d-system-only",
          notes: [
            {
              body: "changed the description",
              author: { username: "dev" },
              created_at: "2026-08-21T10:01:00.000Z",
              system: true,
            },
          ],
        },
        {
          id: "d-open",
          notes: [
            {
              body: "assigned to @dev",
              author: { username: "gitlab-bot" },
              created_at: "2026-08-21T10:02:00.000Z",
              system: true,
            },
            {
              body: "Rename this variable.",
              author: { username: "dev" },
              created_at: "2026-08-21T10:03:00.000Z",
              resolved: false,
            },
          ],
        },
      ]);

      const feed = await glAdapter().listReviewThreads(42);

      expect(mockMergeRequestDiscussions.all).toHaveBeenCalledWith(
        "blazity/demo-app",
        42,
      );
      expect(feed.truncated).toBe(0);
      expect(feed.threads).toEqual([
        {
          threadId: "d-open",
          alias: "T1",
          source: "human",
          resolvable: true,
          awaitingHuman: false,
          notes: [
            {
              author: "dev",
              body: "Rename this variable.",
              createdAt: "2026-08-21T10:03:00.000Z",
              isLedgerReply: false,
            },
          ],
        },
      ]);
    });

    it("reads the source from the opening note's author", async () => {
      stubCurrentUser();
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "d-bot",
          notes: [
            {
              body: "Consider extracting this helper.",
              author: { username: BOT },
              created_at: "2026-08-21T10:00:00.000Z",
            },
          ],
        },
        {
          id: "d-third-party",
          notes: [
            {
              body: "nitpick: unused import.",
              author: { username: "coderabbitai", bot: true },
              created_at: "2026-08-21T10:01:00.000Z",
            },
          ],
        },
        {
          id: "d-human",
          notes: [
            {
              body: "Please rename this.",
              author: { username: "dev", bot: false },
              created_at: "2026-08-21T10:02:00.000Z",
            },
          ],
        },
      ]);

      const feed = await glAdapter().listReviewThreads(42);

      expect(
        feed.threads.map((thread) => [thread.alias, thread.threadId, thread.source]),
      ).toEqual([
        ["T1", "d-bot", "bot"],
        ["T2", "d-third-party", "third_party"],
        ["T3", "d-human", "human"],
      ]);
    });

    // A thread whose last word is ours is waiting on a person, not on the agent.
    // Handing it back as a work item would answer the same question every round.
    it("marks a thread whose last note is a ledger reply as awaiting a human", async () => {
      stubCurrentUser();
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "d-answered",
          notes: [
            {
              body: "Why is this cast needed?",
              author: { username: "dev" },
              created_at: "2026-08-21T10:00:00.000Z",
            },
            {
              body:
                "The provider types the field as unknown.\n\n" +
                "<!-- ai-workflow:ledger:d-answered --> <!-- ai-workflow:bot -->",
              author: { username: BOT },
              created_at: "2026-08-21T10:05:00.000Z",
            },
          ],
        },
        {
          id: "d-open",
          notes: [
            {
              body: "Rename this variable.",
              author: { username: "dev" },
              created_at: "2026-08-21T10:10:00.000Z",
            },
          ],
        },
      ]);

      const feed = await glAdapter().listReviewThreads(42);

      // Work items first, context after, so the aliases the agent answers are the
      // leading ones.
      expect(
        feed.threads.map((thread) => [
          thread.alias,
          thread.threadId,
          thread.awaitingHuman,
        ]),
      ).toEqual([
        ["T1", "d-open", false],
        ["T2", "d-answered", true],
      ]);
      expect(feed.threads[1]!.notes.map((note) => note.isLedgerReply)).toEqual([
        false,
        true,
      ]);
      expect(feed.truncated).toBe(0);
    });

    // A stale reply answers words the person wrote after the snapshot, which the
    // agent never read. Counting it as "awaiting a human" would drop the thread
    // out of the work items and nobody would ever answer what they actually said.
    it("keeps a thread whose last note is a stale ledger reply as a work item", async () => {
      stubCurrentUser();
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "d-stale",
          notes: [
            {
              body: "Why is this cast needed?",
              author: { username: "dev" },
              created_at: "2026-08-21T10:00:00.000Z",
            },
            {
              body:
                "The provider types the field as unknown.\n\n" +
                `<!-- ai-workflow:ledger-stale:d-stale --> ${AI_WORKFLOW_COMMENT_MARKER}`,
              author: { username: BOT },
              created_at: "2026-08-21T10:05:00.000Z",
            },
          ],
        },
      ]);

      const feed = await glAdapter().listReviewThreads(42);

      expect(feed.threads).toHaveLength(1);
      expect(feed.threads[0]!.awaitingHuman).toBe(false);
      expect(feed.threads[0]!.notes.map((note) => note.isLedgerReply)).toEqual([
        false,
        false,
      ]);
    });

    it("orders aliases by the opening note and anchors them to the diff position", async () => {
      stubCurrentUser();
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          id: "d-late",
          notes: [
            {
              body: "Late comment.",
              author: { username: "dev" },
              created_at: "2026-08-21T12:00:00.000Z",
              position: { new_path: "src/b.ts", new_line: 20 },
            },
          ],
        },
        {
          id: "d-early",
          notes: [
            {
              body: "Comment on a deleted line.",
              author: { username: "dev" },
              created_at: "2026-08-21T09:00:00.000Z",
              position: { old_path: "src/gone.ts", old_line: 7 },
            },
          ],
        },
        {
          id: "d-general",
          notes: [
            {
              body: "General remark on the merge request.",
              author: { username: "dev" },
              created_at: "2026-08-21T10:30:00.000Z",
            },
          ],
        },
      ]);

      const feed = await glAdapter().listReviewThreads(42);

      expect(
        feed.threads.map((thread) => [
          thread.alias,
          thread.threadId,
          thread.filePath,
          thread.line,
        ]),
      ).toEqual([
        ["T1", "d-early", "src/gone.ts", 7],
        ["T2", "d-general", undefined, undefined],
        ["T3", "d-late", "src/b.ts", 20],
      ]);
    });

    it("caps work items at the ledger limit and reports what it dropped", async () => {
      const workItem = (index: number) => ({
        id: `w-${String(index).padStart(2, "0")}`,
        notes: [
          {
            body: `Work item ${index}.`,
            author: { username: "dev" },
            created_at: `2026-08-21T10:${String(index).padStart(2, "0")}:00.000Z`,
          },
        ],
      });
      const awaiting = (index: number) => ({
        id: `a-${String(index).padStart(2, "0")}`,
        notes: [
          {
            body: `Question ${index}.`,
            author: { username: "dev" },
            created_at: `2026-08-21T11:${String(index).padStart(2, "0")}:00.000Z`,
          },
          {
            body: `Answered.\n\n<!-- ai-workflow:ledger:a-${String(index).padStart(2, "0")} --> <!-- ai-workflow:bot -->`,
            author: { username: BOT },
            created_at: `2026-08-21T11:${String(index).padStart(2, "0")}:30.000Z`,
          },
        ],
      });
      stubCurrentUser();
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        ...Array.from({ length: 22 }, (_, i) => workItem(i + 1)),
        ...Array.from({ length: 21 }, (_, i) => awaiting(i + 1)),
      ]);

      const feed = await glAdapter().listReviewThreads(42);

      // 20 work items + 20 context threads; only the dropped work items count as
      // truncated, because only they were work the agent will never see.
      expect(feed.threads).toHaveLength(40);
      expect(feed.truncated).toBe(2);
      expect(feed.threads[0]).toMatchObject({ alias: "T1", threadId: "w-01" });
      expect(feed.threads[19]).toMatchObject({ alias: "T20", threadId: "w-20" });
      expect(feed.threads[20]).toMatchObject({
        alias: "T21",
        threadId: "a-01",
        awaitingHuman: true,
      });
      expect(feed.threads[39]).toMatchObject({ alias: "T40", threadId: "a-20" });
      expect(feed.threads.some((thread) => thread.threadId === "w-21")).toBe(false);
      expect(feed.threads.some((thread) => thread.threadId === "a-21")).toBe(false);
    });
  });

  describe("settleReviewThread", () => {
    const BOT = "ai-workflow-bot";
    const DISCUSSION_URL =
      "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/discussions/d-1";
    const stubCurrentUser = () =>
      mockFetch.mockResolvedValueOnce(gitLabResponse({ username: BOT }));
    const ledgerThread = (): ReviewThread => ({
      threadId: "d-1",
      alias: "T1",
      source: "human",
      resolvable: true,
      awaitingHuman: false,
      notes: [],
    });

    // Settling is two calls (reply, then resolve), so a retry after a crash between
    // them must recognise its own reply instead of posting it again.
    it("skips a thread that already carries this run's ledger reply", async () => {
      mockFetch.mockResolvedValueOnce(
        gitLabResponse({
          id: "d-1",
          notes: [
            {
              body: "Why is this cast needed?",
              author: { username: "dev" },
              created_at: "2026-08-21T10:00:00.000Z",
            },
            {
              body:
                "The provider types the field as unknown.\n\n" +
                "<!-- ai-workflow:ledger:d-1 --> <!-- ai-workflow:bot -->",
              author: { username: BOT },
              created_at: "2026-08-21T10:05:00.000Z",
            },
          ],
        }),
      );

      const result = await glAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread(),
        body: "Fixed.\n\n<!-- ai-workflow:ledger:d-1 --> <!-- ai-workflow:bot -->",
        resolve: true,
        snapshotAt: "2026-08-21T11:00:00.000Z",
      });

      expect(result).toEqual({ action: "skipped_existing_reply" });
      // The marker settles it, so the run never asks who it is either.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]![0]).toBe(DISCUSSION_URL);
      expect(mockFetch.mock.calls[0]![1]?.method).toBe("GET");
    });

    // The thread moved under us: whoever wrote after the snapshot has not seen the
    // reply we are about to post, so resolving would close a live conversation.
    // The stale marker keeps the reply out of the echo filter while leaving the
    // thread a work item, since the newest human words are still unanswered.
    it("replies with the stale marker when somebody wrote after the snapshot", async () => {
      mockFetch.mockResolvedValueOnce(
        gitLabResponse({
          id: "d-1",
          notes: [
            {
              body: "Rename this variable.",
              author: { username: "dev" },
              created_at: "2026-08-21T10:00:00.000Z",
            },
            {
              body: "Actually, drop it entirely.",
              author: { username: "dev" },
              created_at: "2026-08-21T11:30:00.000Z",
            },
          ],
        }),
      );
      stubCurrentUser();
      mockFetch.mockResolvedValueOnce(gitLabResponse({ id: 900 }, { status: 201 }));

      const result = await glAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread(),
        body: "Renamed.\n\n<!-- ai-workflow:ledger:d-1 --> <!-- ai-workflow:bot -->",
        resolve: true,
        snapshotAt: "2026-08-21T11:00:00.000Z",
      });

      expect(result).toEqual({ action: "replied_stale" });
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[2]![0]).toBe(`${DISCUSSION_URL}/notes`);
      expect(mockFetch.mock.calls[2]![1]?.method).toBe("POST");
      expect(JSON.parse(String(mockFetch.mock.calls[2]![1]?.body))).toEqual({
        body:
          "Renamed.\n\n" +
          `<!-- ai-workflow:ledger-stale:d-1 --> ${AI_WORKFLOW_COMMENT_MARKER}`,
      });
      expect(
        mockFetch.mock.calls.some((call) => call[1]?.method === "PUT"),
      ).toBe(false);
    });

    // The duplication this ordering prevents: the human-activity branch answers
    // every round, so without recognising the stale marker the thread collects
    // one identical note per run.
    it("does not answer twice after a stale reply, even with newer human notes", async () => {
      mockFetch.mockResolvedValueOnce(
        gitLabResponse({
          id: "d-1",
          notes: [
            {
              body: "Rename this variable.",
              author: { username: "dev" },
              created_at: "2026-08-21T10:00:00.000Z",
            },
            {
              body: "Actually, drop it entirely.",
              author: { username: "dev" },
              created_at: "2026-08-21T11:30:00.000Z",
            },
            {
              body:
                "Renamed.\n\n" +
                `<!-- ai-workflow:ledger-stale:d-1 --> ${AI_WORKFLOW_COMMENT_MARKER}`,
              author: { username: BOT },
              created_at: "2026-08-21T11:35:00.000Z",
            },
          ],
        }),
      );

      const result = await glAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread(),
        body: "Renamed.\n\n<!-- ai-workflow:ledger:d-1 --> <!-- ai-workflow:bot -->",
        resolve: true,
        snapshotAt: "2026-08-21T11:00:00.000Z",
      });

      expect(result).toEqual({ action: "skipped_existing_reply" });
      expect(
        mockFetch.mock.calls.some((call) => call[1]?.method === "POST"),
      ).toBe(false);
    });

    it("replies and resolves an untouched thread", async () => {
      mockFetch.mockResolvedValueOnce(
        gitLabResponse({
          id: "d-1",
          notes: [
            {
              body: "changed this line",
              author: { username: "dev" },
              created_at: "2026-08-21T10:30:00.000Z",
              system: true,
            },
            {
              body: "Rename this variable.",
              author: { username: "dev" },
              created_at: "2026-08-21T10:00:00.000Z",
            },
          ],
        }),
      );
      stubCurrentUser();
      mockFetch
        .mockResolvedValueOnce(gitLabResponse({ id: 901 }, { status: 201 }))
        .mockResolvedValueOnce(gitLabResponse({}, { status: 200 }));

      const result = await glAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread(),
        body: "Renamed.\n\n<!-- ai-workflow:ledger:d-1 --> <!-- ai-workflow:bot -->",
        resolve: true,
        snapshotAt: "2026-08-21T11:00:00.000Z",
      });

      expect(result).toEqual({ action: "replied_and_resolved" });
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch.mock.calls[2]![0]).toBe(`${DISCUSSION_URL}/notes`);
      expect(mockFetch.mock.calls[2]![1]?.method).toBe("POST");
      expect(mockFetch.mock.calls[3]![0]).toBe(DISCUSSION_URL);
      expect(mockFetch.mock.calls[3]![1]?.method).toBe("PUT");
      expect(JSON.parse(String(mockFetch.mock.calls[3]![1]?.body))).toEqual({
        resolved: true,
      });
    });

    it("replies without resolving when the caller asks for a reply only", async () => {
      mockFetch.mockResolvedValueOnce(
        gitLabResponse({
          id: "d-1",
          notes: [
            {
              body: "Why is this cast needed?",
              author: { username: "dev" },
              created_at: "2026-08-21T10:00:00.000Z",
            },
          ],
        }),
      );
      stubCurrentUser();
      mockFetch.mockResolvedValueOnce(gitLabResponse({ id: 902 }, { status: 201 }));

      const result = await glAdapter().settleReviewThread({
        prId: 42,
        thread: ledgerThread(),
        body:
          "The provider types the field as unknown.\n\n" +
          "<!-- ai-workflow:ledger:d-1 --> <!-- ai-workflow:bot -->",
        resolve: false,
        snapshotAt: "2026-08-21T11:00:00.000Z",
      });

      expect(result).toEqual({ action: "replied" });
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(
        mockFetch.mock.calls.some((call) => call[1]?.method === "PUT"),
      ).toBe(false);
    });
  });

  describe("postRunFailureNote", () => {
    it("posts the note with a marker naming the run", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        { body: "Unrelated comment.", system: false },
        {
          body:
            "An earlier run failed.\n\n" +
            "<!-- ai-workflow:ledger-failure:wrun_older --> <!-- ai-workflow:bot -->",
          system: false,
        },
      ]);
      mockFetch.mockResolvedValueOnce(gitLabResponse({ id: 777 }, { status: 201 }));

      await glAdapter().postRunFailureNote({
        prId: 42,
        runId: "wrun_current",
        body: "The review ledger could not finish this round.",
      });

      expect(mockMergeRequestNotes.all).toHaveBeenCalledWith("blazity/demo-app", 42);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]![0]).toBe(
        "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/merge_requests/42/notes",
      );
      expect(JSON.parse(String(mockFetch.mock.calls[0]![1]?.body))).toEqual({
        body:
          "The review ledger could not finish this round.\n\n" +
          "<!-- ai-workflow:ledger-failure:wrun_current --> <!-- ai-workflow:bot -->",
      });
    });

    // The failure note is posted from a retried step, so the marker is the only
    // thing standing between one honest note and a column of identical ones.
    it("stays silent when this run already reported its failure", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        { body: "changed the description", system: true },
        {
          body:
            "The review ledger could not finish this round.\n\n" +
            "<!-- ai-workflow:ledger-failure:wrun_current --> <!-- ai-workflow:bot -->",
          system: false,
        },
      ]);

      await glAdapter().postRunFailureNote({
        prId: 42,
        runId: "wrun_current",
        body: "The review ledger could not finish this round.",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
