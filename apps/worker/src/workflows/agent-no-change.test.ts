import { describe, expect, it } from "vitest";
import type { ResearchResult } from "../sandbox/agents/types.js";
import { buildResolutionEvidenceComment } from "./agent.js";

const research = (overrides: Partial<ResearchResult> = {}): ResearchResult => ({
  status: "completed",
  body: "The reported crash is already fixed on main.",
  noChangeNeeded: true,
  resolutionEvidence: [
    "Commit a1b2c3d guards the null branch.",
    "PR #412 shipped the same fix.",
  ],
  writeRepositories: [],
  ...overrides,
});

describe("buildResolutionEvidenceComment", () => {
  it("states the no-op, quotes the research body, and bullets every evidence entry", () => {
    expect(buildResolutionEvidenceComment(research())).toBe(
      [
        "This ticket appears to be already resolved, so no code changes were made by this run.",
        "",
        "The reported crash is already fixed on main.",
        "",
        "Evidence:",
        "- Commit a1b2c3d guards the null branch.",
        "- PR #412 shipped the same fix.",
      ].join("\n"),
    );
  });

  it("keeps the copy free of en and em dashes", () => {
    const comment = buildResolutionEvidenceComment(
      research({
        body: "Nothing to do, the fix landed earlier.",
        resolutionEvidence: ["Ticket comment: Fixed in 9f8e7d6."],
      }),
    );
    // U+2013 en dash and U+2014 em dash, matched by escape so this file does
    // not spell them out either.
    expect(comment).not.toMatch(/[\u2013\u2014]/);
  });

  it("drops the evidence section when there is none to list", () => {
    const withEmpty = buildResolutionEvidenceComment(
      research({ resolutionEvidence: [] }),
    );
    const withMissing = buildResolutionEvidenceComment(
      research({ resolutionEvidence: undefined }),
    );
    expect(withEmpty).toBe(
      [
        "This ticket appears to be already resolved, so no code changes were made by this run.",
        "",
        "The reported crash is already fixed on main.",
      ].join("\n"),
    );
    expect(withMissing).toBe(withEmpty);
  });
});
