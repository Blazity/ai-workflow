import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabAdapter } from "./gitlab.js";

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
    it("retries approval when the marked summary already exists", async () => {
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        {
          id: 555,
          body: "Approved.\n\n<!-- ai-workflow-review:review-hash -->",
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
          body: "Published.\n\n<!-- ai-workflow-review:review-hash -->",
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
      });

      expect(result).toEqual({
        id: "555",
        commentIds: ["discussion-1", null],
      });
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
});
