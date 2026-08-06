import { describe, expect, it, vi } from "vitest";
import type { ReviewResult, ReviewResultFinding } from "@shared/contracts";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.js";
import {
  workflowPrReviewPublicationComments,
  workflowPrReviewPublications,
  workflowRunExternalChecks,
  workflowRuns,
} from "../db/schema.js";
import { pendingPrCheckIntent } from "./agent.js";
import {
  closeRunPrChecks,
  completeRunOwnedPrCheck,
  createRunOwnedPrCheck,
  partitionReviewFindings,
  publishRunOwnedPrReview,
  reconcilePendingPrChecks,
  reviewCommentContentHash,
  reviewFindingBlocksPublication,
} from "./pr-external-resources.js";
import {
  mergedReviewFindingCommentBody,
  type MergedReviewFinding,
} from "./review-finding-merge.js";

const { mockUpdateGateStatus, mockCreateRepositoryVCS, mockAssertActiveRunOwner } =
  vi.hoisted(() => ({
    mockUpdateGateStatus: vi.fn(),
    mockCreateRepositoryVCS: vi.fn(),
    mockAssertActiveRunOwner: vi.fn(),
  }));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: mockCreateRepositoryVCS,
}));
vi.mock("../lib/active-run-owner.js", () => ({
  assertActiveRunOwner: mockAssertActiveRunOwner,
}));

function gateStatusVcs() {
  return { createGateStatus: vi.fn(), updateGateStatus: mockUpdateGateStatus };
}

describe("PR review diff placement", () => {
  it("places only complete safe ranges inline and falls back otherwise", () => {
    const results: ReviewResult[] = [
      {
        decision: "request_changes",
        findings: [
          {
            file: "src/a.ts",
            description: "Inline",
            severity: "Blocker",
            startLine: 3,
            endLine: 4,
          },
          {
            file: "src/a.ts",
            description: "Outside the patch",
            severity: "Medium",
            startLine: 10,
          },
          {
            file: "../secret",
            description: "Unsafe path",
            severity: "Blocker",
            startLine: 3,
          },
          {
            file: "src/a.ts",
            description: "Unbounded range",
            severity: "Blocker",
            startLine: 1,
            endLine: Number.MAX_SAFE_INTEGER,
          },
          {
            file: "src/a.ts",
            description: "Inverted range",
            severity: "Blocker",
            startLine: 4,
            endLine: 3,
          },
          {
            file: "src/a.ts",
            description: "No location",
            severity: "Nit",
          },
        ],
      },
    ];
    const partition = partitionReviewFindings(results, [
      {
        path: "src/a.ts",
        additions: 2,
        deletions: 0,
        changeType: "modified",
        patch: "@@ -3,2 +3,2 @@\n context\n+added",
      },
    ]);

    expect(partition.comments).toEqual([
      {
        path: "src/a.ts",
        body: "**Blocker**: Inline",
        startLine: 3,
        endLine: 4,
        startOldLine: 3,
        endOldLine: null,
      },
    ]);
    expect(partition.fallback.map((finding) => finding.description)).toEqual([
      "Outside the patch",
      "Unsafe path",
      "Unbounded range",
      "Inverted range",
      "No location",
    ]);
  });

  // Reproduces production run wrun_...4N9DD3: three reviewers, three findings
  // each, and only six distinct defects between them.
  it("publishes one comment per defect when reviewers overlap", () => {
    const patch = "@@ -1,6 +1,6 @@\n+one\n+two\n+three\n+four\n+five\n+six";
    const at = (line: number, description: string) => ({
      file: "src/a.ts",
      description,
      severity: "High" as const,
      startLine: line,
      endLine: line,
    });
    const results: ReviewResult[] = [
      {
        decision: "request_changes",
        findings: [
          at(3, "Delete removes the last record when findIndex reports minus one."),
          at(5, "The listing endpoint leaks every customer when the filter is empty."),
        ],
      },
      {
        decision: "request_changes",
        findings: [
          at(3, "Deleting with an unknown id splices index minus one and drops a row."),
        ],
      },
      {
        decision: "request_changes",
        findings: [
          at(3, "Removing a refund needs no credentials, which the criteria forbid."),
        ],
      },
    ];

    const partition = partitionReviewFindings(results, [
      { path: "src/a.ts", additions: 6, deletions: 0, changeType: "modified", patch },
    ]);

    expect(partition.reportedCount).toBe(4);
    expect(partition.distinctCount).toBe(2);
    expect(partition.comments).toHaveLength(2);

    const merged = partition.comments.find((comment) => comment.startLine === 3);
    expect(merged?.body).toContain("Reported by 3 of 3 reviewers.");
    const alone = partition.comments.find((comment) => comment.startLine === 5);
    // The lone High is never presented as agreed, and it now states the opposite
    // outright, because on its own it no longer fails the check.
    expect(alone?.body).toContain(
      "Reported by 1 of 3 reviewers. A High blocks only when 2 reviewers report it independently.",
    );
  });

  // The first production run after the cap shipped withheld exactly one
  // finding, and the heading read "1 further findings". Client-facing text.
  it("counts a single withheld finding in the singular", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-one-withheld" });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([
        {
          path: "src/a.ts",
          additions: 30,
          deletions: 0,
          changeType: "modified",
          patch: `@@ -1,30 +1,30 @@\n${Array.from({ length: 30 }, (_, i) => `+line${i}`).join("\n")}`,
        },
      ]),
      publishPRReview: vi
        .fn()
        .mockResolvedValue({ id: "review-11", commentIds: [] }),
    });

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#11",
        ownerToken: "owner-11",
        runId: "run-one-withheld",
      },
      target: {
        subjectKey: "pr:github:acme/app#11",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 11,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        {
          decision: "request_changes",
          findings: Array.from({ length: 11 }, (_, index) => ({
            file: "src/a.ts",
            description: `Unrelated defect ${index} about subject ${"y".repeat(index)}.`,
            severity: "Medium" as const,
            startLine: index * 2 + 1,
            endLine: index * 2 + 1,
          })),
        },
      ],
    });

    expect(result.inlineCommentCount).toBe(10);
    expect(result.summary).toContain("1 further finding not shown inline");
    expect(result.summary).not.toContain("1 further findings");
  });

  /**
   * The summary bullet is the OTHER surface the note reaches, and the two ways a
   * finding lands on it are covered one each: this test loses its inline position
   * (a line the diff does not carry) and the next one loses its inline slot to
   * the cap. Both assert the whole summary byte for byte, because the note's
   * indent is invisible in a substring match and is what keeps the bullet from
   * splitting the list in two.
   */
  it("carries the blocking rule into a bullet no inline comment could hold", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-fallback-high" });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([
        {
          path: "src/a.ts",
          additions: 2,
          deletions: 0,
          changeType: "modified",
          patch: "@@ -3,2 +3,2 @@\n context\n+added",
        },
      ]),
      publishPRReview: vi
        .fn()
        .mockResolvedValue({ id: "review-30", commentIds: [] }),
    });

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#30",
        ownerToken: "owner-30",
        runId: "run-fallback-high",
      },
      target: {
        subjectKey: "pr:github:acme/app#30",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 30,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        { decision: "approve", findings: [] },
        {
          decision: "request_changes",
          findings: [
            {
              // Line 50 is outside the only hunk, so no provider would accept an
              // inline comment there and the finding falls into the summary.
              file: "src/a.ts",
              description: "A failed job is retried without any backoff.",
              severity: "High",
              startLine: 50,
              endLine: 50,
            },
          ],
        },
        { decision: "approve", findings: [] },
      ],
    });

    expect(result.inlineCommentCount).toBe(0);
    expect(result.summaryFallbackCount).toBe(1);
    expect(result.decision).toBe("approve");
    expect(result.summary).toBe(
      [
        "## AI Workflow review",
        "",
        "### Findings not placed inline",
        "- **High** `src/a.ts:50`: A failed job is retried without any backoff.",
        "",
        "  Reported by 1 of 3 reviewers. A High blocks only when 2 reviewers report it independently.",
      ].join("\n"),
    );
  });

  it("carries the blocking rule into a bullet the inline cap withheld", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-withheld-high" });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([
        {
          path: "src/a.ts",
          additions: 30,
          deletions: 0,
          changeType: "modified",
          patch: `@@ -1,30 +1,30 @@\n${Array.from({ length: 30 }, (_, i) => `+line${i}`).join("\n")}`,
        },
      ]),
      publishPRReview: vi
        .fn()
        .mockResolvedValue({ id: "review-31", commentIds: [] }),
    });

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#31",
        ownerToken: "owner-31",
        runId: "run-withheld-high",
      },
      target: {
        subjectKey: "pr:github:acme/app#31",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 31,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        {
          // Ten Blockers outrank the High for every inline slot, which is the
          // only way a High reaches the withheld section: the ranking puts
          // severity first.
          decision: "request_changes",
          findings: Array.from({ length: 10 }, (_, index) => ({
            file: "src/a.ts",
            description: `Blocking defect ${index} about subject ${"z".repeat(index)}.`,
            severity: "Blocker" as const,
            startLine: index * 2 + 1,
            endLine: index * 2 + 1,
          })),
        },
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "A failed job is retried without any backoff.",
              severity: "High",
              startLine: 22,
              endLine: 22,
            },
          ],
        },
        { decision: "approve", findings: [] },
      ],
    });

    expect(result.inlineCommentCount).toBe(10);
    // The Blockers request changes, and the withheld High still states why it
    // was not the reason: a reader must not read the red check off this bullet.
    expect(result.decision).toBe("request_changes");
    expect(result.summary).toBe(
      [
        "## AI Workflow review",
        "",
        "### 1 further finding not shown inline",
        "- **High** `src/a.ts:22`: A failed job is retried without any backoff.",
        "",
        "  Reported by 1 of 3 reviewers. A High blocks only when 2 reviewers report it independently.",
      ].join("\n"),
    );
  });

  it("caps the inline comments and names the rest in the summary", () => {
    const patch = `@@ -1,40 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => `+line${i}`).join("\n")}`;
    const results: ReviewResult[] = [
      {
        decision: "request_changes",
        findings: Array.from({ length: 14 }, (_, index) => ({
          file: "src/a.ts",
          // Distinct lines far apart and distinct wording, so nothing merges.
          description: `Defect number ${index} concerns an unrelated subject ${"x".repeat(index)}.`,
          severity: "Medium" as const,
          startLine: index * 2 + 1,
          endLine: index * 2 + 1,
        })),
      },
    ];

    const partition = partitionReviewFindings(results, [
      { path: "src/a.ts", additions: 40, deletions: 0, changeType: "modified", patch },
    ]);

    expect(partition.distinctCount).toBe(14);
    expect(partition.comments).toHaveLength(10);
    expect(partition.withheld).toHaveLength(4);
    // Nothing vanishes: everything not inline is accounted for.
    expect(
      partition.comments.length + partition.fallback.length + partition.withheld.length,
    ).toBe(partition.distinctCount);
  });

  it("gives the inline slots to the most severe and most agreed findings", () => {
    const patch = `@@ -1,20 +1,20 @@\n${Array.from({ length: 20 }, (_, i) => `+line${i}`).join("\n")}`;
    const shared = "Both reviewers describe the identical unbounded page size problem.";
    const results: ReviewResult[] = [
      {
        decision: "request_changes",
        findings: [
          { file: "a.ts", description: "A nit about naming only.", severity: "Nit", startLine: 1, endLine: 1 },
          { file: "a.ts", description: shared, severity: "Medium", startLine: 5, endLine: 5 },
          { file: "a.ts", description: "A blocking authorization hole.", severity: "Blocker", startLine: 9, endLine: 9 },
        ],
      },
      {
        decision: "request_changes",
        findings: [
          { file: "a.ts", description: shared, severity: "Medium", startLine: 5, endLine: 5 },
          { file: "a.ts", description: "A lone medium about logging.", severity: "Medium", startLine: 13, endLine: 13 },
        ],
      },
    ];

    const partition = partitionReviewFindings(results, [
      { path: "a.ts", additions: 20, deletions: 0, changeType: "modified", patch },
    ], { maxComments: 2 });

    const bodies = partition.comments.map((comment) => comment.body).join("\n");
    expect(bodies).toContain("Blocker");
    // The Medium two reviewers agreed on outranks the Medium only one raised.
    expect(bodies).toContain("Reported by 2 of 2 reviewers.");
    expect(partition.withheld.map((finding) => finding.severity)).toContain("Nit");
  });

  it("preserves legitimate a/ and b/ repository paths", () => {
    const results: ReviewResult[] = [
      {
        decision: "request_changes",
        findings: [
          {
            file: "a/index.ts",
            description: "Legitimate path",
            severity: "Blocker",
            startLine: 1,
          },
          {
            file: "b/src/index.ts",
            description: "Diff-prefixed path",
            severity: "Medium",
            startLine: 1,
          },
        ],
      },
    ];

    const partition = partitionReviewFindings(results, [
      {
        path: "a/index.ts",
        additions: 1,
        deletions: 0,
        changeType: "added",
        patch: "@@ -0,0 +1 @@\n+one",
      },
      {
        path: "src/index.ts",
        additions: 1,
        deletions: 0,
        changeType: "added",
        patch: "@@ -0,0 +1 @@\n+two",
      },
    ]);

    expect(partition.comments.map((comment) => comment.path)).toEqual([
      "a/index.ts",
      "src/index.ts",
    ]);
  });

  it("gives duplicate comments distinct stable persistence hashes", () => {
    const comment = {
      path: "src/index.ts",
      body: "Same finding",
      startLine: 1,
      endLine: 1,
      startOldLine: null,
      endOldLine: null,
    };

    expect(reviewCommentContentHash(comment, 0)).not.toBe(
      reviewCommentContentHash(comment, 1),
    );
    expect(reviewCommentContentHash(comment, 0)).toBe(
      reviewCommentContentHash(comment, 0),
    );
  });

  it("pins the hash of a comment partitionReviewFindings built", () => {
    // A LITERAL DIGEST ON PURPOSE, and the comment has to come out of the
    // partition rather than out of this test. The hash is JSON.stringify of the
    // comment object, so the ORDER of the keys written in
    // `partitionReviewFindings` is part of it: reorder them and every hash
    // already stored for every published comment is rewritten, orphaning the
    // rows that carry a provider reference. Comparing two computed hashes
    // cannot see that, because both sides move together.
    const partition = partitionReviewFindings(
      [
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Inline",
              severity: "Blocker",
              startLine: 3,
              endLine: 4,
            },
          ],
        },
      ],
      [
        {
          path: "src/a.ts",
          additions: 2,
          deletions: 0,
          changeType: "modified",
          patch: "@@ -3,2 +3,2 @@\n context\n+added",
        },
      ],
    );

    expect(reviewCommentContentHash(partition.comments[0]!, 0)).toBe(
      "55af47956fe22fa8bb6a4902b60aca820a1d49704e98493e6fb7be6f46db3a50",
    );
  });
});

/**
 * The one rule three surfaces read: the check's verdict, the inline comment body
 * and the summary bullet. Asserted here directly rather than only through a
 * published review, because the last test in this block cannot be written any
 * other way: it reads the threshold OUT of the rule and demands the published
 * sentence quote the same number.
 */
describe("the High agreement rule", () => {
  const FILES = [
    {
      path: "src/a.ts",
      additions: 4,
      deletions: 0,
      changeType: "modified" as const,
      patch: "@@ -1,4 +1,4 @@\n+one\n+two\n+three\n+four",
    },
  ];

  /**
   * One defect that `reporters` of `reviewerCount` reviewers reported, built by
   * the production partition so its `sources` are the ones merging produces.
   * Same line and same severity, which is what merges without a wording gate.
   */
  function oneDefect(
    severity: ReviewResultFinding["severity"],
    reporters: number,
    reviewerCount: number,
  ): MergedReviewFinding {
    const results: ReviewResult[] = Array.from(
      { length: reviewerCount },
      (_, index) => ({
        decision: "request_changes" as const,
        findings:
          index < reporters
            ? [
                {
                  file: "src/a.ts",
                  description: `Reviewer ${index} worded it this way.`,
                  severity,
                  startLine: 2,
                  endLine: 2,
                },
              ]
            : [],
      }),
    );
    const partition = partitionReviewFindings(results, FILES);
    expect(partition.merged).toHaveLength(1);
    expect(partition.merged[0]!.sources).toHaveLength(reporters);
    return partition.merged[0]!;
  }

  it("blocks a Blocker alone and a High only once reviewers agree", () => {
    expect(reviewFindingBlocksPublication(oneDefect("Blocker", 1, 3), 3)).toBe(true);
    expect(reviewFindingBlocksPublication(oneDefect("High", 1, 3), 3)).toBe(false);
    expect(reviewFindingBlocksPublication(oneDefect("High", 2, 3), 3)).toBe(true);
    // Neither of the lower severities blocks at any level of agreement.
    expect(reviewFindingBlocksPublication(oneDefect("Medium", 3, 3), 3)).toBe(false);
    expect(reviewFindingBlocksPublication(oneDefect("Nit", 3, 3), 3)).toBe(false);
    // min(2, 1): a graph with one reviewer has nobody to agree with, so its High
    // keeps blocking on its own. This is the Arthur definition's shape.
    expect(reviewFindingBlocksPublication(oneDefect("High", 1, 1), 1)).toBe(true);
  });

  it("publishes the threshold it enforces and never a numeral beside it", () => {
    // Read out of the rule, not written down: the smallest agreement the gate
    // accepts for a High in a three-reviewer graph.
    const enforced = [1, 2, 3].find((reporters) =>
      reviewFindingBlocksPublication(oneDefect("High", reporters, 3), 3),
    );

    expect(enforced).toBe(2);
    // Raise the threshold and this is what used to keep publishing "two" on a
    // client pull request while the check enforced something else.
    expect(
      mergedReviewFindingCommentBody(oneDefect("High", 1, 3), 3, false),
    ).toBe(
      "**High**: Reviewer 0 worded it this way.\n\n" +
        `Reported by 1 of 3 reviewers. A High blocks only when ${enforced} reviewers report it independently.`,
    );
  });
});

describe("PR check reconciliation", () => {
  function pendingCheck(overrides: { id: string; runId: string; updatedAt: Date }) {
    return {
      nodeId: "create-check",
      attempt: 1,
      activationScope: "root",
      subjectKey: "pr:github:acme/app#9",
      provider: "github",
      repository: "acme/app",
      prNumber: 9,
      headSha: "head",
      name: "AI Workflow / Review",
      providerReference: { provider: "github" as const, id: 9 },
      state: "pending",
      ...overrides,
    };
  }

  const longAgo = new Date(Date.now() - 10 * 60 * 1000);

  it("closes a check the run abandoned, so the pull request stops waiting forever", async () => {
    mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockImplementation(gateStatusVcs);
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-dead", status: "failed" });
    await db.insert(workflowRunExternalChecks).values([
      pendingCheck({ id: "check-abandoned", runId: "run-dead", updatedAt: longAgo }),
    ]);

    await expect(reconcilePendingPrChecks(db)).resolves.toEqual({
      attempted: 1,
      closed: 1,
      pending: 0,
    });
    // Cancelled, never "failure": the run died without judging the code.
    expect(mockUpdateGateStatus).toHaveBeenCalledWith(
      { provider: "github", id: 9 },
      expect.objectContaining({ conclusion: "cancelled" }),
    );
    const [row] = await db
      .select()
      .from(workflowRunExternalChecks)
      .where(eq(workflowRunExternalChecks.id, "check-abandoned"));
    expect(row.state).toBe("completed");
    expect(row.conclusion).toBe("cancelled");
  });

  it("never touches a check whose run can still deliver a verdict", async () => {
    mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockImplementation(gateStatusVcs);
    const db = await createTestDb();
    await db.insert(workflowRuns).values([
      { runId: "run-live", status: "running" },
      { runId: "run-just-ended", status: "failed" },
    ]);
    await db.insert(workflowRunExternalChecks).values([
      // Running for hours: still the run's to close.
      pendingCheck({ id: "check-live", runId: "run-live", updatedAt: longAgo }),
      // Ended a moment ago: its own closing write may still be in flight, and
      // stamping "cancelled" here would erase a real verdict.
      pendingCheck({ id: "check-fresh", runId: "run-just-ended", updatedAt: new Date() }),
    ]);

    await expect(reconcilePendingPrChecks(db)).resolves.toEqual({
      attempted: 0,
      closed: 0,
      pending: 0,
    });
    expect(mockUpdateGateStatus).not.toHaveBeenCalled();
    const rows = await db.select().from(workflowRunExternalChecks);
    expect(rows.every((row) => row.state === "pending")).toBe(true);
  });

  it("closes each check with its own stored conclusion", async () => {
    mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockImplementation(gateStatusVcs);
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-1" });
    await db.insert(workflowRunExternalChecks).values([
      {
        id: "check-success",
        runId: "run-1",
        nodeId: "complete-success",
        attempt: 1,
        activationScope: "root",
        subjectKey: "pr:github:acme/app#7",
        provider: "github",
        repository: "acme/app",
        prNumber: 7,
        headSha: "head",
        name: "AI Workflow / success",
        providerReference: { provider: "github", id: 1 },
        state: "closing",
        closureIntent: "success",
      },
      {
        id: "check-failure",
        runId: "run-1",
        nodeId: "complete-failure",
        attempt: 1,
        activationScope: "root",
        subjectKey: "pr:github:acme/app#7",
        provider: "github",
        repository: "acme/app",
        prNumber: 7,
        headSha: "head",
        name: "AI Workflow / failure",
        providerReference: { provider: "github", id: 2 },
        state: "closing",
        closureIntent: "failure",
      },
    ]);

    await expect(reconcilePendingPrChecks(db)).resolves.toEqual({
      attempted: 2,
      closed: 2,
      pending: 0,
    });
    expect(mockUpdateGateStatus).toHaveBeenCalledWith(
      { provider: "github", id: 1 },
      expect.objectContaining({ conclusion: "success" }),
    );
    expect(mockUpdateGateStatus).toHaveBeenCalledWith(
      { provider: "github", id: 2 },
      expect.objectContaining({ conclusion: "failure" }),
    );
    const rows = await db
      .select()
      .from(workflowRunExternalChecks)
      .where(eq(workflowRunExternalChecks.runId, "run-1"));
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.conclusion])),
    ).toEqual({
      "check-success": "success",
      "check-failure": "failure",
    });
  });
});

describe("terminal PR check settlement", () => {
  async function pendingCheckDb(runId: string) {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId });
    await db.insert(workflowRunExternalChecks).values({
      id: `${runId}-check`,
      runId,
      nodeId: "create-check",
      attempt: 1,
      activationScope: "root",
      subjectKey: "pr:github:acme/app#7",
      provider: "github",
      repository: "acme/app",
      prNumber: 7,
      headSha: "head",
      name: "AI Workflow / Review",
      providerReference: { provider: "github", id: 11 },
      state: "pending",
    });
    return db;
  }

  it.each([
    ["sandbox", "cancelled"],
    ["provider", "cancelled"],
    ["timeout", "timed_out"],
  ] as const)(
    "settles a %s failure without asserting a verdict",
    async (category, expectedIntent) => {
      mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
      mockCreateRepositoryVCS.mockReset().mockImplementation(gateStatusVcs);
      const db = await pendingCheckDb(`run-${category}`);

      const intent = pendingPrCheckIntent({ category });
      expect(intent).toBe(expectedIntent);

      await closeRunPrChecks({
        db,
        runId: `run-${category}`,
        intent,
        details: "The review could not run.",
      });

      expect(mockUpdateGateStatus).toHaveBeenCalledTimes(1);
      const { conclusion } = mockUpdateGateStatus.mock.calls[0]![1] as {
        conclusion: string;
      };
      expect(conclusion).not.toBe("failure");
      expect(conclusion).not.toBe("success");
      expect(conclusion).toBe("cancelled");
      const [row] = await db
        .select()
        .from(workflowRunExternalChecks)
        .where(eq(workflowRunExternalChecks.runId, `run-${category}`));
      expect(row!.conclusion).toBe(expectedIntent);
    },
  );

  it("settles a duration budget stop without asserting a verdict", () => {
    expect(pendingPrCheckIntent({ budgetMetric: "duration" })).toBe("timed_out");
  });

  it("records no verdict when the check itself could not be created", async () => {
    // The placeholder written here is the sole guard that keeps a failed
    // creation out of the decided set closeRunPrChecks honours.
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      createGateStatus: vi.fn().mockRejectedValue(new Error("GitHub is down.")),
      updateGateStatus: mockUpdateGateStatus,
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
    });
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-uncreated" });

    await expect(
      createRunOwnedPrCheck({
        db,
        owner: {
          subjectKey: "pr:github:acme/app#7",
          ownerToken: "owner-1",
          runId: "run-uncreated",
        },
        target: {
          subjectKey: "pr:github:acme/app#7",
          provider: "github",
          repoPath: "acme/app",
          prNumber: 7,
          headSha: "head",
          baseRef: "main",
        },
        nodeId: "create-check",
        attempt: 1,
        activationScope: "root",
        name: "AI Workflow / Review",
      }),
    ).rejects.toThrow("GitHub is down.");

    const [row] = await db
      .select()
      .from(workflowRunExternalChecks)
      .where(eq(workflowRunExternalChecks.runId, "run-uncreated"));
    expect(row!.closureIntent).not.toBe("failure");
    expect(row!.closureIntent).toBe("cancelled");
  });

  it("reconciles a check created after the run died without a verdict", async () => {
    mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      createGateStatus: vi
        .fn()
        .mockResolvedValue({ provider: "github", id: 21 }),
      updateGateStatus: mockUpdateGateStatus,
    });
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-reconciled" });
    await db.insert(workflowRunExternalChecks).values({
      id: "run-reconciled-check",
      runId: "run-reconciled",
      nodeId: "create-check",
      attempt: 1,
      activationScope: "root",
      subjectKey: "pr:github:acme/app#7",
      provider: "github",
      repository: "acme/app",
      prNumber: 7,
      headSha: "head",
      name: "AI Workflow / Review",
      providerReference: null,
      state: "creating",
      closureIntent: null,
    });

    // The intent is read from the pre-update snapshot, so this pass only
    // records it; the next cron pass publishes it.
    await reconcilePendingPrChecks(db);

    const [row] = await db
      .select()
      .from(workflowRunExternalChecks)
      .where(eq(workflowRunExternalChecks.runId, "run-reconciled"));
    expect(row!.state).toBe("closing");
    expect(row!.closureIntent).not.toBe("failure");
    expect(row!.closureIntent).toBe("cancelled");
  });

  it("lets a moved head outrank a verdict that never reached the provider", async () => {
    mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockImplementation(gateStatusVcs);
    const db = await pendingCheckDb("run-superseded");
    await db
      .update(workflowRunExternalChecks)
      .set({ state: "closing", closureIntent: "failure" })
      .where(eq(workflowRunExternalChecks.runId, "run-superseded"));

    await closeRunPrChecks({
      db,
      runId: "run-superseded",
      intent: "superseded",
      details: "Superseded by a newer pull request commit.",
    });

    expect(mockUpdateGateStatus).toHaveBeenCalledWith(
      { provider: "github", id: 11 },
      expect.objectContaining({ conclusion: "cancelled" }),
    );
    const [row] = await db
      .select()
      .from(workflowRunExternalChecks)
      .where(eq(workflowRunExternalChecks.runId, "run-superseded"));
    expect(row!.conclusion).toBe("superseded");
  });

  it("keeps a decided verdict when the run then fails technically", async () => {
    mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockImplementation(gateStatusVcs);
    const db = await pendingCheckDb("run-decided");
    // The review asked for changes, but publishing that verdict failed once, so
    // the row is still closing when the terminal sweep runs.
    await db
      .update(workflowRunExternalChecks)
      .set({ state: "closing", closureIntent: "failure" })
      .where(eq(workflowRunExternalChecks.runId, "run-decided"));

    await closeRunPrChecks({
      db,
      runId: "run-decided",
      intent: "cancelled",
      details: "The run failed after the review concluded.",
    });

    expect(mockUpdateGateStatus).toHaveBeenCalledWith(
      { provider: "github", id: 11 },
      expect.objectContaining({ conclusion: "failure" }),
    );
  });
});

describe("PR check verdicts", () => {
  it.each(["failure", "success"] as const)(
    "completes a %s verdict with that conclusion",
    async (conclusion) => {
      mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
      mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
      mockCreateRepositoryVCS.mockReset().mockReturnValue({
        ...gateStatusVcs(),
        getPRHead: vi
          .fn()
          .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      });
      const db = await createTestDb();
      await db.insert(workflowRuns).values({ runId: `verdict-${conclusion}` });
      await db.insert(workflowRunExternalChecks).values({
        id: `verdict-${conclusion}-check`,
        runId: `verdict-${conclusion}`,
        nodeId: "create-check",
        attempt: 1,
        activationScope: "root",
        subjectKey: "pr:github:acme/app#7",
        provider: "github",
        repository: "acme/app",
        prNumber: 7,
        headSha: "head",
        name: "AI Workflow / Review",
        providerReference: { provider: "github", id: 12 },
        state: "pending",
      });

      await completeRunOwnedPrCheck({
        db,
        owner: {
          subjectKey: "pr:github:acme/app#7",
          ownerToken: "owner-1",
          runId: `verdict-${conclusion}`,
        },
        target: {
          subjectKey: "pr:github:acme/app#7",
          provider: "github",
          repoPath: "acme/app",
          prNumber: 7,
          headSha: "head",
          baseRef: "main",
        },
        reference: {
          id: `verdict-${conclusion}-check`,
          headSha: "head",
          name: "AI Workflow / Review",
        },
        conclusion,
        details: "The review concluded.",
      });

      expect(mockUpdateGateStatus).toHaveBeenCalledWith(
        { provider: "github", id: 12 },
        expect.objectContaining({ conclusion }),
      );
    },
  );
});

describe("PR review publication scrub", () => {
  it("scrubs the review summary and inline comment bodies before publishing", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-2" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-1", commentIds: ["comment-1"] });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([
        {
          path: "src/a.ts",
          additions: 2,
          deletions: 0,
          changeType: "modified",
          patch: "@@ -3,2 +3,2 @@\n context\n+added",
        },
      ]),
      publishPRReview,
    });

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#7",
        ownerToken: "owner-2",
        runId: "run-2",
      },
      target: {
        subjectKey: "pr:github:acme/app#7",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 7,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        {
          decision: "request_changes",
          feedback:
            "The retry path is now covered. Session memory was overwritten in " +
            "`blazebot/memory/AWP-28.md`.",
          findings: [
            {
              file: "src/a.ts",
              description:
                "Reads the config twice. Noted in `blazebot/memory/AWP-28.md`.",
              severity: "Blocker",
              startLine: 3,
              endLine: 4,
            },
          ],
        },
      ],
    });

    expect(result.summary).toBe(
      "## AI Workflow review\n\n" +
        "<details><summary>Reviewer notes</summary>\n\n" +
        "- The retry path is now covered.\n\n" +
        "</details>",
    );
    const publication = publishPRReview.mock.calls[0]![1];
    expect(publication.summary).toBe(result.summary);
    const commentBody: string = publication.comments[0]!.body;
    expect(commentBody.endsWith("Reads the config twice.")).toBe(true);
    expect(commentBody).not.toContain("blazebot/memory/");
  });

  it("collapses three reviewers' prose without dropping a word of it", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-prose-merge" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-21", commentIds: [] });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([]),
      publishPRReview,
    });
    // Production run on PR 33, verbatim, minus the reviewer that reached for the
    // longest wording. A reader saw all three of these, one after another.
    const kept =
      "`findIndex()` returns `-1`, and `REFUNDS.splice(-1, 1)` removes the last " +
      "refund (`ref-3`) while the handler still reports success. This makes a bad " +
      "request mutate data.";
    const restated =
      "`findIndex()` returns `-1`, and `REFUNDS.splice(-1, 1)` removes the tail " +
      "element while the handler still returns `{ deleted: <missing id> }`, which " +
      "is silent data corruption.";
    const restatedAgain =
      "`findIndex()` returns `-1`, and `REFUNDS.splice(-1, 1)` removes the last " +
      "refund entry, so any caller can erase the final record.";

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#21",
        ownerToken: "owner-21",
        runId: "run-prose-merge",
      },
      target: {
        subjectKey: "pr:github:acme/app#21",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 21,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        {
          decision: "request_changes",
          feedback: `${kept}\n\nThe pagination guard is also off by one.`,
          findings: [],
        },
        { decision: "request_changes", feedback: restated, findings: [] },
        {
          decision: "request_changes",
          feedback: `${restatedAgain}\n\nNothing else stood out.`,
          findings: [],
        },
      ],
    });

    // Exact bytes, covering the whole section at once. Two earlier attempts tried
    // to publish only one of these three explanations, and both could delete a
    // finding nobody restated, so the repetition is now moved out of the reader's
    // way instead of removed: every reviewer's every paragraph is still here, in
    // order, each continuation indented inside its own bullet.
    expect(result.summary).toBe(
      [
        "## AI Workflow review",
        "",
        "<details><summary>Reviewer notes</summary>",
        "",
        `- ${kept}`,
        "",
        "  The pagination guard is also off by one.",
        `- ${restated}`,
        `- ${restatedAgain}`,
        "",
        "  Nothing else stood out.",
        "",
        "</details>",
      ].join("\n"),
    );
  });

  it("keeps a reviewer's every paragraph inside that reviewer's own bullet", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-prose" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-20", commentIds: [] });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([]),
      publishPRReview,
    });

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#20",
        ownerToken: "owner-20",
        runId: "run-prose",
      },
      target: {
        subjectKey: "pr:github:acme/app#20",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 20,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        {
          decision: "approve",
          feedback: "I read the diff.\n\nThe migration looks reversible.",
          findings: [],
        },
        { decision: "approve", feedback: "No security concerns.", findings: [] },
      ],
    });

    // The exact bytes, because the defect is invisible in the string and only
    // shows in the rendering: two leading spaces on the second paragraph keep it
    // inside the first bullet. Unindented, that blank line would close the list
    // and the reviewer after it would open a new one.
    expect(result.summary).toBe(
      [
        "## AI Workflow review",
        "",
        "<details><summary>Reviewer notes</summary>",
        "",
        "- I read the diff.",
        "",
        "  The migration looks reversible.",
        "- No security concerns.",
        "",
        "</details>",
      ].join("\n"),
    );
  });

  // The gate reads the merged findings, not the reviewers' own decisions: a
  // Blocker always holds the review back, and a High does so only once
  // min(2, reviewerCount) reviewers reported it independently. Collapsing two
  // reports into one comment therefore must not soften the verdict either.
  // This fixture agrees with the rule it replaced, so on its own it discriminates
  // nothing; the two tests after it are the ones that separate the old gate from
  // the new one, from either side.
  it("requests changes on a High that two reviewers reported independently", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-merge" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-9", commentIds: ["comment-9"] });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([
        {
          path: "src/a.ts",
          additions: 2,
          deletions: 0,
          changeType: "modified",
          patch: "@@ -3,2 +3,2 @@\n context\n+added",
        },
      ]),
      publishPRReview,
    });

    const finding = (description: string) => ({
      file: "src/a.ts",
      description,
      severity: "High" as const,
      startLine: 4,
      endLine: 4,
    });

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#9",
        ownerToken: "owner-9",
        runId: "run-merge",
      },
      target: {
        subjectKey: "pr:github:acme/app#9",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 9,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        { decision: "approve", findings: [finding("One reviewer worded it this way.")] },
        {
          decision: "request_changes",
          findings: [finding("Another worded the same defect differently.")],
        },
      ],
    });

    expect(result.decision).toBe("request_changes");
    expect(result.inlineCommentCount).toBe(1);
    expect(publishPRReview.mock.calls[0]![1].comments).toHaveLength(1);
    expect(publishPRReview.mock.calls[0]![1].comments[0]!.body).toContain(
      "Reported by 2 of 2 reviewers.",
    );
    // Two reports collapsing into one defect is the most common shape this line
    // reports, and it read "1 distinct findings" on a real client pull request.
    expect(result.summary).toContain("1 distinct finding merged from 2");
    expect(result.summary).not.toContain("1 distinct findings");
  });

  // The regression the new rule exists for. One reviewer's High used to fail the
  // check on its own, which made a green check nearly unreachable on real code.
  it("approves a High only one of two reviewers reported, and still publishes it", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-lone-high" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-10", commentIds: ["comment-10"] });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([
        {
          path: "src/a.ts",
          additions: 2,
          deletions: 0,
          changeType: "modified",
          patch: "@@ -3,2 +3,2 @@\n context\n+added",
        },
      ]),
      publishPRReview,
    });

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#10",
        ownerToken: "owner-10",
        runId: "run-lone-high",
      },
      target: {
        subjectKey: "pr:github:acme/app#10",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 10,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        {
          // The reviewer's own verdict is unchanged and still says this.
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Only this reviewer saw a problem here.",
              severity: "High",
              startLine: 4,
              endLine: 4,
            },
          ],
        },
        { decision: "approve", findings: [] },
      ],
    });

    expect(result.decision).toBe("approve");
    // Approving is not the same as hiding: the finding is still published, it
    // just no longer decides the check on its own.
    expect(result.inlineCommentCount).toBe(1);
    expect(publishPRReview.mock.calls[0]![1].decision).toBe("approve");
    expect(publishPRReview.mock.calls[0]![1].comments[0]!.body).toBe(
      "**High**: Only this reviewer saw a problem here.\n\n" +
        "Reported by 1 of 2 reviewers. A High blocks only when 2 reviewers report it independently.",
    );
  });

  it("blocks a lone High when the graph has a single reviewer", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-single-reviewer" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-11", commentIds: ["comment-11"] });
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([
        {
          path: "src/a.ts",
          additions: 2,
          deletions: 0,
          changeType: "modified",
          patch: "@@ -3,2 +3,2 @@\n context\n+added",
        },
      ]),
      publishPRReview,
    });

    const result = await publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: "pr:github:acme/app#11",
        ownerToken: "owner-11",
        runId: "run-single-reviewer",
      },
      target: {
        subjectKey: "pr:github:acme/app#11",
        provider: "github",
        repoPath: "acme/app",
        prNumber: 11,
        headSha: "head",
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: [
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "The only reviewer there is reported this.",
              severity: "High",
              startLine: 4,
              endLine: 4,
            },
          ],
        },
      ],
    });

    // min(2, 1) is 1, so agreement cannot be demanded from a graph that has
    // nobody to agree with. A client running one reviewer keeps today's gate.
    expect(result.decision).toBe("request_changes");
  });
});

describe("PR review publication idempotency", () => {
  function reviewVcs(publishPRReview: ReturnType<typeof vi.fn>) {
    mockAssertActiveRunOwner.mockReset().mockResolvedValue(undefined);
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([
        {
          path: "src/a.ts",
          additions: 2,
          deletions: 0,
          changeType: "modified",
          patch: "@@ -3,2 +3,2 @@\n context\n+added",
        },
      ]),
      publishPRReview,
    });
  }

  function publish(
    db: Awaited<ReturnType<typeof createTestDb>>,
    args: {
      runId: string;
      prNumber: number;
      headSha: string;
      reviewResults: ReviewResult[];
    },
  ) {
    return publishRunOwnedPrReview({
      db,
      owner: {
        subjectKey: `pr:github:acme/app#${args.prNumber}`,
        ownerToken: "owner-idem",
        runId: args.runId,
      },
      target: {
        subjectKey: `pr:github:acme/app#${args.prNumber}`,
        provider: "github",
        repoPath: "acme/app",
        prNumber: args.prNumber,
        headSha: args.headSha,
        baseRef: "main",
      },
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      reviewResults: args.reviewResults,
    });
  }

  // Nothing else in this file exercises the idempotency decision, and it is the
  // whole defence against a pull request collecting a second full review: the
  // database probe short-circuits a round that already published, and the marker
  // the adapters search for is the backstop when it cannot.
  it("publishes one review per head and then reports what the pull request carries", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-idem" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-12", commentIds: ["comment-12"] });
    reviewVcs(publishPRReview);

    const first = await publish(db, {
      runId: "run-idem",
      prNumber: 12,
      headSha: "head",
      reviewResults: [
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Reads the config twice.",
              severity: "Blocker",
              startLine: 4,
              endLine: 4,
            },
          ],
        },
      ],
    });
    // A second run over the same commit whose reviewer reworded the finding and
    // reached the opposite verdict: the two things that used to re-key the
    // publication and walk it straight into the adapter's early return.
    const second = await publish(db, {
      runId: "run-idem",
      prNumber: 12,
      headSha: "head",
      reviewResults: [
        {
          decision: "approve",
          findings: [
            {
              file: "src/a.ts",
              description: "The configuration is read a second time.",
              severity: "Nit",
              startLine: 4,
              endLine: 4,
            },
          ],
        },
      ],
    });

    expect(publishPRReview).toHaveBeenCalledTimes(1);
    // The published verdict and prose, not the second round's: the check run
    // text and the Branch both read this, so they describe the review a reader
    // can actually open.
    expect(second).toEqual(first);
    expect(second.decision).toBe("request_changes");
    // One row and one comment reference for the round. A second row would claim
    // a publication that never happened, and a second comment reference would
    // attribute this round's comment to the earlier round's discussion.
    const rows = await db.select().from(workflowPrReviewPublications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("published");
    const commentRows = await db
      .select()
      .from(workflowPrReviewPublicationComments);
    expect(commentRows).toHaveLength(1);
    expect(commentRows[0]!.providerReference).toBe("comment-12");
  });

  it("resumes a failed publication on the row it already created", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-resume" });
    const reviewResults: ReviewResult[] = [
      { decision: "approve", feedback: "Looks good.", findings: [] },
    ];
    const failing = vi.fn().mockRejectedValue(new Error("GitHub said no."));
    reviewVcs(failing);
    await expect(
      publish(db, {
        runId: "run-resume",
        prNumber: 16,
        headSha: "head",
        reviewResults,
      }),
    ).rejects.toThrow(/PR review publication failed/);

    const retry = vi
      .fn()
      .mockResolvedValue({ id: "review-16", commentIds: [] });
    reviewVcs(retry);
    await publish(db, {
      runId: "run-resume",
      prNumber: 16,
      headSha: "head",
      reviewResults,
    });

    // A round nobody managed to publish is not a published round: the retry must
    // still reach the provider, and it must do so on the pending row rather than
    // leaving an orphan behind.
    expect(retry).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(workflowPrReviewPublications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("published");
    expect(rows[0]!.lastError).toBeNull();
  });

  // The only path that legitimately reaches the adapter twice at one head, and
  // therefore the only place the round-stability of the key is observable. It is
  // also the exact window where that key is the sole defence against AIW-234:
  // nothing on record says a review was published, so a content-derived key would
  // write a second marker and post a second review beside the first.
  it("hands both attempts at one head the same key when the prose changes", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-round-key" });
    const reported = (description: string): ReviewResult => ({
      decision: "request_changes",
      findings: [
        {
          file: "src/a.ts",
          description,
          severity: "Blocker",
          startLine: 4,
          endLine: 4,
        },
      ],
    });
    const failing = vi.fn().mockRejectedValue(new Error("GitHub said no."));
    reviewVcs(failing);
    await expect(
      publish(db, {
        runId: "run-round-key",
        prNumber: 18,
        headSha: "head",
        reviewResults: [reported("Reads the config twice.")],
      }),
    ).rejects.toThrow(/PR review publication failed/);

    const retry = vi
      .fn()
      .mockResolvedValue({ id: "review-18", commentIds: ["comment-18"] });
    reviewVcs(retry);
    await publish(db, {
      runId: "run-round-key",
      prNumber: 18,
      headSha: "head",
      reviewResults: [reported("The configuration is read a second time.")],
    });

    // Two rows with two different content hashes, which is what makes the next
    // assertion mean something: the review content demonstrably moved between the
    // two calls, and the key the provider is keyed by demonstrably did not.
    const rows = await db.select().from(workflowPrReviewPublications);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.contentHash)).size).toBe(2);
    expect(retry.mock.calls[0]![1].idempotencyKey).toBe(
      failing.mock.calls[0]![1].idempotencyKey,
    );
  });

  it("hands the adapter the keys earlier attempts marked a review with", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-prior-key" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-17", commentIds: [] });
    reviewVcs(publishPRReview);
    // A publication from before the key became a round identity, whose state
    // update was lost: the review is on the pull request under a marker carrying
    // this content hash, and nothing in the database says so.
    await db.insert(workflowPrReviewPublications).values({
      id: "publication-legacy",
      runId: "run-prior-key",
      nodeId: "post-review",
      attempt: 1,
      activationScope: "root",
      provider: "github",
      repository: "acme/app",
      prNumber: 17,
      headSha: "head",
      contentHash: "legacy-content-hash",
      decision: "request_changes",
      summary: "## AI Workflow review",
    });

    await publish(db, {
      runId: "run-prior-key",
      prNumber: 17,
      headSha: "head",
      reviewResults: [{ decision: "approve", findings: [] }],
    });

    // Recognised, never written: the adapter can find that marker, so the review
    // already on the pull request is not duplicated, while the marker this call
    // writes is the round key alone.
    const publication = publishPRReview.mock.calls[0]![1];
    expect(publication.priorIdempotencyKeys).toEqual(["legacy-content-hash"]);
    expect(publication.idempotencyKey).not.toBe("legacy-content-hash");
  });

  it("re-keys the marker once the head commit moves", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-idem-head" });
    const reviewResults: ReviewResult[] = [
      { decision: "approve", findings: [] },
    ];
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-13", commentIds: [] });
    reviewVcs(publishPRReview);
    await publish(db, {
      runId: "run-idem-head",
      prNumber: 13,
      headSha: "head",
      reviewResults,
    });

    const nextPublish = vi
      .fn()
      .mockResolvedValue({ id: "review-14", commentIds: [] });
    mockCreateRepositoryVCS.mockReset().mockReturnValue({
      getPRHead: vi
        .fn()
        .mockResolvedValue({ headSha: "head-2", state: "open", baseRef: "main" }),
      listPRFiles: vi.fn().mockResolvedValue([]),
      publishPRReview: nextPublish,
    });
    await publish(db, {
      runId: "run-idem-head",
      prNumber: 13,
      headSha: "head-2",
      reviewResults,
    });

    // A new commit is a new round and must get its own review, so the key has to
    // move here even though nothing the reviewer said changed.
    expect(nextPublish.mock.calls[0]![1].idempotencyKey).not.toBe(
      publishPRReview.mock.calls[0]![1].idempotencyKey,
    );
  });

  it("publishes once when the same review is replayed", async () => {
    const db = await createTestDb();
    await db.insert(workflowRuns).values({ runId: "run-replay" });
    const publishPRReview = vi
      .fn()
      .mockResolvedValue({ id: "review-15", commentIds: [] });
    reviewVcs(publishPRReview);
    const reviewResults: ReviewResult[] = [
      { decision: "approve", feedback: "Looks good.", findings: [] },
    ];

    await publish(db, {
      runId: "run-replay",
      prNumber: 15,
      headSha: "head",
      reviewResults,
    });
    await publish(db, {
      runId: "run-replay",
      prNumber: 15,
      headSha: "head",
      reviewResults,
    });

    // The published round short-circuits, so the provider is never asked a second
    // time and the replay costs one select.
    expect(publishPRReview).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(workflowPrReviewPublications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("published");
  });
});
