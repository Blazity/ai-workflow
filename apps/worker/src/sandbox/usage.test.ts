import { describe, it, expect } from "vitest";
import { formatUsageReport, computeUsageTotals, type PhaseUsage } from "./usage.js";

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

  it("prices each phase against its own model when modelsByPhase is given", () => {
    const out = formatUsageReport(
      {
        Research: u({ tokens: { input: 1000, cached_input: 0, output: 1000 } }),
        Impl: u({ tokens: { input: 1000, cached_input: 0, output: 1000 } }),
      },
      (m) =>
        m === "cheap"
          ? { input: 0, cached_input: 0, output: 0 }
          : { input: 0.00001, cached_input: 0, output: 0.00002 },
      "cheap",
      { Research: "pricey", Impl: "cheap" },
    );
    expect(out).not.toContain("cost unknown");
    expect(out).toContain("Research: $0.03");
    expect(out).toContain("Impl: $0.00");
  });
});

describe("computeUsageTotals", () => {
  it("sums a claude cost_usd phase and a priced codex token phase (costKnown true)", () => {
    const totals = computeUsageTotals(
      {
        Research: u({ cost_usd: 0.5 }),
        Impl: u({ tokens: { input: 1000, cached_input: 0, output: 500 } }),
      },
      (m) => (m === "codex-model" ? { input: 0.001, cached_input: 0, output: 0.002 } : null),
      "claude-model",
      { Research: "claude-model", Impl: "codex-model" },
    );
    expect(totals.costKnown).toBe(true);
    // 0.5 + (1000 * 0.001 + 500 * 0.002) = 0.5 + 1 + 1
    expect(totals.costUsd).toBeCloseTo(2.5, 5);
  });

  it("marks costKnown false when a codex phase has no price", () => {
    const totals = computeUsageTotals(
      {
        Research: u({ cost_usd: 0.5 }),
        Impl: u({ tokens: { input: 1000, cached_input: 0, output: 500 } }),
      },
      () => null,
      "claude-model",
      { Research: "claude-model", Impl: "codex-model" },
    );
    expect(totals.costKnown).toBe(false);
    // Only the claude phase is priced; the codex phase is a lower bound.
    expect(totals.costUsd).toBeCloseTo(0.5, 5);
  });

  it("records the resolved per-phase model in the breakdown", () => {
    const totals = computeUsageTotals(
      { Research: u({ tokens: { input: 10, cached_input: 0, output: 10 } }), Impl: null },
      () => ({ input: 0, cached_input: 0, output: 0 }),
      "default-model",
      { Research: "phase-model" },
    );
    expect(totals.phases.Research.model).toBe("phase-model");
    expect(totals.phases.Impl.model).toBe("default-model");
  });

  it("returns null aggregate tokens when any launched phase has unknown usage", () => {
    const totals = computeUsageTotals({
      Research: u({ tokens: { input: 10, cached_input: 2, output: 3 } }),
      Impl: null,
    });

    expect(totals.tokensInput).toBeNull();
    expect(totals.tokensCached).toBeNull();
    expect(totals.tokensOutput).toBeNull();
  });
});
