import { describe, it, expect } from "vitest";
import { parseAgentOutput, sanitizeForLog } from "./parse-output.js";

describe("parseAgentOutput", () => {
  const makeEnvelope = (result: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Full text response...",
      structured_output: { result, ...extra },
    });

  it("parses structured_output from envelope", () => {
    const output = parseAgentOutput(makeEnvelope("implemented", { summary: "Done" }));
    expect(output).toEqual({ result: "implemented", summary: "Done" });
  });

  it("falls back to bare result field", () => {
    const output = parseAgentOutput(JSON.stringify({ result: "implemented", summary: "Bare" }));
    expect(output).toEqual({ result: "implemented", summary: "Bare" });
  });

  it("returns null for non-JSON output", () => {
    expect(parseAgentOutput("random text")).toBeNull();
  });

  it("returns null when result field is not a valid enum value", () => {
    const output = parseAgentOutput(
      JSON.stringify({ type: "result", result: "I have successfully done the thing..." }),
    );
    expect(output).toBeNull();
  });

  it("scans from last line backwards", () => {
    const stdout = "some logs\nmore logs\n" + makeEnvelope("clarification_needed", { questions: ["What?"] });
    const output = parseAgentOutput(stdout);
    expect(output?.result).toBe("clarification_needed");
  });
});

describe("sanitizeForLog", () => {
  it("truncates to last 1000 chars", () => {
    const long = "x".repeat(2000);
    expect(sanitizeForLog(long)).toHaveLength(1000);
  });
});
