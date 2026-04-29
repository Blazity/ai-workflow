import { describe, it, expect } from "vitest";
import { formatUsageReport, type PhaseUsage } from "./usage.js";

const u = (over: Partial<PhaseUsage> = {}): PhaseUsage => ({
  cost_usd: null, tokens: null, duration_ms: 60_000, duration_api_ms: 30_000, num_turns: 1, ...over,
});

describe("formatUsageReport", () => {
  it("uses cost_usd when present", () => {
    const out = formatUsageReport({ Impl: u({ cost_usd: 1.23 }) });
    expect(out).toContain("$1.23");
    expect(out).toContain("$1.23 total");
  });

  it("computes cost from tokens + priceLookup when cost_usd is null", () => {
    const out = formatUsageReport(
      { Impl: u({ tokens: { input: 1000, cached_input: 0, output: 500 } }) },
      () => ({ input: 0.000003, cached_input: 0, output: 0.000015 }),
      "gpt-5-codex",
    );
    expect(out).toMatch(/\$0\.0[01]/);
    expect(out).not.toContain("cost unknown");
  });

  it("falls back to tokens-only when no price and tokens are present", () => {
    const out = formatUsageReport(
      { Impl: u({ tokens: { input: 100, cached_input: 0, output: 50 } }) },
      () => null,
      "unknown-model",
    );
    expect(out).toContain("100/50 tok (cost unknown)");
    expect(out).toContain("+ total");
  });

  it("shows n/a for null phases", () => {
    const out = formatUsageReport({ Impl: null });
    expect(out).toContain("Impl: n/a");
  });
});
