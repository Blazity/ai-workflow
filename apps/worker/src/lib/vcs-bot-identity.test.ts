import { describe, expect, it } from "vitest";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  hasAiWorkflowCommentMarker,
  normalizeVcsLogin,
  resolveVcsBotLogin,
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
