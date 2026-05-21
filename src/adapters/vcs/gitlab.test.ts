import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabAdapter } from "./gitlab.js";
import { NotSupportedError } from "./types.js";

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

vi.mock("@gitbeaker/rest", () => ({
  Gitlab: vi.fn(() => ({
    Branches: mockBranches,
    RepositoryFiles: mockRepositoryFiles,
    Commits: mockCommits,
    MergeRequests: mockMergeRequests,
    MergeRequestNotes: mockMergeRequestNotes,
    MergeRequestDiscussions: mockMergeRequestDiscussions,
    Jobs: mockJobs,
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
  });

  describe("createBranch", () => {
    it("creates branch from base ref", async () => {
      mockBranches.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.createBranch("feat/test", "main");

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
      await adapter.createBranch("feat/test", "main");

      expect(mockRepositoryFiles.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "README.md",
        "main",
        "Initial commit",
        "# Repository\n",
      );
      expect(mockBranches.create).toHaveBeenCalledTimes(2);
    });

    it("force-resets existing branch by deleting and recreating on 400", async () => {
      const error = new Error("Branch already exists") as any;
      error.cause = { response: { status: 400 } };
      mockBranches.create.mockRejectedValueOnce(error);
      mockBranches.remove.mockResolvedValueOnce({});
      mockBranches.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockBranches.remove).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
      );
      expect(mockBranches.create).toHaveBeenCalledTimes(2);
    });

    it("rethrows other 400 errors (invalid ref, invalid name) without deleting branch", async () => {
      const error = new Error("Invalid branch name") as any;
      error.cause = { response: { status: 400 } };
      mockBranches.create.mockRejectedValueOnce(error);

      const adapter = glAdapter();
      await expect(
        adapter.createBranch("bad..name", "main"),
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
      await adapter.createBranch("feat/test", "main");

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

  describe("review pipeline", () => {
    it.each<[string, (a: GitLabAdapter) => Promise<unknown>]>([
      ["getPullRequest", (a) => a.getPullRequest(1)],
      ["listPRFiles", (a) => a.listPRFiles(1)],
      ["getPRDiff", (a) => a.getPRDiff(1)],
      ["getFileContentAtRef", (a) => a.getFileContentAtRef("foo.ts", "sha")],
      ["listPRCommits", (a) => a.listPRCommits(1)],
      ["listCheckRunsForRef", (a) => a.listCheckRunsForRef("sha")],
      [
        "createCheckRun",
        (a) =>
          a.createCheckRun({
            name: "test",
            head_sha: "sha",
            external_id: "ext",
            status: "queued",
          }),
      ],
      ["updateCheckRun", (a) => a.updateCheckRun(1, { status: "completed" })],
      ["listCheckRunAnnotations", (a) => a.listCheckRunAnnotations(1)],
      ["listExistingReviewComments", (a) => a.listExistingReviewComments(1)],
      ["createReview", (a) => a.createReview(1, [], "body")],
    ])("%s throws NotSupportedError", async (_name, invoke) => {
      const adapter = glAdapter();
      await expect(invoke(adapter)).rejects.toThrow(NotSupportedError);
    });
  });
});
