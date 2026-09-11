import { describe, it, expect } from "vitest";
import { formatUsageReport, computeUsageTotals, type PhaseUsage } from "./usage.js";

const u = (over: Partial<PhaseUsage> = {}): PhaseUsage => ({
  cost_usd: null, tokens: null, duration_ms: 60_000, duration_api_ms: 30_000, num_turns: 1, ...over,
});

describe("formatUsageReport", () => {
  it("uses cost_usd when present", () => {
    const out = formatUsageReport(
      { Impl: u({ cost_usd: 1.23 }) },
      { Impl: "claude" },
    );
    expect(out).toContain("$1.23");
    expect(out).toContain("$1.23 total");
  });

  it("computes cost from tokens + priceLookup when cost_usd is null", () => {
    const out = formatUsageReport(
      { Impl: u({ tokens: { input: 1000, cached_input: 0, output: 500 } }) },
      { Impl: "codex" },
      () => ({ input: 0.000003, cached_input: 0, output: 0.000015 }),
      "gpt-5-codex",
    );
    expect(out).toMatch(/\$0\.0[01]/);
    expect(out).not.toContain("cost unknown");
  });

  it("falls back to tokens-only when no price and tokens are present", () => {
    const out = formatUsageReport(
      { Impl: u({ tokens: { input: 100, cached_input: 0, output: 50 } }) },
      { Impl: "codex" },
      () => null,
      "unknown-model",
    );
    expect(out).toContain("100/50 tok (cost unknown)");
    expect(out).toContain("+ total");
  });

  it("shows n/a for null phases", () => {
    const out = formatUsageReport({ Impl: null }, {});
    expect(out).toContain("Impl: n/a");
  });

  it("prices each phase against its own model when modelsByPhase is given", () => {
    const out = formatUsageReport(
      {
        Research: u({ tokens: { input: 1000, cached_input: 0, output: 1000 } }),
        Impl: u({ tokens: { input: 1000, cached_input: 0, output: 1000 } }),
      },
      { Research: "codex", Impl: "codex" },
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
  it("prices Claude and Codex token usage identically", () => {
    const usage = u({ tokens: { input: 1_000, cached_input: 400, output: 500 } });
    const totals = computeUsageTotals(
      { Claude: usage, Codex: usage },
      { Claude: "claude", Codex: "codex" },
      () => ({ input: 0.000_003, cached_input: 0.000_000_7, output: 0.000_015 }),
      "shared-price-model",
    );

    expect(totals.phases.Claude.costUsd).toBe(0.010_78);
    expect(totals.phases.Codex.costUsd).toBe(0.010_78);
  });

  it("sums a claude cost_usd phase and a priced codex token phase (costKnown true)", () => {
    const totals = computeUsageTotals(
      {
        Research: u({ cost_usd: 0.5 }),
        Impl: u({ tokens: { input: 1000, cached_input: 0, output: 500 } }),
      },
      { Research: "claude", Impl: "codex" },
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
      { Research: "claude", Impl: "codex" },
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
      { Research: "codex" },
      () => ({ input: 0, cached_input: 0, output: 0 }),
      "default-model",
      { Research: "phase-model" },
    );
    expect(totals.phases.Research.model).toBe("phase-model");
    expect(totals.phases.Impl.model).toBe("default-model");
  });

  it("returns null aggregate tokens when any launched phase has unknown usage", () => {
    const totals = computeUsageTotals(
      {
        Research: u({ tokens: { input: 10, cached_input: 2, output: 3 } }),
        Impl: null,
      },
      { Research: "codex" },
    );

    expect(totals.tokensInput).toBeNull();
    expect(totals.tokensCached).toBeNull();
    expect(totals.tokensOutput).toBeNull();
  });

  // A call_llm block with an explicit model and no provider records no kind,
  // and every in-process LLM call reports tokens with a null cost_usd. Both
  // stay priced by model id, so the run's cost stays known.
  it("prices token-only phases whose provider is Claude or unstated", () => {
    const tokens = { input: 1_000, cached_input: 0, output: 500 };
    const totals = computeUsageTotals(
      { Distill: u({ tokens }), LLM: u({ tokens }) },
      { Distill: "claude", LLM: undefined },
      () => ({ input: 0.001, cached_input: 0, output: 0.002 }),
      undefined,
      { Distill: "claude-haiku-4-5", LLM: "gpt-5-codex" },
    );

    expect(totals.costKnown).toBe(true);
    expect(totals.phases.Distill.costUsd).toBeCloseTo(2, 8);
    expect(totals.phases.LLM.costUsd).toBeCloseTo(2, 8);
    expect(totals.costUsd).toBeCloseTo(4, 8);
  });

  it("matches the canonical Claude and Codex fixtures", () => {
    const totals = computeUsageTotals(
      {
        Claude: u({ cost_usd: 1.234_567_891 }),
        Codex: u({
          tokens: { input: 1_000, cached_input: 400, output: 500 },
        }),
      },
      { Claude: "claude", Codex: "codex" },
      () => ({
        input: 0.000_003,
        cached_input: 0.000_000_7,
        output: 0.000_015,
      }),
      undefined,
      { Codex: "gpt-5-codex" },
    );

    expect(totals.costKnown).toBe(true);
    expect(totals.phases.Claude.costUsd).toBe(1.234_567_891);
    expect(totals.phases.Codex.costUsd).toBe(0.010_78);
    expect(totals.costUsd).toBe(1.245_347_891);
  });
});
