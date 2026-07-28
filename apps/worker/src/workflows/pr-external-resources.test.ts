import { describe, expect, it, vi } from "vitest";
import type { ReviewResult } from "@shared/contracts";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.js";
import {
  workflowRunExternalChecks,
  workflowRuns,
} from "../db/schema.js";
import {
  changedNewSideLines,
  partitionReviewFindings,
  reconcilePendingPrChecks,
  reviewCommentContentHash,
} from "./pr-external-resources.js";

const { mockUpdateGateStatus } = vi.hoisted(() => ({
  mockUpdateGateStatus: vi.fn(),
}));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: vi.fn(() => ({
    createGateStatus: vi.fn(),
    updateGateStatus: mockUpdateGateStatus,
  })),
}));

describe("PR review diff placement", () => {
  it("tracks only lines that exist on the reviewed side of each hunk", () => {
    expect(
      [...changedNewSideLines(
        "@@ -2,3 +2,4 @@\n context\n-removed\n+added\n next\n+last",
      )],
    ).toEqual([2, 3, 4, 5]);
  });

  it("places only complete safe ranges inline and falls back otherwise", () => {
    const results: ReviewResult[] = [
      {
        decision: "request_changes",
        findings: [
          {
            file: "src/a.ts",
            description: "Inline",
            severity: "critical",
            startLine: 3,
            endLine: 4,
          },
          {
            file: "src/a.ts",
            description: "Outside the patch",
            severity: "suggestion",
            startLine: 10,
          },
          {
            file: "../secret",
            description: "Unsafe path",
            severity: "critical",
            startLine: 3,
          },
          {
            file: "src/a.ts",
            description: "Unbounded range",
            severity: "critical",
            startLine: 1,
            endLine: Number.MAX_SAFE_INTEGER,
          },
          {
            file: "src/a.ts",
            description: "Inverted range",
            severity: "critical",
            startLine: 4,
            endLine: 3,
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
        body: "**critical** — Inline",
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
    ]);
  });

  it("preserves legitimate a/ and b/ repository paths", () => {
    const results: ReviewResult[] = [
      {
        decision: "request_changes",
        findings: [
          {
            file: "a/index.ts",
            description: "Legitimate path",
            severity: "critical",
            startLine: 1,
          },
          {
            file: "b/src/index.ts",
            description: "Diff-prefixed path",
            severity: "suggestion",
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
});

describe("PR check reconciliation", () => {
  it("closes each check with its own stored conclusion", async () => {
    mockUpdateGateStatus.mockReset().mockResolvedValue(undefined);
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
