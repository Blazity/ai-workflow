import { describe, it, expect, vi } from "vitest";
import { matchesAnyGlob, buildReviewBundle } from "./pr-context.js";
import type {
  VCSAdapter,
  PRFile,
  ExistingReviewComment,
  ReviewPullRequest,
} from "../adapters/vcs/types.js";
import type { ReviewBundleRequest } from "./pr-context.js";

// ---------------------------------------------------------------------------
// matchesAnyGlob
// ---------------------------------------------------------------------------

describe("matchesAnyGlob", () => {
  it("**/dist/** matches a/dist/b.js", () => {
    expect(matchesAnyGlob("a/dist/b.js", ["**/dist/**"])).toBe(true);
  });

  it("**/dist/** matches dist/x.js (no leading dir)", () => {
    expect(matchesAnyGlob("dist/x.js", ["**/dist/**"])).toBe(true);
  });

  it("**/*.lock matches Gemfile.lock at root", () => {
    expect(matchesAnyGlob("Gemfile.lock", ["**/*.lock"])).toBe(true);
  });

  it("**/*.lock matches a/b/c.lock", () => {
    expect(matchesAnyGlob("a/b/c.lock", ["**/*.lock"])).toBe(true);
  });

  it("pnpm-lock.yaml matches that exact path", () => {
    expect(matchesAnyGlob("pnpm-lock.yaml", ["pnpm-lock.yaml"])).toBe(true);
  });

  it("pnpm-lock.yaml does NOT match package-lock.yaml", () => {
    expect(matchesAnyGlob("package-lock.yaml", ["pnpm-lock.yaml"])).toBe(false);
  });

  it("**/*.generated.* matches src/Foo.generated.ts", () => {
    expect(matchesAnyGlob("src/Foo.generated.ts", ["**/*.generated.*"])).toBe(true);
  });

  it("**/*.test.ts matches a/b.test.ts", () => {
    expect(matchesAnyGlob("a/b.test.ts", ["**/*.test.ts"])).toBe(true);
  });

  it("**/*.test.ts does NOT match a/b.ts", () => {
    expect(matchesAnyGlob("a/b.ts", ["**/*.test.ts"])).toBe(false);
  });

  it("returns false when patterns list is empty", () => {
    expect(matchesAnyGlob("anything.ts", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fake VCS adapter helpers
// ---------------------------------------------------------------------------

function makePRMeta(overrides?: Partial<ReviewPullRequest>): ReviewPullRequest {
  return {
    owner: "acme",
    repo: "app",
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    base: { ref: "main", sha: "base-sha" },
    head: { ref: "feat/my-feature", sha: "head-sha" },
    labels: ["enhancement"],
    title: "My PR",
    body: null,
    draft: false,
    user: "dev",
    ...overrides,
  };
}

function makeFile(path: string, status: PRFile["status"] = "modified"): PRFile {
  return {
    path,
    status,
    additions: 1,
    deletions: 0,
    changed_line_ranges: [{ start: 1, end: 5 }],
  };
}

interface FakeVCSOptions {
  meta?: ReviewPullRequest;
  files?: PRFile[];
  diff?: string;
  fileContents?: Record<string, string | null>;
  comments?: ExistingReviewComment[];
}

class FakeVCSAdapter implements Partial<VCSAdapter> {
  private opts: Required<FakeVCSOptions>;

  constructor(opts: FakeVCSOptions = {}) {
    this.opts = {
      meta: opts.meta ?? makePRMeta(),
      files: opts.files ?? [],
      diff: opts.diff ?? "diff --git a/foo.ts b/foo.ts",
      fileContents: opts.fileContents ?? {},
      comments: opts.comments ?? [],
    };
  }

  getPullRequest = vi.fn(async (_prNumber: number): Promise<ReviewPullRequest> => {
    return this.opts.meta;
  });

  listPRFiles = vi.fn(async (_prNumber: number): Promise<PRFile[]> => {
    return this.opts.files;
  });

  getPRDiff = vi.fn(async (_prNumber: number): Promise<string> => {
    return this.opts.diff;
  });

  getFileContentAtRef = vi.fn(async (path: string, _ref: string): Promise<string | null> => {
    if (path in this.opts.fileContents) {
      return this.opts.fileContents[path];
    }
    return null;
  });

  listExistingReviewComments = vi.fn(async (_prNumber: number): Promise<ExistingReviewComment[]> => {
    return this.opts.comments;
  });
}

const defaultLimits: ReviewBundleRequest["limits"] = {
  max_changed_files: 100,
  max_total_diff_bytes: 1_000_000,
  max_file_content_bytes: 500_000,
};

const baseRequest: ReviewBundleRequest = {
  default_ignore: [],
  limits: defaultLimits,
  need_full_diff: false,
  need_file_contents: false,
  need_prior_comments: false,
  need_ticket: false,
};

const defaultArgs = { owner: "acme", repo: "app", prNumber: 42 };

// ---------------------------------------------------------------------------
// buildReviewBundle
// ---------------------------------------------------------------------------

describe("buildReviewBundle", () => {
  // --- PRContext built from meta ---
  it("builds pr from metadata", async () => {
    const vcs = new FakeVCSAdapter() as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, baseRequest);
    expect(bundle.pr).toEqual({
      owner: "acme",
      repo: "app",
      pr_number: 42,
      pr_url: "https://github.com/acme/app/pull/42",
      base_sha: "base-sha",
      head_sha: "head-sha",
      labels: ["enhancement"],
    });
  });

  // --- Ignore before limits ---
  it("applies ignore globs BEFORE file-count limit", async () => {
    const files = [
      makeFile("dist/bundle.js"),
      makeFile("src/a.ts"),
      makeFile("src/b.ts"),
      makeFile("src/c.ts"),
    ];
    const vcs = new FakeVCSAdapter({ files }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      default_ignore: ["**/dist/**"],
      limits: { ...defaultLimits, max_changed_files: 2 },
    });
    // dist/bundle.js is ignored, leaving 3 eligible, then capped at 2
    expect(bundle.ignored_files).toEqual(["dist/bundle.js"]);
    expect(bundle.files).toHaveLength(2);
    expect(bundle.dropped_files).toHaveLength(1);
  });

  // --- Deleted files skipped for file_contents ---
  it("marks deleted files as skipped:deleted in file_contents", async () => {
    const files = [makeFile("gone.ts", "removed")];
    const vcs = new FakeVCSAdapter({ files }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_file_contents: true,
    });
    expect(bundle.file_contents!["gone.ts"]).toEqual({ path: "gone.ts", skipped: "deleted" });
    expect(bundle.notices).toContain("skipped file gone.ts: deleted");
  });

  // --- Oversized file content skipped ---
  it("marks oversized files as skipped:oversized and adds notice", async () => {
    const bigContent = "x".repeat(200);
    const files = [makeFile("big.ts")];
    const vcs = new FakeVCSAdapter({
      files,
      fileContents: { "big.ts": bigContent },
    }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_file_contents: true,
      limits: { ...defaultLimits, max_file_content_bytes: 100 },
    });
    expect(bundle.file_contents!["big.ts"]).toEqual({ path: "big.ts", skipped: "oversized" });
    expect(bundle.notices).toContain("skipped file big.ts: oversized");
  });

  // --- Full diff truncation ---
  it("truncates full diff when it exceeds max_total_diff_bytes and adds notice", async () => {
    const diff = "a".repeat(50);
    const vcs = new FakeVCSAdapter({ diff }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_full_diff: true,
      limits: { ...defaultLimits, max_total_diff_bytes: 20 },
    });
    expect(bundle.full_diff).toBeDefined();
    expect(bundle.full_diff!.truncated).toBe(true);
    expect(bundle.full_diff!.content).toHaveLength(20);
    expect(bundle.full_diff!.original_bytes).toBe(50);
    expect(bundle.notices.some((n) => n.includes("truncated"))).toBe(true);
  });

  it("includes full diff original_bytes even without truncation", async () => {
    const diff = "short diff";
    const vcs = new FakeVCSAdapter({ diff }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_full_diff: true,
    });
    expect(bundle.full_diff!.truncated).toBe(false);
    expect(bundle.full_diff!.original_bytes).toBe(Buffer.byteLength("short diff", "utf8"));
  });

  // --- need_full_diff: false => no full_diff key ---
  it("omits full_diff when need_full_diff is false", async () => {
    const vcs = new FakeVCSAdapter() as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_full_diff: false,
    });
    expect("full_diff" in bundle).toBe(false);
  });

  // --- Ticket lookup: resolved ---
  it("resolves and fetches ticket when resolveTicket returns an id", async () => {
    const vcs = new FakeVCSAdapter() as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_ticket: true,
      resolveTicket: async () => "PROJ-123",
      fetchTicket: async (id) => ({
        summary: "Do thing",
        description: "desc",
        acceptanceCriteria: "AC",
      }),
    });
    expect(bundle.ticket_id).toBe("PROJ-123");
    expect(bundle.ticket).toEqual({
      id: "PROJ-123",
      summary: "Do thing",
      description: "desc",
      acceptanceCriteria: "AC",
    });
  });

  // --- Ticket lookup: resolveTicket returns null ---
  it("sets ticket_id=null and notice when resolveTicket returns null", async () => {
    const vcs = new FakeVCSAdapter() as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_ticket: true,
      resolveTicket: async () => null,
      fetchTicket: async () => null,
    });
    expect(bundle.ticket_id).toBeNull();
    expect(bundle.ticket).toBeNull();
    expect(bundle.notices).toContain("no ticket linked to this PR");
  });

  // --- File-count limit ---
  it("enforces max_changed_files: keeps first N sorted, puts rest in dropped_files", async () => {
    const files = [
      makeFile("c.ts"),
      makeFile("a.ts"),
      makeFile("b.ts"),
    ];
    const vcs = new FakeVCSAdapter({ files }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      limits: { ...defaultLimits, max_changed_files: 2 },
    });
    expect(bundle.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(bundle.dropped_files).toEqual(["c.ts"]);
    expect(bundle.notices).toContain("dropped 1 files due to max_changed_files=2");
  });

  // --- changed_line_ranges flow-through ---
  it("preserves changed_line_ranges on returned files", async () => {
    const file: PRFile = {
      path: "src/foo.ts",
      status: "modified",
      additions: 5,
      deletions: 2,
      changed_line_ranges: [{ start: 10, end: 20 }, { start: 30, end: 35 }],
    };
    const vcs = new FakeVCSAdapter({ files: [file] }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, baseRequest);
    expect(bundle.files[0].changed_line_ranges).toEqual([{ start: 10, end: 20 }, { start: 30, end: 35 }]);
  });

  // --- prior_comments ---
  it("populates prior_comments when need_prior_comments is true", async () => {
    const comments: ExistingReviewComment[] = [
      { id: 1, path: "src/foo.ts", line: 5, body: "nit", user: "reviewer" },
    ];
    const vcs = new FakeVCSAdapter({ comments }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_prior_comments: true,
    });
    expect(bundle.prior_comments).toEqual(comments);
  });

  it("omits prior_comments when need_prior_comments is false", async () => {
    const vcs = new FakeVCSAdapter() as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, baseRequest);
    expect("prior_comments" in bundle).toBe(false);
  });

  // --- Parallel file-content fetching ---
  it("fetches file contents with bounded parallelism (multiple in flight)", async () => {
    // 10 files; each fetch suspends on a deferred promise. If fetches were
    // serial we'd see inFlight never exceed 1. With concurrency=5, multiple
    // requests must enter before any resolves — proving parallelism without
    // relying on wall-clock or real timers.
    const fileCount = 10;
    const files = Array.from({ length: fileCount }, (_, i) => makeFile(`f${i}.ts`));

    let inFlight = 0;
    let peakInFlight = 0;
    const pendingResolvers: Array<() => void> = [];

    const vcs = new FakeVCSAdapter({ files }) as unknown as VCSAdapter;
    vcs.getFileContentAtRef = vi.fn(async (path: string, _ref: string) => {
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      // Suspend until released. Use a microtask-only mechanism (Promise) so we
      // don't depend on any real-time delay primitive. Resolvers are flushed below.
      await new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
      });
      inFlight -= 1;
      return `content-for-${path}`;
    });

    // Kick off the bundle build but don't await it yet.
    const bundlePromise = buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_file_contents: true,
    });

    // Drain microtasks repeatedly, releasing one batch at a time. Each
    // microtask flush lets buildReviewBundle queue up its next Promise.all
    // batch; we then release them all so the next batch can start.
    // Loop until every file has been fetched.
    let safety = 50;
    while (pendingResolvers.length > 0 || (vcs.getFileContentAtRef as any).mock.calls.length < fileCount) {
      // Allow microtasks to flush so all pending fetches in the current batch
      // are registered.
      await Promise.resolve();
      await Promise.resolve();
      // Release all currently-pending fetches as a batch.
      const toRelease = pendingResolvers.splice(0);
      toRelease.forEach((r) => r());
      safety -= 1;
      if (safety <= 0) break;
    }

    const bundle = await bundlePromise;

    // Sanity: all files resolved with content
    for (let i = 0; i < fileCount; i += 1) {
      expect(bundle.file_contents![`f${i}.ts`]).toEqual({
        path: `f${i}.ts`,
        content: `content-for-f${i}.ts`,
      });
    }
    // Concurrency proof: multiple fetches were in flight simultaneously.
    // Serial behaviour would give peakInFlight === 1.
    expect(peakInFlight).toBeGreaterThan(1);
    // Stronger proof: with concurrency=5 we expect to observe up to 5 in flight.
    expect(peakInFlight).toBeLessThanOrEqual(5);
  });

  // --- fetch_failed ---
  it("marks file as fetch_failed when getFileContentAtRef returns null", async () => {
    const files = [makeFile("mystery.ts")];
    const vcs = new FakeVCSAdapter({
      files,
      fileContents: { "mystery.ts": null },
    }) as unknown as VCSAdapter;
    const bundle = await buildReviewBundle(vcs, defaultArgs, {
      ...baseRequest,
      need_file_contents: true,
    });
    expect(bundle.file_contents!["mystery.ts"]).toEqual({ path: "mystery.ts", skipped: "fetch_failed" });
    expect(bundle.notices).toContain("skipped file mystery.ts: content unavailable");
  });
});
