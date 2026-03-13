import { describe, it, expect } from "vitest";
import { assembleImplementationContext } from "./context.js";

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
      },
      "Do TDD",
    );

    const lines = result.split("\n");
    const separatorIdx = lines.indexOf("---");
    expect(separatorIdx).toBeGreaterThan(-1);
    expect(lines.slice(separatorIdx + 1).join("\n")).toContain("Do TDD");
  });
});
