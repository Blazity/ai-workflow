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

  describe("getPRHead", () => {
    it("reads the authoritative MR head and current head-pipeline id", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({
        diff_refs: { head_sha: "source-head-sha" },
        head_pipeline: { id: 901 },
      });

      const adapter = glAdapter();

      await expect(adapter.getPRHead(42)).resolves.toEqual({
        headSha: "source-head-sha",
        headPipelineId: 901,
      });
      expect(mockMergeRequests.show).toHaveBeenCalledWith("blazity/demo-app", 42);
      expect(mockBranches.show).not.toHaveBeenCalled();
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

  describe("getPRHeadSha", () => {
    it("returns the provider's current merge request head", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({ sha: "current-head" });

      await expect(glAdapter().getPRHeadSha(42)).resolves.toBe("current-head");
      expect(mockMergeRequests.show).toHaveBeenCalledWith("blazity/demo-app", 42);
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
