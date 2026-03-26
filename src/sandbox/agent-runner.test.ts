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

  it("parses structured JSON from result envelope event.result", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ result: "implemented", summary: "Renamed endpoint" }),
    });
    const output = parseAgentOutput(envelope);
    expect(output.result).toBe("implemented");
    expect(output.summary).toBe("Renamed endpoint");
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
