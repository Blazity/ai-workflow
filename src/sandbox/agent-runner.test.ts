import { describe, it, expect, vi } from "vitest";
import {
  parseAgentOutput,
  AGENT_SCHEMA,
  type AgentOutput,
  parseResearchStatus,
  parseReviewOutput,
  REVIEW_SCHEMA,
} from "./agent-runner.js";

describe("parseAgentOutput", () => {
  it("parses implemented result", () => {
    const raw = JSON.stringify({
      result: "implemented",
      summary: "Added login page with OAuth",
    });
    const output = parseAgentOutput(raw);
    expect(output.result).toBe("implemented");
    expect(output.summary).toBe("Added login page with OAuth");
  });

  it("parses clarification_needed result", () => {
    const raw = JSON.stringify({
      result: "clarification_needed",
      questions: ["What OAuth provider?", "Should we support SSO?"],
    });
    const output = parseAgentOutput(raw);
    expect(output.result).toBe("clarification_needed");
    expect(output.questions).toHaveLength(2);
  });

  it("parses failed result", () => {
    const raw = JSON.stringify({
      result: "failed",
      error: "Tests do not pass",
    });
    const output = parseAgentOutput(raw);
    expect(output.result).toBe("failed");
    expect(output.error).toBe("Tests do not pass");
  });

  it("extracts JSON from markdown-wrapped output", () => {
    const raw = `Here is my result:\n\`\`\`json\n{"result": "implemented", "summary": "Done"}\n\`\`\``;
    const output = parseAgentOutput(raw);
    expect(output.result).toBe("implemented");
    expect(output.summary).toBe("Done");
  });

  it("extracts JSON from text-wrapped output", () => {
    const raw = `I completed the task.\n{"result": "implemented", "summary": "Added feature"}\nThat's all.`;
    const output = parseAgentOutput(raw);
    expect(output.result).toBe("implemented");
  });

  it("returns failed on empty output", () => {
    const output = parseAgentOutput("");
    expect(output.result).toBe("failed");
    expect(output.error).toContain("no output");
  });

  it("returns failed on unparseable output", () => {
    const output = parseAgentOutput("not json at all");
    expect(output.result).toBe("failed");
    expect(output.error).toContain("not structured JSON");
  });

  it("returns failed on JSON missing result field", () => {
    const output = parseAgentOutput(JSON.stringify({ summary: "oops" }));
    expect(output.result).toBe("failed");
  });

  it("parses structured_output from result envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "I renamed the endpoint.",
      structured_output: { result: "implemented", summary: "Renamed endpoint" },
    });
    const output = parseAgentOutput(envelope);
    expect(output.result).toBe("implemented");
    expect(output.summary).toBe("Renamed endpoint");
  });

  it("falls back to event.result as JSON when structured_output is missing", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ result: "clarification_needed", questions: ["Which DB?"] }),
    });
    const output = parseAgentOutput(envelope);
    expect(output.result).toBe("clarification_needed");
    expect(output.questions).toEqual(["Which DB?"]);
  });

  it("infers implemented when result envelope has success but text output", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 6404,
      num_turns: 1,
      result: "\n\nI kept the response as-is to match the acceptance criteria.\n",
    });
    const output = parseAgentOutput(envelope);
    expect(output.result).toBe("implemented");
    expect(output.summary).toContain("acceptance criteria");
  });

  it("infers failed when result envelope has error status", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Agent crashed unexpectedly",
    });
    const output = parseAgentOutput(envelope);
    expect(output.result).toBe("failed");
    expect(output.error).toContain("crashed");
  });
});

describe("AGENT_SCHEMA", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(AGENT_SCHEMA)).not.toThrow();
  });
});

describe("parseResearchStatus", () => {
  it("extracts completed status", () => {
    const raw = "STATUS: completed\n\n# Implementation Plan\n1. Create foo.ts";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("completed");
    expect(body).toContain("# Implementation Plan");
  });

  it("extracts clarification_needed status", () => {
    const raw = "STATUS: clarification_needed\n\n1. What database?\n2. Which auth?";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("clarification_needed");
    expect(body).toContain("What database?");
  });

  it("extracts failed status", () => {
    const raw = "STATUS: failed\n\nCould not access repository";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("failed");
  });

  it("defaults to failed when no STATUS line", () => {
    const raw = "Here is my analysis of the codebase...";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("failed");
    expect(body).toContain("analysis");
  });

  it("handles STATUS line with extra whitespace", () => {
    const raw = "  STATUS:   completed  \n\nPlan here";
    const { status } = parseResearchStatus(raw);
    expect(status).toBe("completed");
  });

  it("handles leading blank lines before STATUS", () => {
    const raw = "\n\nSTATUS: clarification_needed\n\n1. Which provider?";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("clarification_needed");
    expect(body).toContain("Which provider?");
  });

  it("normalizes uppercase status values", () => {
    const raw = "STATUS: CLARIFICATION_NEEDED\n\n1. Which provider?";
    const { status } = parseResearchStatus(raw);
    expect(status).toBe("clarification_needed");
  });

  it("extracts STATUS from fenced output", () => {
    const raw = "```markdown\nSTATUS: clarification_needed\n\n1. Which provider?\n```";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("clarification_needed");
    expect(body).toContain("Which provider?");
  });
});

describe("parseReviewOutput", () => {
  it("parses approved result", () => {
    const raw = JSON.stringify({
      result: "approved",
      feedback: "Looks good",
      issues: [],
    });
    const output = parseReviewOutput(raw);
    expect(output.result).toBe("approved");
    expect(output.feedback).toBe("Looks good");
  });

  it("parses changes_requested result with issues", () => {
    const raw = JSON.stringify({
      result: "changes_requested",
      feedback: "Several issues found",
      issues: [
        { file: "src/foo.ts", description: "Missing null check", severity: "critical" },
      ],
    });
    const output = parseReviewOutput(raw);
    expect(output.result).toBe("changes_requested");
    expect(output.issues).toHaveLength(1);
    expect(output.issues[0].severity).toBe("critical");
  });

  it("returns failed on unparseable output", () => {
    const output = parseReviewOutput("not json");
    expect(output.result).toBe("failed");
    expect(output.error).toBeDefined();
  });

  it("returns failed on empty output", () => {
    const output = parseReviewOutput("");
    expect(output.result).toBe("failed");
  });

  it("extracts from result envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: {
        result: "approved",
        feedback: "All good",
        issues: [],
      },
    });
    const output = parseReviewOutput(envelope);
    expect(output.result).toBe("approved");
  });
});

describe("REVIEW_SCHEMA", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(REVIEW_SCHEMA)).not.toThrow();
  });
});
