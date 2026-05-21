import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAdapter, buildCheckRunExternalId, parseChangedLineRangesFromPatch } from "./github.js";

const mockOctokit = {
  git: {
    getRef: vi.fn(),
    createRef: vi.fn(),
    updateRef: vi.fn(),
  },
  repos: {
    createOrUpdateFileContents: vi.fn(),
    getContent: vi.fn(),
  },
  pulls: {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    listFiles: vi.fn(),
    listCommits: vi.fn(),
    listReviewComments: vi.fn(),
    createReview: vi.fn(),
  },
  issues: {
    listComments: vi.fn(),
  },
  checks: {
    listForRef: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    listAnnotations: vi.fn(),
  },
  paginate: vi.fn(async (fn: any, params: any) => {
    const result = await fn(params);
    return result.data;
  }),
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

  describe("getPullRequest", () => {
    it("maps fields correctly including labels", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          number: 7,
          html_url: "https://github.com/test-org/test-repo/pull/7",
          base: { ref: "main", sha: "base-sha" },
          head: { ref: "feat/review", sha: "head-sha" },
          labels: [{ name: "bug" }, { name: "review-requested" }, { name: null }],
          title: "Fix bug",
          body: "Fixes a bug",
          draft: false,
          user: { login: "dev1" },
        },
      });

      const adapter = ghAdapter();
      const pr = await adapter.getPullRequest(7);

      expect(pr).toEqual({
        owner: "test-org",
        repo: "test-repo",
        number: 7,
        url: "https://github.com/test-org/test-repo/pull/7",
        base: { ref: "main", sha: "base-sha" },
        head: { ref: "feat/review", sha: "head-sha" },
        labels: ["bug", "review-requested"],
        title: "Fix bug",
        body: "Fixes a bug",
        draft: false,
        user: "dev1",
      });
    });

    it("returns null body when PR has no body", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          number: 8,
          html_url: "https://github.com/test-org/test-repo/pull/8",
          base: { ref: "main", sha: "base-sha" },
          head: { ref: "feat/x", sha: "head-sha" },
          labels: [],
          title: "No body PR",
          body: null,
          draft: false,
          user: null,
        },
      });

      const adapter = ghAdapter();
      const pr = await adapter.getPullRequest(8);
      expect(pr.body).toBeNull();
      expect(pr.user).toBeNull();
    });
  });

  describe("listPRFiles", () => {
    it("parses changed_line_ranges from a patch with two hunks", async () => {
      const patch = [
        "@@ -1,4 +1,5 @@",
        " context",
        "+added line 2",
        "+added line 3",
        " context",
        "-removed line",
        " context",
        "@@ -10,3 +11,4 @@",
        " context",
        "+added line 12",
        " context",
        "+added line 14",
      ].join("\n");

      mockOctokit.paginate.mockResolvedValueOnce([
        {
          filename: "src/foo.ts",
          previous_filename: undefined,
          status: "modified",
          additions: 4,
          deletions: 1,
          patch,
        },
      ]);

      const adapter = ghAdapter();
      const files = await adapter.listPRFiles(7);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/foo.ts");
      // Hunk 1: lines 2-3 are contiguous additions
      // Hunk 2: line 12 is a single addition, line 14 is a separate addition
      expect(files[0].changed_line_ranges).toEqual([
        { start: 2, end: 3 },
        { start: 12, end: 12 },
        { start: 14, end: 14 },
      ]);
    });
  });

  describe("getPRDiff", () => {
    it("requests diff format and returns the raw string", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({ data: "diff --git a/foo b/foo\n..." });

      const adapter = ghAdapter();
      const diff = await adapter.getPRDiff(7);

      expect(diff).toBe("diff --git a/foo b/foo\n...");
      expect(mockOctokit.pulls.get).toHaveBeenCalledWith(
        expect.objectContaining({ mediaType: { format: "diff" } }),
      );
    });

    it("throws when Octokit returns a non-string body (e.g. JSON object)", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({ data: { number: 7, title: "Not a diff" } });

      const adapter = ghAdapter();
      await expect(adapter.getPRDiff(7)).rejects.toThrow(
        /Expected raw diff string from GitHub, got object/,
      );
    });
  });

  describe("getFileContentAtRef", () => {
    it("decodes base64 content", async () => {
      const content = Buffer.from("const x = 1;\n").toString("base64");
      mockOctokit.repos.getContent.mockResolvedValueOnce({
        data: { type: "file", content, encoding: "base64" },
      });

      const adapter = ghAdapter();
      const result = await adapter.getFileContentAtRef("src/x.ts", "abc123");

      expect(result).toBe("const x = 1;\n");
    });

    it("returns null on 404", async () => {
      const err = new Error("Not Found") as any;
      err.status = 404;
      mockOctokit.repos.getContent.mockRejectedValueOnce(err);

      const adapter = ghAdapter();
      const result = await adapter.getFileContentAtRef("missing.ts", "abc123");
      expect(result).toBeNull();
    });

    it("returns null when content is a directory", async () => {
      mockOctokit.repos.getContent.mockResolvedValueOnce({
        data: [{ type: "file", name: "foo.ts" }],
      });

      const adapter = ghAdapter();
      const result = await adapter.getFileContentAtRef("src/", "abc123");
      expect(result).toBeNull();
    });
  });

  describe("createCheckRun", () => {
    it("passes external_id and returns mapped ref", async () => {
      mockOctokit.checks.create.mockResolvedValueOnce({
        data: {
          id: 999,
          external_id: "ai-workflow:hash123:lint:sha456",
          name: "AI Lint",
          head_sha: "sha456",
          status: "queued",
          conclusion: null,
          output: { text: null },
        },
      });

      const adapter = ghAdapter();
      const ref = await adapter.createCheckRun({
        name: "AI Lint",
        head_sha: "sha456",
        external_id: "ai-workflow:hash123:lint:sha456",
        status: "queued",
      });

      expect(mockOctokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({ external_id: "ai-workflow:hash123:lint:sha456" }),
      );
      expect(ref.id).toBe(999);
      expect(ref.external_id).toBe("ai-workflow:hash123:lint:sha456");
    });
  });

  describe("updateCheckRun", () => {
    it("sends check_run_id correctly", async () => {
      mockOctokit.checks.update.mockResolvedValueOnce({
        data: {
          id: 999,
          external_id: "ext-1",
          name: "AI Lint",
          head_sha: "sha456",
          status: "completed",
          conclusion: "success",
          output: { text: "All good" },
        },
      });

      const adapter = ghAdapter();
      const ref = await adapter.updateCheckRun(999, {
        status: "completed",
        conclusion: "success",
      });

      expect(mockOctokit.checks.update).toHaveBeenCalledWith(
        expect.objectContaining({ check_run_id: 999 }),
      );
      expect(ref.status).toBe("completed");
      expect(ref.conclusion).toBe("success");
      expect(ref.output_text).toBe("All good");
    });
  });

  describe("listCheckRunsForRef", () => {
    it("returns mapped refs with output_text", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        {
          id: 1,
          external_id: "ext-1",
          name: "lint",
          head_sha: "sha1",
          status: "completed",
          conclusion: "success",
          output: { text: "Lint passed" },
        },
        {
          id: 2,
          external_id: null,
          name: "test",
          head_sha: "sha1",
          status: "in_progress",
          conclusion: null,
          output: {},
        },
      ]);

      const adapter = ghAdapter();
      const refs = await adapter.listCheckRunsForRef("sha1");

      expect(refs).toHaveLength(2);
      expect(refs[0]).toEqual({
        id: 1,
        external_id: "ext-1",
        name: "lint",
        head_sha: "sha1",
        status: "completed",
        conclusion: "success",
        output_text: "Lint passed",
      });
      expect(refs[1].output_text).toBeNull();
    });
  });

  describe("listCheckRunAnnotations", () => {
    it("returns mapped annotations", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        {
          path: "src/foo.ts",
          start_line: 10,
          end_line: 10,
          start_column: 1,
          end_column: 5,
          annotation_level: "warning",
          message: "Use const",
          title: "Prefer const",
          raw_details: null,
        },
      ]);

      const adapter = ghAdapter();
      const annotations = await adapter.listCheckRunAnnotations(42);

      expect(annotations).toHaveLength(1);
      expect(annotations[0]).toEqual({
        path: "src/foo.ts",
        start_line: 10,
        end_line: 10,
        start_column: 1,
        end_column: 5,
        annotation_level: "warning",
        message: "Use const",
        title: "Prefer const",
        raw_details: undefined,
      });
    });
  });

  describe("listExistingReviewComments", () => {
    it("returns mapped comments", async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        {
          id: 100,
          path: "src/foo.ts",
          line: 20,
          body: "Consider extracting this",
          user: { login: "reviewer1" },
        },
        {
          id: 101,
          path: null,
          line: null,
          body: "Outdated comment",
          user: null,
        },
      ]);

      const adapter = ghAdapter();
      const comments = await adapter.listExistingReviewComments(7);

      expect(comments).toHaveLength(2);
      expect(comments[0]).toEqual({
        id: 100,
        path: "src/foo.ts",
        line: 20,
        body: "Consider extracting this",
        user: "reviewer1",
      });
      expect(comments[1]).toEqual({
        id: 101,
        path: null,
        line: null,
        body: "Outdated comment",
        user: null,
      });
    });
  });

  describe("createReview", () => {
    it("sends event COMMENT and batched comments", async () => {
      mockOctokit.pulls.createReview.mockResolvedValueOnce({ data: { id: 1 } });

      const adapter = ghAdapter();
      await adapter.createReview(
        7,
        [
          { path: "src/foo.ts", line: 10, body: "Nit: rename this" },
          { path: "src/bar.ts", line: 20, side: "LEFT", body: "Old code" },
        ],
        "Overall LGTM with minor nits",
      );

      expect(mockOctokit.pulls.createReview).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 7,
        event: "COMMENT",
        body: "Overall LGTM with minor nits",
        comments: [
          { path: "src/foo.ts", line: 10, side: "RIGHT", body: "Nit: rename this" },
          { path: "src/bar.ts", line: 20, side: "LEFT", body: "Old code" },
        ],
      });
    });
  });
});

describe("buildCheckRunExternalId", () => {
  it("formats ai-workflow:<hash>:<id>:<sha>", () => {
    const id = buildCheckRunExternalId("abc123", "lint", "deadbeef");
    expect(id).toBe("ai-workflow:abc123:lint:deadbeef");
  });
});

describe("parseChangedLineRangesFromPatch", () => {
  it("returns empty array for undefined patch", () => {
    expect(parseChangedLineRangesFromPatch(undefined)).toEqual([]);
  });

  it("returns empty array for patch with no additions", () => {
    const patch = "@@ -1,3 +1,2 @@\n context\n-removed\n context\n";
    expect(parseChangedLineRangesFromPatch(patch)).toEqual([]);
  });

  it("merges contiguous additions into one range", () => {
    const patch = "@@ -1,1 +1,3 @@\n+line1\n+line2\n+line3\n";
    expect(parseChangedLineRangesFromPatch(patch)).toEqual([{ start: 1, end: 3 }]);
  });

  it("splits non-contiguous additions into separate ranges", () => {
    const patch = "@@ -1,4 +1,4 @@\n+added1\n context\n+added3\n context\n";
    expect(parseChangedLineRangesFromPatch(patch)).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 3 },
    ]);
  });

  it("does not treat +++ file header as an addition", () => {
    const patch = "+++ b/src/foo.ts\n@@ -1,1 +1,2 @@\n context\n+real addition\n";
    const ranges = parseChangedLineRangesFromPatch(patch);
    // only the real addition inside the hunk should appear
    expect(ranges).toEqual([{ start: 2, end: 2 }]);
  });

  it("ignores the in-hunk '\\ No newline at end of file' marker", () => {
    const patch = "@@ -1,1 +1,1 @@\n+real addition\n\\ No newline at end of file\n";
    const ranges = parseChangedLineRangesFromPatch(patch);
    // only the real addition should appear — the backslash metadata marker is not an addition
    expect(ranges).toEqual([{ start: 1, end: 1 }]);
  });
});
