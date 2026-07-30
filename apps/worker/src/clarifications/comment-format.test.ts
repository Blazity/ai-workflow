import { describe, expect, it } from "vitest";
import { SCRUB_PLACEHOLDER } from "../lib/publication-scrub.js";
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

describe("formatClarificationQuestionsComment publication scrub", () => {
  it("leaves a comment with nothing to scrub byte-identical", () => {
    const body = formatClarificationQuestionsComment({
      questions: [
        "Should the retry live in apps/api/src/queue/retry.ts?",
        "Which module owns the fixture src/fixtures/memory/AWP-28.md, apps/web or packages/core?",
      ],
      suggestedAnswers: ["apps/web is the source of truth", "Keep both, behind a flag"],
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: "2026-07-29T14:03:07.512Z",
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        "1. Should the retry live in apps/api/src/queue/retry.ts?",
        "2. Which module owns the fixture src/fixtures/memory/AWP-28.md, apps/web or packages/core?",
        "",
        "Suggested answers:",
        "- apps/web is the source of truth",
        "- Keep both, behind a flag",
        "",
        "How to answer:",
        `- In the dashboard: ${DASHBOARD}`,
        '- Or reply in a comment on this ticket and move it back to the "AI" column.',
        "",
        "The paused run is resumable until 2026-07-29 14:03 UTC. After that the ticket starts over from scratch.",
      ].join("\n"),
    );
  });

  it("removes the platform bookkeeping sentence from a question and keeps the question", () => {
    const body = formatClarificationQuestionsComment({
      questions: [
        "Session memory was overwritten in blazebot/memory/AWP-28.md. Which repository should the fix land in?",
        "Should the retry budget stay at three attempts?",
      ],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        "1. Which repository should the fix land in?",
        "2. Should the retry budget stay at three attempts?",
        "",
        "How to answer:",
        `- In the dashboard: ${DASHBOARD}`,
        '- Or reply in a comment on this ticket and move it back to the "AI" column.',
      ].join("\n"),
    );
  });

  it("keeps the numbering when a question is entirely platform bookkeeping", () => {
    const body = formatClarificationQuestionsComment({
      questions: [
        "I did not push or open a PR because this sandbox workflow explicitly forbids publish actions.",
        "Should the retry budget stay at three attempts?",
      ],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        `1. ${SCRUB_PLACEHOLDER}`,
        "2. Should the retry budget stay at three attempts?",
        "",
        "How to answer:",
        `- In the dashboard: ${DASHBOARD}`,
        '- Or reply in a comment on this ticket and move it back to the "AI" column.',
      ].join("\n"),
    );
  });

  it("scrubs the suggested answers too", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository should the fix land in?"],
      suggestedAnswers: [
        "The api repo, as recorded in blazebot/memory/AWP-28.md",
        "The web repo",
      ],
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        "1. Which repository should the fix land in?",
        "",
        "Suggested answers:",
        `- ${SCRUB_PLACEHOLDER}`,
        "- The web repo",
        "",
        "How to answer:",
        `- In the dashboard: ${DASHBOARD}`,
        '- Or reply in a comment on this ticket and move it back to the "AI" column.',
      ].join("\n"),
    );
  });

  it("leaves the platform-generated fields alone even when they carry marker-shaped text", () => {
    // Neither value can look like this in production: the URL is built from
    // DASHBOARD_ORIGIN and the column name comes from COLUMN_AI. They carry
    // markers here to pin which strings the scrub is allowed to touch, so a
    // scrub applied to the composed comment or to the wrong field is visible.
    const url = "https://app/ticket/AWT-42?run=wrun_9&from=blazebot/memory/AWP-28.md";
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository should the fix land in?"],
      suggestedAnswers: null,
      dashboardUrl: url,
      aiColumnName: "Session memory",
      expiresAtIso: null,
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        "1. Which repository should the fix land in?",
        "",
        "How to answer:",
        `- In the dashboard: ${url}`,
        '- Or reply in a comment on this ticket and move it back to the "Session memory" column.',
      ].join("\n"),
    );
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
