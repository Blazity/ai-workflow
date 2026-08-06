import { describe, expect, it } from "vitest";
import type { ReviewResultFinding } from "@shared/contracts";
import {
  highFindingBlockingAgreement,
  MAX_PUBLISHED_INLINE_REVIEW_COMMENTS,
  mergeReviewFindings,
  mergedReviewFindingCommentBody,
  reviewDescriptionSimilarity,
  type ReviewFindingCandidate,
} from "./review-finding-merge.js";

function candidate(
  reviewerIndex: number,
  findingIndex: number,
  finding: ReviewResultFinding,
  anchored = true,
): ReviewFindingCandidate {
  return {
    reviewerIndex,
    findingIndex,
    finding,
    groupKey: finding.file,
    anchor: anchored && typeof finding.startLine === "number"
      ? {
          path: finding.file,
          startLine: finding.startLine,
          endLine: finding.endLine ?? finding.startLine,
          startOldLine: null,
          endOldLine: null,
        }
      : null,
  };
}

/**
 * The real findings of production run wrun_...4N9DD3: three reviewers, three
 * findings each, six distinct defects. `refunds:50` was reported by all three
 * and `payments:40` by two, both at an identical start line.
 */
const PRODUCTION_RUN: ReviewFindingCandidate[] = [
  candidate(0, 0, {
    file: "app/api/refunds/route.ts",
    startLine: 50,
    severity: "High",
    description:
      "DELETE mutates refunds without any authorization check, and an unknown id deletes the last record because findIndex returns -1.",
  }),
  candidate(0, 1, {
    file: "app/api/refunds/route.ts",
    startLine: 29,
    severity: "High",
    description:
      "GET treats customerId as optional and uses substring matching, so an empty value returns every customer's refunds.",
  }),
  candidate(0, 2, {
    file: "app/api/invoices/route.ts",
    startLine: 15,
    severity: "Medium",
    description:
      "Each public invoices request synchronously fans out to the configured upstream with retries and no timeout.",
  }),
  candidate(1, 0, {
    file: "app/api/payments/route.ts",
    startLine: 40,
    severity: "High",
    description:
      "Pagination uses page * perPage as the slice start, so page 1 skips the first page of results entirely.",
  }),
  candidate(1, 1, {
    file: "app/api/refunds/route.ts",
    startLine: 50,
    severity: "High",
    description:
      "DELETE removes the last refund when the requested id is not found, because splice(-1, 1) drops the final element.",
  }),
  candidate(1, 2, {
    file: "app/api/refunds/route.ts",
    startLine: 32,
    severity: "Medium",
    description:
      "The response mixes substring filtering for items with exact-match aggregation for the total, so the two disagree.",
  }),
  candidate(2, 0, {
    file: "app/api/refunds/route.ts",
    startLine: 50,
    severity: "High",
    description:
      "Deleting a refund is unauthenticated, which the acceptance criteria forbid for finance endpoints.",
  }),
  candidate(2, 1, {
    file: "app/api/payments/route.ts",
    startLine: 40,
    severity: "High",
    description:
      "Pagination is off by one. The slice start is computed as page * perPage, so page 1 starts at index perPage.",
  }),
  candidate(2, 2, {
    file: "app/api/refunds/route.ts",
    startLine: 19,
    severity: "Medium",
    description:
      "GET returns inconsistent totals for partial or case-insensitive customer filters.",
  }),
];

describe("mergeReviewFindings", () => {
  it("collapses the production run's nine findings into six defects", () => {
    const merged = mergeReviewFindings(PRODUCTION_RUN);

    expect(merged).toHaveLength(6);

    const refundsDelete = merged.find(
      (f) => f.file === "app/api/refunds/route.ts" && f.startLine === 50,
    );
    expect(refundsDelete?.sources.map((s) => s.reviewerIndex)).toEqual([0, 1, 2]);

    const pagination = merged.find(
      (f) => f.file === "app/api/payments/route.ts" && f.startLine === 40,
    );
    expect(pagination?.sources.map((s) => s.reviewerIndex)).toEqual([1, 2]);
  });

  it("merges a one-line disagreement when the wording agrees", () => {
    const merged = mergeReviewFindings([
      candidate(0, 0, {
        file: "a.ts",
        startLine: 40,
        severity: "High",
        description:
          "Pagination slice start is page multiplied by perPage, so page one skips the first page of rows.",
      }),
      candidate(1, 0, {
        file: "a.ts",
        startLine: 41,
        severity: "High",
        description:
          "Pagination start offset multiplies page by perPage, so page one skips the first rows of the page.",
      }),
    ]);

    expect(merged).toHaveLength(1);
  });

  // The reason the line window is not the only gate. These two defects really
  // sat four lines apart in one function on the reviewed pull request.
  it("keeps two different defects a few lines apart apart", () => {
    const pagination: ReviewResultFinding = {
      file: "a.ts",
      startLine: 40,
      severity: "High",
      description:
        "Pagination slice start is page multiplied by perPage, so page one skips the first page of rows.",
    };
    const floatMoney: ReviewResultFinding = {
      file: "a.ts",
      startLine: 45,
      severity: "High",
      description:
        "Monetary totals accumulate amountMinor divided by 100 in a float, which loses cents on large sums.",
    };

    expect(
      mergeReviewFindings([candidate(0, 0, pagination), candidate(1, 0, floatMoney)]),
    ).toHaveLength(2);

    // Adjacent as well: only the wording gate can separate them here, so this
    // is the assertion that fails if someone deletes it as redundant.
    expect(
      mergeReviewFindings([
        candidate(0, 0, pagination),
        candidate(1, 0, { ...floatMoney, startLine: 41 }),
      ]),
    ).toHaveLength(2);
  });

  it("never collapses one reviewer's own two findings", () => {
    const merged = mergeReviewFindings([
      candidate(0, 0, {
        file: "a.ts",
        startLine: 50,
        severity: "Blocker",
        description: "Unauthenticated delete removes arbitrary refunds.",
      }),
      candidate(0, 1, {
        file: "a.ts",
        startLine: 50,
        severity: "Nit",
        description: "Unauthenticated delete removes arbitrary refunds.",
      }),
    ]);

    expect(merged).toHaveLength(2);
  });

  it("does not chain a whole file into one cluster", () => {
    const wording = (line: number) => ({
      file: "a.ts",
      startLine: line,
      severity: "Medium" as const,
      description:
        "The query parameter is parsed without an upper bound, so a caller can request an unbounded page.",
    });
    const merged = mergeReviewFindings([
      candidate(0, 0, wording(40)),
      candidate(1, 0, wording(42)),
      candidate(2, 0, wording(44)),
    ]);

    // 42 merges into 40, but 44 is compared against the primary at 40, not
    // against 42, so it stays on its own.
    expect(merged).toHaveLength(2);
    expect(merged[0]?.sources).toHaveLength(2);
    expect(merged[1]?.sources).toHaveLength(1);
  });

  // Two reviewers grading one defect differently, which is what the same-line
  // severity rule exists for. The descriptions have to agree, because on an
  // exact line match a graded disagreement is the only case where wording is
  // the deciding evidence.
  it("takes the highest severity and its wording as the cluster's own", () => {
    const merged = mergeReviewFindings([
      candidate(0, 0, {
        file: "a.ts",
        startLine: 10,
        severity: "Nit",
        description:
          "The delete handler splices by an index that findIndex may report as minus one.",
      }),
      candidate(1, 0, {
        file: "a.ts",
        startLine: 10,
        severity: "Blocker",
        description:
          "The delete handler splices by minus one when findIndex finds no record, dropping the last row.",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.severity).toBe("Blocker");
    expect(merged[0]?.description).toContain("dropping the last row");
  });

  it("keeps two unrelated findings on one line apart despite the shared line", () => {
    const merged = mergeReviewFindings([
      candidate(0, 0, {
        file: "a.ts",
        startLine: 10,
        severity: "Nit",
        description: "Consider renaming this helper for readability.",
      }),
      candidate(1, 0, {
        file: "a.ts",
        startLine: 10,
        severity: "Blocker",
        description: "This helper deletes the wrong record for an unknown id.",
      }),
    ]);

    expect(merged).toHaveLength(2);
  });

  it("never merges a file-level finding with a line-level one", () => {
    const merged = mergeReviewFindings([
      candidate(0, 0, {
        file: "a.ts",
        severity: "Medium",
        description: "This module has no tests covering the pagination helper.",
      }),
      candidate(1, 0, {
        file: "a.ts",
        startLine: 40,
        severity: "Medium",
        description: "This module has no tests covering the pagination helper.",
      }),
    ]);

    expect(merged).toHaveLength(2);
  });

  it("publishes a cluster inline when any reviewer could place it", () => {
    const merged = mergeReviewFindings([
      candidate(
        0,
        0,
        {
          file: "a.ts",
          startLine: 50,
          severity: "High",
          description: "Unauthenticated delete removes arbitrary refunds.",
        },
        false,
      ),
      candidate(1, 0, {
        file: "a.ts",
        startLine: 50,
        severity: "High",
        description: "Deleting a refund requires no credentials at all.",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.anchor).not.toBeNull();
  });

  it("produces the same clusters whatever order the reviewers finish in", () => {
    const shape = (list: ReviewFindingCandidate[]) =>
      mergeReviewFindings(list)
        .map((f) => `${f.file}:${f.startLine ?? "-"}:${f.sources.length}`)
        .sort();

    const rotated = [...PRODUCTION_RUN.slice(3), ...PRODUCTION_RUN.slice(0, 3)];

    expect(shape(rotated)).toEqual(shape(PRODUCTION_RUN));
  });
});

describe("merged review comment body", () => {
  it("leaves a single reviewer's comment byte for byte as before", () => {
    const [single] = mergeReviewFindings([
      candidate(0, 0, {
        file: "a.ts",
        startLine: 7,
        severity: "Blocker",
        description: "The refund amount is parsed with parseFloat.",
      }),
    ]);

    expect(mergedReviewFindingCommentBody(single!, 3, true)).toBe(
      "**Blocker**: The refund amount is parsed with parseFloat.",
    );
  });

  it("states the blocking rule when a High stood alone", () => {
    const [alone] = mergeReviewFindings([
      candidate(0, 0, {
        file: "a.ts",
        startLine: 7,
        severity: "High",
        description: "A failed job is retried without any backoff.",
      }),
    ]);

    // A green check that says "No blocking findings on this commit." next to an
    // unqualified **High** reads as a contradiction, so the comment states which
    // kind of High this is.
    expect(mergedReviewFindingCommentBody(alone!, 3, false)).toBe(
      "**High**: A failed job is retried without any backoff.\n\n" +
        "Reported by 1 of 3 reviewers. A High blocks only when 2 reviewers report it independently.",
    );
    // The threshold in that sentence is the one the gate enforces, not a numeral
    // written beside it: `highFindingBlockingAgreement` is the only place the
    // number exists, so raising it cannot leave the published text behind.
    expect(mergedReviewFindingCommentBody(alone!, 3, false)).toContain(
      `only when ${highFindingBlockingAgreement(3)} reviewers`,
    );
    // The same finding in a single-reviewer graph blocks, so it keeps the
    // pre-merge bytes. This is the Arthur definition's shape.
    expect(mergedReviewFindingCommentBody(alone!, 1, true)).toBe(
      "**High**: A failed job is retried without any backoff.",
    );
  });

  it("states the agreement when several reviewers found the same defect", () => {
    const merged = mergeReviewFindings(PRODUCTION_RUN);
    const refundsDelete = merged.find((f) => f.startLine === 50)!;

    const body = mergedReviewFindingCommentBody(refundsDelete, 3, true);

    expect(body).toContain("Reported by 3 of 3 reviewers.");
    // The first line stays self-contained: GitHub's inline fallback renders each
    // body as one markdown bullet, and a leading newline would break the list.
    expect(body.split("\n")[0]).toContain("**High**:");
  });
});

describe("reviewDescriptionSimilarity", () => {
  it("scores shared content words and ignores boilerplate", () => {
    expect(
      reviewDescriptionSimilarity(
        "Pagination slice start multiplies page by perPage",
        "Pagination start offset multiplies page by perPage",
      ),
    ).toBeGreaterThan(REVIEW_FINDING_MERGE_NEARBY);
    expect(
      reviewDescriptionSimilarity(
        "Pagination slice start multiplies page by perPage",
        "Monetary totals accumulate in a float and lose cents",
      ),
    ).toBeLessThan(REVIEW_FINDING_MERGE_NEARBY);
  });

  it("splits camelCase so an identifier matches its words", () => {
    expect(
      reviewDescriptionSimilarity("parseFloat drops cents", "parse float drops cents"),
    ).toBe(1);
  });

  it("scores nothing when a description carries no meaningful token", () => {
    expect(reviewDescriptionSimilarity("", "anything at all here")).toBe(0);
  });
});

const REVIEW_FINDING_MERGE_NEARBY = 0.4;

describe("published comment cap", () => {
  it("caps the whole review rather than each reviewer", () => {
    expect(MAX_PUBLISHED_INLINE_REVIEW_COMMENTS).toBe(10);
  });
});
