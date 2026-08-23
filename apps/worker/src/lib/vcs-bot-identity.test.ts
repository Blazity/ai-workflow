import { describe, expect, it } from "vitest";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  hasAiWorkflowCommentMarker,
  hasReviewLedgerFailureMarker,
  isReopenedLedgerThread,
  isReviewLedgerNote,
  markReviewLedgerReplyResolved,
  markReviewLedgerReplyStale,
  normalizeVcsLogin,
  readAnyReviewLedgerMarker,
  readReviewLedgerMarker,
  resolveVcsBotLogin,
  reviewLedgerFailureMarker,
  reviewLedgerMarker,
  vcsLoginsMatch,
} from "./vcs-bot-identity.js";

describe("resolveVcsBotLogin", () => {
  it("trims and case-normalizes a provider-specific login", () => {
    expect(
      resolveVcsBotLogin("github", ["github"], {
        github: "  GitHub-App[Bot]  ",
      }),
    ).toBe("github-app");
  });

  it("treats whitespace-only values as unset and falls back only when unambiguous", () => {
    expect(
      resolveVcsBotLogin("gitlab", ["gitlab"], {
        gitlab: "   ",
        legacy: "  Legacy-Bot  ",
      }),
    ).toBe("legacy-bot");
    expect(
      resolveVcsBotLogin("github", ["github"], {
        github: "   ",
        legacy: "   ",
      }),
    ).toBeUndefined();
  });
});

describe("normalizeVcsLogin", () => {
  it("strips a single trailing [bot] suffix after lowercasing", () => {
    expect(normalizeVcsLogin("Blazebot[bot]")).toBe("blazebot");
    expect(normalizeVcsLogin("BlazeBot[Bot]")).toBe("blazebot");
  });

  it("strips only one trailing [bot] suffix", () => {
    expect(normalizeVcsLogin("x[bot][bot]")).toBe("x[bot]");
  });

  it("does not strip a [bot] token that is not a trailing suffix", () => {
    expect(normalizeVcsLogin("[bot]x")).toBe("[bot]x");
  });

  it("returns undefined for a bare [bot] input", () => {
    expect(normalizeVcsLogin("[bot]")).toBeUndefined();
  });

  it("returns undefined for empty, whitespace and null-ish input", () => {
    expect(normalizeVcsLogin("")).toBeUndefined();
    expect(normalizeVcsLogin("   ")).toBeUndefined();
    expect(normalizeVcsLogin(null)).toBeUndefined();
    expect(normalizeVcsLogin(undefined)).toBeUndefined();
  });
});

describe("vcsLoginsMatch", () => {
  it("matches when the actual login carries a [bot] suffix but the configured one does not", () => {
    expect(vcsLoginsMatch("blazebot[bot]", "blazebot")).toBe(true);
  });

  it("matches when the configured login carries a [bot] suffix but the actual one does not", () => {
    expect(vcsLoginsMatch("blazebot", "blazebot[bot]")).toBe(true);
  });

  it("matches case-insensitively across the [bot] suffix", () => {
    expect(vcsLoginsMatch("BlazeBot[Bot]", "blazebot")).toBe(true);
  });

  it("does not match a bare [bot] against a bare [bot]", () => {
    expect(vcsLoginsMatch("[bot]", "[bot]")).toBe(false);
  });

  it("does not match unrelated logins", () => {
    expect(vcsLoginsMatch("alice", "bob")).toBe(false);
    expect(vcsLoginsMatch("alice[bot]", "bob")).toBe(false);
  });

  it("returns false when either side is undefined", () => {
    expect(vcsLoginsMatch(undefined, "blazebot")).toBe(false);
    expect(vcsLoginsMatch("blazebot", null)).toBe(false);
  });
});

describe("hasAiWorkflowCommentMarker", () => {
  it("returns true when the body contains the marker", () => {
    expect(
      hasAiWorkflowCommentMarker(`Some review feedback\n${AI_WORKFLOW_COMMENT_MARKER}`),
    ).toBe(true);
  });

  it("returns false when the body does not contain the marker", () => {
    expect(hasAiWorkflowCommentMarker("Some review feedback")).toBe(false);
  });

  it("returns false for null and undefined bodies", () => {
    expect(hasAiWorkflowCommentMarker(null)).toBe(false);
    expect(hasAiWorkflowCommentMarker(undefined)).toBe(false);
  });
});

describe("reviewLedgerMarker", () => {
  it("returns the exact marker string for a thread id", () => {
    expect(reviewLedgerMarker("x")).toBe(
      "<!-- ai-workflow:ledger:x --> <!-- ai-workflow:bot -->",
    );
  });

  it("satisfies hasAiWorkflowCommentMarker", () => {
    expect(hasAiWorkflowCommentMarker(reviewLedgerMarker("x"))).toBe(true);
  });
});

describe("readReviewLedgerMarker", () => {
  it("round-trips the thread id written by reviewLedgerMarker", () => {
    expect(readReviewLedgerMarker(reviewLedgerMarker("thread-123"))).toBe("thread-123");
  });

  it("returns null for plain text with no marker", () => {
    expect(readReviewLedgerMarker("Some review feedback")).toBeNull();
  });
});

describe("readAnyReviewLedgerMarker", () => {
  it("reads the thread id out of all three reply variants", () => {
    expect(readAnyReviewLedgerMarker(reviewLedgerMarker("t-1"))).toBe("t-1");
    expect(
      readAnyReviewLedgerMarker(markReviewLedgerReplyStale("answered.", "t-1")),
    ).toBe("t-1");
    expect(
      readAnyReviewLedgerMarker(markReviewLedgerReplyResolved("answered.", "t-1")),
    ).toBe("t-1");
  });
});

describe("markReviewLedgerReplyResolved", () => {
  it("swaps the plain marker for the resolved one and keeps the bot marker", () => {
    const body = `Renamed.\n\n${reviewLedgerMarker("t-1")}`;
    expect(markReviewLedgerReplyResolved(body, "t-1")).toBe(
      `Renamed.\n\n<!-- ai-workflow:ledger-resolved:t-1 --> ${AI_WORKFLOW_COMMENT_MARKER}`,
    );
  });

  // The resolved variant deliberately fails readReviewLedgerMarker: that reader is
  // "does this park the thread on a human", and a reopened thread must not park.
  it("does not read as a parking reply", () => {
    expect(readReviewLedgerMarker(markReviewLedgerReplyResolved("Renamed.", "t-1"))).toBeNull();
  });
});

describe("isReviewLedgerNote", () => {
  it("recognises every note this workflow writes into a thread", () => {
    expect(isReviewLedgerNote(reviewLedgerMarker("t-1"))).toBe(true);
    expect(isReviewLedgerNote(markReviewLedgerReplyStale("x", "t-1"))).toBe(true);
    expect(isReviewLedgerNote(markReviewLedgerReplyResolved("x", "t-1"))).toBe(true);
    // The one readAnyReviewLedgerMarker cannot answer for: it is keyed by run id,
    // so an id comparison against a thread never matches.
    expect(isReviewLedgerNote(reviewLedgerFailureMarker("wrun_1"))).toBe(true);
  });

  it("returns false for review feedback", () => {
    expect(isReviewLedgerNote("please rename this symbol")).toBe(false);
  });
});

describe("isReopenedLedgerThread", () => {
  const ours = { author: "aiw-bot", body: reviewLedgerMarker("t-1"), createdAt: "2026-08-21T10:05:00Z" };
  const isOurs = (note: { author: string }) => note.author === "aiw-bot";

  it("is true when a person speaks after our marked reply", () => {
    expect(
      isReopenedLedgerThread(
        [
          { author: "reviewer", body: "why?", createdAt: "2026-08-21T10:00:00Z" },
          ours,
          { author: "reviewer", body: "not good enough", createdAt: "2026-08-21T10:30:00Z" },
        ],
        isOurs,
      ),
    ).toBe(true);
  });

  it("is false while our reply is the last note", () => {
    expect(
      isReopenedLedgerThread(
        [{ author: "reviewer", body: "why?", createdAt: "2026-08-21T10:00:00Z" }, ours],
        isOurs,
      ),
    ).toBe(false);
  });

  // A marker is text. Someone quoting our reply has not made it ours.
  it("is false when the only marked note is not ours", () => {
    expect(
      isReopenedLedgerThread(
        [
          { author: "reviewer", body: `> ${reviewLedgerMarker("t-1")}`, createdAt: "2026-08-21T10:05:00Z" },
          { author: "reviewer", body: "and another thing", createdAt: "2026-08-21T10:30:00Z" },
        ],
        isOurs,
      ),
    ).toBe(false);
  });
});

describe("reviewLedgerFailureMarker / hasReviewLedgerFailureMarker", () => {
  it("returns the exact failure marker string for a run id", () => {
    expect(reviewLedgerFailureMarker("run-1")).toBe(
      "<!-- ai-workflow:ledger-failure:run-1 --> <!-- ai-workflow:bot -->",
    );
  });

  it("detects the failure marker for the matching run id", () => {
    expect(hasReviewLedgerFailureMarker(reviewLedgerFailureMarker("run-1"), "run-1")).toBe(true);
  });

  it("does not detect the failure marker for a different run id", () => {
    expect(hasReviewLedgerFailureMarker(reviewLedgerFailureMarker("run-1"), "run-2")).toBe(false);
  });

  it("returns false for plain text with no marker", () => {
    expect(hasReviewLedgerFailureMarker("Some text", "run-1")).toBe(false);
  });
});
