import { describe, it, expect, vi } from "vitest";
import {
  parseAgentOutput,
  AGENT_SCHEMA,
  type AgentOutput,
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
});

describe("AGENT_SCHEMA", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(AGENT_SCHEMA)).not.toThrow();
  });
});
