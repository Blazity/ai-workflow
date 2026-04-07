import { describe, it, expect } from "vitest";
import { extractUsage, unwrapResearchText, formatUsageReport, type PhaseUsage } from "./usage.js";

describe("extractUsage", () => {
  it("extracts usage from a single JSON result envelope", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      cost_usd: 0.053,
      duration_ms: 120000,
      duration_api_ms: 45000,
      num_turns: 15,
      result: "STATUS: completed\n\nPlan here",
    });
    const usage = extractUsage(raw);
    expect(usage).toEqual({
      cost_usd: 0.053,
      duration_ms: 120000,
      duration_api_ms: 45000,
      num_turns: 15,
    });
  });

  it("extracts usage from stream-json with multiple lines", () => {
    const lines = [
      JSON.stringify({ type: "assistant", content: "Working on it..." }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        cost_usd: 0.08,
        duration_ms: 200000,
        duration_api_ms: 60000,
        num_turns: 10,
        structured_output: { result: "implemented", summary: "Done" },
      }),
    ];
    const usage = extractUsage(lines.join("\n"));
    expect(usage).toEqual({
      cost_usd: 0.08,
      duration_ms: 200000,
      duration_api_ms: 60000,
      num_turns: 10,
    });
  });

  it("uses total_cost_usd when cost_usd is missing", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.12,
      duration_ms: 50000,
      duration_api_ms: 30000,
      num_turns: 5,
      result: "done",
    });
    const usage = extractUsage(raw);
    expect(usage?.cost_usd).toBe(0.12);
  });

  it("returns null for empty input", () => {
    expect(extractUsage("")).toBeNull();
    expect(extractUsage("  ")).toBeNull();
  });

  it("returns null for plain text without envelope", () => {
    expect(extractUsage("STATUS: completed\n\nSome plan")).toBeNull();
  });

  it("returns null for JSON without cost fields", () => {
    const raw = JSON.stringify({ type: "result", subtype: "success", result: "ok" });
    expect(extractUsage(raw)).toBeNull();
  });

  it("defaults missing duration/turns to 0", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      cost_usd: 0.01,
      result: "ok",
    });
    const usage = extractUsage(raw);
    expect(usage).toEqual({
      cost_usd: 0.01,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
    });
  });
});

describe("unwrapResearchText", () => {
  it("extracts result text from JSON envelope", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      cost_usd: 0.05,
      result: "STATUS: completed\n\n# Plan\n1. Do stuff",
    });
    const text = unwrapResearchText(raw);
    expect(text).toBe("STATUS: completed\n\n# Plan\n1. Do stuff");
  });

  it("returns plain text as-is when no envelope", () => {
    const raw = "STATUS: completed\n\nPlan here";
    expect(unwrapResearchText(raw)).toBe(raw);
  });

  it("returns empty string for empty input", () => {
    expect(unwrapResearchText("")).toBe("");
  });

  it("returns raw when envelope has non-string result", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      result: { nested: true },
    });
    expect(unwrapResearchText(raw)).toBe(raw);
  });
});

describe("formatUsageReport", () => {
  it("formats multiple phases with total", () => {
    const phases: Record<string, PhaseUsage | null> = {
      Research: { cost_usd: 0.03, duration_ms: 120000, duration_api_ms: 45000, num_turns: 10 },
      Impl: { cost_usd: 0.10, duration_ms: 900000, duration_api_ms: 300000, num_turns: 25 },
      Review: { cost_usd: 0.02, duration_ms: 180000, duration_api_ms: 60000, num_turns: 5 },
    };
    const report = formatUsageReport(phases);
    expect(report).toContain("$0.15 total");
    expect(report).toContain("Research: $0.03 (2m)");
    expect(report).toContain("Impl: $0.10 (15m)");
    expect(report).toContain("Review: $0.02 (3m)");
  });

  it("shows n/a for phases with null usage", () => {
    const phases: Record<string, PhaseUsage | null> = {
      Research: null,
      Impl: { cost_usd: 0.05, duration_ms: 60000, duration_api_ms: 30000, num_turns: 3 },
    };
    const report = formatUsageReport(phases);
    expect(report).toContain("Research: n/a");
    expect(report).toContain("Impl: $0.05 (1m)");
    expect(report).toContain("$0.05 total");
  });

  it("handles all null phases", () => {
    const report = formatUsageReport({ Research: null, Impl: null });
    expect(report).toContain("$0.00 total");
    expect(report).toContain("Research: n/a");
  });
});
