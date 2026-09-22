import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  hasUnquotedAiWorkflowCommentMarker,
  isOurOwnPrComment,
  reviewLedgerMarker,
} from "./vcs-bot-identity.js";

/**
 * Every file that writes a marker into a pull request. The guard below reads
 * their source rather than a list kept here, because a list kept here is a list
 * somebody forgets: the review pass already shipped three marker families that
 * the identity rule did not know about, and on every pull request it had
 * touched, our own findings were read as a person's words.
 */
const MARKER_WRITERS = [
  "../../../../../integrations/github/review-markers.ts",
  "../../../../../integrations/github/vcs.ts",
  "../../../../../integrations/gitlab/review-markers.ts",
  "../../../../../integrations/gitlab/vcs.ts",
  "./types.ts",
  "./vcs-bot-identity.ts",
];

/** Every `<!-- ai-workflow... -->` literal in a file, with template holes and
 *  capture groups filled in so the result is a marker a provider could return. */
function markersWrittenIn(relativePath: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
  const found = source.match(/<!--\s*ai-workflow[^>]*-->/g) ?? [];
  return [
    ...new Set(
      found.map((marker) =>
        marker
          .replace(/\$\{[^}]*\}/g, "abc123")
          .replace(/\(\[\^\\s\]\+\)/g, "abc123")
          .replace(/\(\?:[^)]*\)\?/g, ""),
      ),
    ),
  ];
}

describe("isOurOwnPrComment knows every marker this workflow writes", () => {
  const markers = MARKER_WRITERS.flatMap(markersWrittenIn);

  it("found the marker families to check, in the adapters' own source", () => {
    // If this ever reads zero, the guard below is passing on an empty list and
    // proving nothing.
    expect(markers.length).toBeGreaterThanOrEqual(6);
    // The three the review pass writes, which carry no bot marker at all.
    expect(markers.some((m) => m.includes("ai-workflow-review-finding:"))).toBe(true);
    expect(markers.some((m) => m.includes("ai-workflow-review-head:"))).toBe(true);
    expect(markers.some((m) => m.includes("ai-workflow-review:"))).toBe(true);
  });

  it.each(markers)("claims %s as ours when its author wrote it", (marker) => {
    expect(isOurOwnPrComment(`Some body text.\n\n${marker}`)).toBe(true);
  });

  it.each(markers)("hands %s back to the person who only quoted it", (marker) => {
    const quoted = `> Some body text.\n>\n> ${marker}\n\nThis did not fix it.`;
    expect(isOurOwnPrComment(quoted)).toBe(false);
  });
});

describe("isOurOwnPrComment", () => {
  it("reads a comment with no marker at all as a person's", () => {
    expect(isOurOwnPrComment("please add the missing null check")).toBe(false);
    expect(isOurOwnPrComment("")).toBe(false);
    expect(isOurOwnPrComment(null)).toBe(false);
    expect(isOurOwnPrComment(undefined)).toBe(false);
  });

  it("reads a marker behind a nested or indented quote as quoted", () => {
    for (const prefix of ["> > ", "   > ", ">"]) {
      expect(isOurOwnPrComment(`${prefix}${AI_WORKFLOW_COMMENT_MARKER}\n\nstill broken`)).toBe(
        false,
      );
    }
  });

  it("keeps a note of ours that quotes somebody else", () => {
    expect(
      isOurOwnPrComment(`> still broken\n\nFixed in a1b2c3d.\n\n${AI_WORKFLOW_COMMENT_MARKER}`),
    ).toBe(true);
    expect(isOurOwnPrComment(`Answered.\n\n${reviewLedgerMarker("PRRT_1")}`)).toBe(true);
  });
});

describe("hasUnquotedAiWorkflowCommentMarker", () => {
  it("is what post_pr_comment asks before deciding to append a marker", () => {
    // Quoted only: the body is not marked, so one still has to be appended or
    // the comment we are about to post reads as a person's everywhere.
    expect(hasUnquotedAiWorkflowCommentMarker(`> ${AI_WORKFLOW_COMMENT_MARKER}\n\nours`)).toBe(
      false,
    );
    expect(hasUnquotedAiWorkflowCommentMarker(`ours\n\n${AI_WORKFLOW_COMMENT_MARKER}`)).toBe(true);
  });

  it("does not accept a review marker in place of the bot marker", () => {
    // Narrower than isOurOwnPrComment on purpose: the bot marker is the one
    // trigger-events falls back to when a bot login is misconfigured, so a
    // review finding's own marker must not stand in for it.
    expect(hasUnquotedAiWorkflowCommentMarker("body\n\n<!-- ai-workflow-review-finding:abc -->")).toBe(
      false,
    );
  });
});
