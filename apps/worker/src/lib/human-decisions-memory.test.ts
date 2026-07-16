import { describe, expect, it } from "vitest";
import {
  renderHumanDecisionsSection,
  upsertHumanDecisionsSection,
  type HumanDecision,
} from "./human-decisions-memory.js";

const START = "<!-- human-decisions:start -->";
const END = "<!-- human-decisions:end -->";

describe("renderHumanDecisionsSection", () => {
  it("renders a single round with full metadata", () => {
    const clarifications: HumanDecision[] = [
      {
        questions: ["First question?", "Second question?"],
        answer: "the verbatim answer text",
        answeredBy: "Jane Doe",
        answeredAt: "2026-07-16T11:40:38Z",
      },
    ];
    expect(renderHumanDecisionsSection(clarifications)).toBe(
      [
        START,
        "## Human decisions (from the dashboard)",
        "",
        "Recorded automatically from the clarification Q&A. Do not edit or remove.",
        "",
        "### Round 1 (answered by Jane Doe, 2026-07-16T11:40:38Z)",
        "1. First question?",
        "2. Second question?",
        "",
        "Answer: the verbatim answer text",
        END,
      ].join("\n"),
    );
  });

  it("omits missing metadata parts individually", () => {
    const onlyBy = renderHumanDecisionsSection([
      { questions: ["Q?"], answer: "A", answeredBy: "Jane Doe" },
    ]);
    expect(onlyBy).toContain("### Round 1 (answered by Jane Doe)");

    const onlyAt = renderHumanDecisionsSection([
      { questions: ["Q?"], answer: "A", answeredAt: "2026-07-16T11:40:38Z" },
    ]);
    expect(onlyAt).toContain("### Round 1 (2026-07-16T11:40:38Z)");

    const neither = renderHumanDecisionsSection([{ questions: ["Q?"], answer: "A" }]);
    expect(neither).toContain("### Round 1\n");
    expect(neither).not.toContain("### Round 1 (");
  });

  it("renders multiple rounds in chronological order separated by a blank line", () => {
    const section = renderHumanDecisionsSection([
      { questions: ["Q1?"], answer: "A1", answeredBy: "Jane" },
      { questions: ["Q2?"], answer: "A2", answeredBy: "John" },
    ]);
    expect(section).toContain(
      [
        "### Round 1 (answered by Jane)",
        "1. Q1?",
        "",
        "Answer: A1",
        "",
        "### Round 2 (answered by John)",
        "1. Q2?",
        "",
        "Answer: A2",
      ].join("\n"),
    );
    expect(section.indexOf("Round 1")).toBeLessThan(section.indexOf("Round 2"));
  });

  it("preserves multi-line answers verbatim", () => {
    const section = renderHumanDecisionsSection([
      { questions: ["Q?"], answer: "line one\nline two\n- bullet" },
    ]);
    expect(section).toContain("Answer: line one\nline two\n- bullet");
  });
});

describe("upsertHumanDecisionsSection", () => {
  const section = renderHumanDecisionsSection([
    { questions: ["Q?"], answer: "A", answeredBy: "Jane Doe" },
  ]);

  it("creates minimal content when there is no existing file", () => {
    const result = upsertHumanDecisionsSection(null, section, "AIW-1");
    expect(result).toBe(`# Session Memory: AIW-1\n\n${section}\n`);
  });

  it("appends after a blank line when the file has no markers", () => {
    const existing = "# Session Memory: AIW-1\n\n## Progress\n- did stuff\n";
    const result = upsertHumanDecisionsSection(existing, section, "AIW-1");
    expect(result).toBe(`# Session Memory: AIW-1\n\n## Progress\n- did stuff\n\n${section}\n`);
  });

  it("replaces the marked block in place when the file already has markers", () => {
    const existing = `# Session Memory: AIW-1\n\n${section}\n\n## Progress\n- did stuff\n`;
    const newer = renderHumanDecisionsSection([
      { questions: ["Q?"], answer: "A", answeredBy: "Jane Doe" },
      { questions: ["Q2?"], answer: "A2", answeredBy: "John Roe" },
    ]);
    const result = upsertHumanDecisionsSection(existing, newer, "AIW-1");
    expect(result).toBe(`# Session Memory: AIW-1\n\n${newer}\n\n## Progress\n- did stuff\n`);
    // The trailing content after the block is preserved.
    expect(result).toContain("## Progress\n- did stuff\n");
  });

  it("is idempotent: applying twice yields identical output", () => {
    for (const start of [null, "# Session Memory: AIW-1\n\n## Progress\n- did stuff\n"] as const) {
      const once = upsertHumanDecisionsSection(start, section, "AIW-1");
      const twice = upsertHumanDecisionsSection(once, section, "AIW-1");
      expect(twice).toBe(once);
    }
  });
});
