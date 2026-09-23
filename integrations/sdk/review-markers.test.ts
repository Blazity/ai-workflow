/**
 * The marker grammar has one home now, and the markers it describes are
 * already posted on pull requests across every deployment. So the expected
 * values here are not produced by the code under test: each is the literal
 * `main` wrote before the providers moved into packages (the builders in
 * `apps/worker/src/adapters/vcs/vcs-bot-identity.ts`, `github.ts` and
 * `gitlab.ts` at `main`), typed out. A builder that drifts by one character
 * stops recognising every comment a deployment already posted, and these fail.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  hasReviewLedgerFailureMarker,
  isOurOwnVcsComment,
  isReopenedLedgerThread,
  isReviewLedgerNote,
  legacyReviewCommentMarker,
  markReviewLedgerReplyResolved,
  markReviewLedgerReplyStale,
  readAnyReviewLedgerMarker,
  readReviewFindingDigest,
  readReviewLedgerMarker,
  reviewFindingMarker,
  reviewHeadMarker,
  reviewLedgerFailureMarker,
  reviewLedgerMarker,
  reviewSummaryMarker,
} from "./index";

/** What `main` posted, byte for byte. */
const MAIN = {
  bot: "<!-- ai-workflow:bot -->",
  ledger: "<!-- ai-workflow:ledger:PRRT_kwDOabc --> <!-- ai-workflow:bot -->",
  ledgerStale: "<!-- ai-workflow:ledger-stale:PRRT_kwDOabc --> <!-- ai-workflow:bot -->",
  ledgerResolved: "<!-- ai-workflow:ledger-resolved:PRRT_kwDOabc --> <!-- ai-workflow:bot -->",
  ledgerOnGitLabNote: "<!-- ai-workflow:ledger:note:4411 --> <!-- ai-workflow:bot -->",
  failure: "<!-- ai-workflow:ledger-failure:wrun_01J8 --> <!-- ai-workflow:bot -->",
  summary: "<!-- ai-workflow-review:pr-github-acme-api-7 -->",
  head: "<!-- ai-workflow-review-head:4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c -->",
  finding: "<!-- ai-workflow-review-finding:0123456789abcdef0123456789abcdef -->",
  legacyComment: "<!-- ai-workflow-review-comment:pr-gitlab-acme-api-7:3 -->",
};

describe("a marker written now is the marker main wrote", () => {
  test("every builder writes main's bytes", () => {
    assert.equal(AI_WORKFLOW_COMMENT_MARKER, MAIN.bot);
    assert.equal(reviewLedgerMarker("PRRT_kwDOabc"), MAIN.ledger);
    assert.equal(reviewLedgerFailureMarker("wrun_01J8"), MAIN.failure);
    assert.equal(reviewSummaryMarker("pr-github-acme-api-7"), MAIN.summary);
    assert.equal(reviewHeadMarker("4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c"), MAIN.head);
    assert.equal(reviewFindingMarker("0123456789abcdef0123456789abcdef"), MAIN.finding);
    assert.equal(legacyReviewCommentMarker("pr-gitlab-acme-api-7", 3), MAIN.legacyComment);
  });

  test("the stale and resolved variants replace the plain marker main swapped", () => {
    const reply = `Renamed it.\n\n${MAIN.ledger}`;
    assert.equal(markReviewLedgerReplyStale(reply, "PRRT_kwDOabc"), `Renamed it.\n\n${MAIN.ledgerStale}`);
    assert.equal(
      markReviewLedgerReplyResolved(reply, "PRRT_kwDOabc"),
      `Renamed it.\n\n${MAIN.ledgerResolved}`,
    );
    // A reply composed without its marker still leaves marked.
    assert.equal(
      markReviewLedgerReplyStale("Renamed it.", "PRRT_kwDOabc"),
      `Renamed it.\n\n${MAIN.ledgerStale}`,
    );
  });
});

describe("a marker main posted still reads", () => {
  test("a ledger reply parks its thread; the stale and resolved ones do not", () => {
    assert.equal(readReviewLedgerMarker(`done. ${MAIN.ledger}`), "PRRT_kwDOabc");
    assert.equal(readReviewLedgerMarker(`done. ${MAIN.ledgerOnGitLabNote}`), "note:4411");
    assert.equal(readReviewLedgerMarker(`done. ${MAIN.ledgerStale}`), null);
    assert.equal(readReviewLedgerMarker(`done. ${MAIN.ledgerResolved}`), null);
  });

  test("any reply variant is recognised as a reply already posted", () => {
    for (const marker of [MAIN.ledger, MAIN.ledgerStale, MAIN.ledgerResolved]) {
      assert.equal(readAnyReviewLedgerMarker(`done. ${marker}`), "PRRT_kwDOabc");
    }
    assert.equal(readAnyReviewLedgerMarker(`sorry. ${MAIN.failure}`), null);
  });

  test("a failure note is ledger bookkeeping, and is found by its run", () => {
    assert.equal(isReviewLedgerNote(`The run failed.\n\n${MAIN.failure}`), true);
    assert.equal(hasReviewLedgerFailureMarker(`The run failed.\n\n${MAIN.failure}`, "wrun_01J8"), true);
    assert.equal(hasReviewLedgerFailureMarker(`The run failed.\n\n${MAIN.failure}`, "wrun_other"), false);
    assert.equal(isReviewLedgerNote("please rename this"), false);
  });

  test("a finding's digest is read back verbatim", () => {
    assert.equal(
      readReviewFindingDigest(`**Bug**: off by one.\n\n${MAIN.finding}`),
      "0123456789abcdef0123456789abcdef",
    );
    assert.equal(readReviewFindingDigest(`**Bug**: off by one.\n\n${MAIN.summary}`), null);
  });

  test("every family main wrote is ours, and none of them once quoted", () => {
    for (const marker of Object.values(MAIN)) {
      assert.equal(isOurOwnVcsComment(`Some text.\n\n${marker}`), true, marker);
      assert.equal(isOurOwnVcsComment(`> Some text.\n>\n> ${marker}\n\nStill broken.`), false, marker);
    }
  });
});

describe("a thread our reply parked", () => {
  const ours = (note: { author: string }) => note.author === "ai-workflow[bot]";

  test("reopens when a person writes after the reply", () => {
    assert.equal(
      isReopenedLedgerThread(
        [
          { author: "dev", body: "rename this", createdAt: "2026-09-01T10:00:00Z" },
          { author: "ai-workflow[bot]", body: `done. ${MAIN.ledger}`, createdAt: "2026-09-01T11:00:00Z" },
          { author: "dev", body: "not what I meant", createdAt: "2026-09-01T12:00:00Z" },
        ],
        ours,
      ),
      true,
    );
  });

  test("stays parked when the newest note is ours, or when the marker was only quoted", () => {
    assert.equal(
      isReopenedLedgerThread(
        [
          { author: "dev", body: "rename this", createdAt: "2026-09-01T10:00:00Z" },
          { author: "ai-workflow[bot]", body: `done. ${MAIN.ledger}`, createdAt: "2026-09-01T11:00:00Z" },
        ],
        ours,
      ),
      false,
    );
    assert.equal(
      isReopenedLedgerThread(
        [
          { author: "dev", body: `> done. ${MAIN.ledger}\n\nplease`, createdAt: "2026-09-01T11:00:00Z" },
          { author: "dev", body: "anyone?", createdAt: "2026-09-01T12:00:00Z" },
        ],
        ours,
      ),
      false,
    );
  });
});
