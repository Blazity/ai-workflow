import { describe, expect, it, vi } from "vitest";
import type { ReviewResult } from "@shared/contracts";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.js";
import {
  workflowRunExternalChecks,
  workflowRuns,
} from "../db/schema.js";
import { pendingPrCheckIntent } from "./agent.js";
import {
  changedNewSideLines,
  closeRunPrChecks,
  completeRunOwnedPrCheck,
  createRunOwnedPrCheck,
  partitionReviewFindings,
  publishRunOwnedPrReview,
  reconcilePendingPrChecks,
  reviewCommentContentHash,
} from "./pr-external-resources.js";

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
});

describe("PR check reconciliation", () => {
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
      "## AI Workflow review\n\n- The retry path is now covered.",
    );
    const publication = publishPRReview.mock.calls[0]![1];
    expect(publication.summary).toBe(result.summary);
    const commentBody: string = publication.comments[0]!.body;
    expect(commentBody.endsWith("Reads the config twice.")).toBe(true);
    expect(commentBody).not.toContain("blazebot/memory/");
  });
});
