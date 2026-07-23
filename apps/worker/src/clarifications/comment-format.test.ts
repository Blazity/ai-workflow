import { describe, expect, it } from "vitest";
import {
  CLARIFICATION_NUDGE_MARKER,
  formatAlreadyAnsweredComment,
  formatClarificationNudgeComment,
  formatClarificationQuestionsComment,
} from "./comment-format.js";

const DASHBOARD = "https://app/ticket/AWT-42?run=wrun_9";

describe("formatClarificationQuestionsComment", () => {
  it("numbers questions in order and includes dashboard URL and column name", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository?", "Which branch?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toContain("1. Which repository?");
    expect(body).toContain("2. Which branch?");
    expect(body.indexOf("1. Which repository?")).toBeLessThan(
      body.indexOf("2. Which branch?"),
    );
    expect(body).toContain(`- In the dashboard: ${DASHBOARD}`);
    expect(body).toContain('move it back to the "AI" column.');
  });

  it("omits the suggested-answers block when null or empty", () => {
    const nullSuggestions = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(nullSuggestions).not.toContain("Suggested answers:");

    const emptySuggestions = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: [],
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(emptySuggestions).not.toContain("Suggested answers:");
  });

  it("renders the suggested-answers block when present", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: ["the api repo", "the web repo"],
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toContain("Suggested answers:");
    expect(body).toContain("- the api repo");
    expect(body).toContain("- the web repo");
  });

  it("renders the expiry paragraph from the ISO input as a UTC minute", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: "2026-07-29T14:03:07.512Z",
    });
    expect(body).toContain(
      "The paused run is resumable until 2026-07-29 14:03 UTC.",
    );
    expect(body).toContain("the ticket starts over from scratch.");
  });

  it("omits the expiry paragraph when expiresAtIso is null", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).not.toContain("resumable until");
  });
});

describe("formatClarificationNudgeComment", () => {
  it("contains the marker and the dashboard URL and column name", () => {
    const body = formatClarificationNudgeComment({
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
    });
    expect(body).toContain(CLARIFICATION_NUDGE_MARKER);
    expect(body).toContain(DASHBOARD);
    expect(body).toContain('move the ticket back to the "AI" column.');
  });
});

describe("formatAlreadyAnsweredComment", () => {
  it("names the label who answered", () => {
    expect(formatAlreadyAnsweredComment({ answeredByLabel: "Jane Doe" })).toContain(
      "Jane Doe",
    );
  });
});
