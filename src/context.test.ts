import { describe, it, expect } from "vitest";
import {
  assembleImplementationContext,
  assembleFixingFeedbackContext,
} from "./context.js";
import type { PullRequestComment } from "./adapters/source-control.js";

describe("assembleImplementationContext", () => {
  it("assembles full context in spec Section 12 format", () => {
    const result = assembleImplementationContext(
      {
        externalId: "PROJ-42",
        identifier: "PROJ-42",
        title: "Add dark mode",
        description: "Implement dark mode across all pages",
        acceptanceCriteria: "All pages support dark theme",
        comments: [
          {
            author: "Alice",
            body: "Use CSS variables",
            createdAt: new Date("2026-03-10T10:00:00Z"),
          },
        ],
        labels: ["frontend"],
        trackerStatus: "AI",
      },
      "You are an agent. Implement the feature using TDD.",
    );

    expect(result).toContain("# Requirements");
    expect(result).toContain("## Ticket\nAdd dark mode");
    expect(result).toContain("## Description\nImplement dark mode across all pages");
    expect(result).toContain("## Acceptance Criteria\nAll pages support dark theme");
    expect(result).toContain("## Comments");
    expect(result).toContain("**Alice**");
    expect(result).toContain("Use CSS variables");
    expect(result).toContain("---");
    expect(result).toContain("You are an agent. Implement the feature using TDD.");
  });

  it("omits acceptance criteria when null", () => {
    const result = assembleImplementationContext(
      {
        externalId: "PROJ-42",
        identifier: "PROJ-42",
        title: "Title",
        description: "Desc",
        acceptanceCriteria: null,
        comments: [],
        labels: [],
        trackerStatus: "AI",
      },
      "prompt",
    );

    expect(result).not.toContain("## Acceptance Criteria");
  });

  it("omits comments section when empty", () => {
    const result = assembleImplementationContext(
      {
        externalId: "PROJ-42",
        identifier: "PROJ-42",
        title: "Title",
        description: "Desc",
        acceptanceCriteria: null,
        comments: [],
        labels: [],
        trackerStatus: "AI",
      },
      "prompt",
    );

    expect(result).not.toContain("## Comments");
  });

  it("always ends with prompt content after separator", () => {
    const result = assembleImplementationContext(
      {
        externalId: "PROJ-42",
        identifier: "PROJ-42",
        title: "T",
        description: "D",
        acceptanceCriteria: null,
        comments: [],
        labels: [],
        trackerStatus: "AI",
      },
      "Do TDD",
    );

    const lines = result.split("\n");
    const separatorIdx = lines.indexOf("---");
    expect(separatorIdx).toBeGreaterThan(-1);
    expect(lines.slice(separatorIdx + 1).join("\n")).toContain("Do TDD");
  });
});

describe("assembleFixingFeedbackContext", () => {
  const ticket = {
    externalId: "PROJ-42",
    identifier: "PROJ-42",
    title: "Add dark mode",
    description: "Implement dark mode",
    acceptanceCriteria: "All pages support dark theme",
    comments: [
      {
        author: "Alice",
        body: "Use CSS variables",
        createdAt: new Date("2026-03-10T10:00:00Z"),
      },
    ],
    labels: ["frontend"],
    trackerStatus: "AI",
  };

  const prComments: PullRequestComment[] = [
    {
      author: "bob",
      body: "Please add unit tests for the toggle",
      path: "src/toggle.ts",
      line: 15,
      fromApprovedReview: true,
    },
    {
      author: "carol",
      body: "LGTM on the color scheme",
      path: null,
      line: null,
      fromApprovedReview: false,
    },
  ];

  it("assembles full fixing-feedback context in spec Section 12 format", () => {
    const result = assembleFixingFeedbackContext(
      ticket,
      prComments,
      true,
      "review-fix prompt",
    );

    expect(result).toContain("# Requirements");
    expect(result).toContain("## Ticket\nAdd dark mode");
    expect(result).toContain("## Description\nImplement dark mode");
    expect(result).toContain("## Acceptance Criteria\nAll pages support dark theme");
    expect(result).toContain("## Comments");
    expect(result).toContain("**Alice**");
    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("### Liked Comments");
    expect(result).toContain("**bob** (`src/toggle.ts:15`):");
    expect(result).toContain("Please add unit tests for the toggle");
    expect(result).toContain("### Other Comments");
    expect(result).toContain("**carol**:");
    expect(result).toContain("LGTM on the color scheme");
    expect(result).toContain("## Merge Conflicts");
    expect(result).toContain("has merge conflicts");
    expect(result).toContain("---");
    expect(result).toContain("review-fix prompt");
  });

  it("renders liked comments before other comments", () => {
    const result = assembleFixingFeedbackContext(
      ticket,
      prComments,
      false,
      "prompt",
    );
    const likedIdx = result.indexOf("### Liked Comments");
    const otherIdx = result.indexOf("### Other Comments");
    expect(likedIdx).toBeLessThan(otherIdx);
  });

  it("omits liked subsection heading when no liked comments", () => {
    const noLiked: PullRequestComment[] = [
      {
        author: "dave",
        body: "Nit",
        path: null,
        line: null,
        fromApprovedReview: false,
      },
    ];
    const result = assembleFixingFeedbackContext(ticket, noLiked, false, "prompt");

    expect(result).toContain("## PR Review Feedback");
    expect(result).not.toContain("### Liked Comments");
    expect(result).not.toContain("### Other Comments");
  });

  it("omits other subsection heading when all comments are liked", () => {
    const allLiked: PullRequestComment[] = [
      {
        author: "eve",
        body: "Fix this",
        path: "src/a.ts",
        line: 1,
        fromApprovedReview: true,
      },
    ];
    const result = assembleFixingFeedbackContext(
      ticket,
      allLiked,
      false,
      "prompt",
    );

    expect(result).toContain("## PR Review Feedback");
    expect(result).not.toContain("### Liked Comments");
    expect(result).not.toContain("### Other Comments");
  });

  it("omits merge conflicts section when hasConflicts is false", () => {
    const result = assembleFixingFeedbackContext(
      ticket,
      prComments,
      false,
      "prompt",
    );

    expect(result).not.toContain("## Merge Conflicts");
  });

  it("omits PR review feedback section when no comments", () => {
    const result = assembleFixingFeedbackContext(ticket, [], false, "prompt");

    expect(result).not.toContain("## PR Review Feedback");
  });

  it("always ends with prompt content after separator", () => {
    const result = assembleFixingFeedbackContext(
      ticket,
      prComments,
      false,
      "Fix the issues",
    );
    const lines = result.split("\n");
    const separatorIdx = lines.indexOf("---");
    expect(separatorIdx).toBeGreaterThan(-1);
    expect(lines.slice(separatorIdx + 1).join("\n")).toContain("Fix the issues");
  });
});
