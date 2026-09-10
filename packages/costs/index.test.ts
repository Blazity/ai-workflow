import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateUsage,
  costForUsage,
  normalizeLiteLlmPriceTable,
  type CostProvider,
  type CostUsage,
} from "./index";

const claudeUsage: CostUsage = {
  cost_usd: 1.234_567_891,
  tokens: null,
};

const codexUsage: CostUsage = {
  cost_usd: null,
  tokens: { input: 1_000, cached_input: 400, output: 500 },
};

const codexProvider: CostProvider = {
  kind: "codex",
  price: {
    input: 0.000_003,
    cached_input: 0.000_000_7,
    output: 0.000_015,
  },
};

/** The in-process LLM path reports tokens and no cost on either provider. */
const claudeTokenOnlyProvider: CostProvider = {
  kind: "claude",
  price: codexProvider.price,
};

describe("costForUsage", () => {
  it("uses Claude's literal reported cost", () => {
    assert.deepEqual(costForUsage({ kind: "claude", price: null }, claudeUsage), {
      costNanos: 1_234_567_891,
      costUsd: 1.234_567_891,
      known: true,
    });
  });

  it("derives cost from literal token counts and prices when no cost is reported", () => {
    // 1000 * 0.000003 + 400 * 0.0000007 + 500 * 0.000015 = 0.01078.
    const priced = {
      costNanos: 10_780_000,
      costUsd: 0.010_78,
      known: true,
    };
    assert.deepEqual(costForUsage(codexProvider, codexUsage), priced);
    // The declared provider never selects the formula: a Claude phase with
    // tokens and no reported cost is priced from the same table.
    assert.deepEqual(costForUsage(claudeTokenOnlyProvider, codexUsage), priced);
    // A phase whose provider was never stated prices by model price alone.
    assert.deepEqual(costForUsage({ price: codexProvider.price }, codexUsage), priced);
  });

  it("returns unknown for missing provider data or invalid numbers", () => {
    const unknown = { costNanos: null, costUsd: null, known: false };
    assert.deepEqual(
      costForUsage({ kind: "claude", price: null }, { cost_usd: null, tokens: null }),
      unknown,
    );
    assert.deepEqual(costForUsage({ kind: "codex", price: null }, codexUsage), unknown);
    assert.deepEqual(
      costForUsage({ kind: "claude", price: null }, { cost_usd: Number.NaN, tokens: null }),
      unknown,
    );
    assert.deepEqual(
      costForUsage(codexProvider, {
        cost_usd: null,
        tokens: { input: -1, cached_input: 0, output: 0 },
      }),
      unknown,
    );
    assert.deepEqual(
      costForUsage(
        { kind: "codex", price: { input: Number.POSITIVE_INFINITY, cached_input: 0, output: 0 } },
        codexUsage,
      ),
      unknown,
    );
  });
});

describe("aggregateUsage", () => {
  it("uses the canonical function for each phase and preserves a known subtotal", () => {
    const totals = aggregateUsage(
      {
        Research: claudeUsage,
        Implementation: codexUsage,
        Review: { cost_usd: null, tokens: { input: 10, cached_input: 0, output: 5 } },
        Missing: null,
      },
      {
        Research: { kind: "claude", price: null },
        Implementation: codexProvider,
        Review: { kind: "codex", price: null },
      },
    );

    assert.equal(totals.costNanos, 1_245_347_891);
    assert.equal(totals.costUsd, 1.245_347_891);
    assert.equal(totals.costKnown, false);
    assert.equal(totals.tokensInput, 1_010);
    assert.equal(totals.tokensCached, 400);
    assert.equal(totals.tokensOutput, 505);
    assert.equal(totals.tokensKnown, false);
    assert.deepEqual(totals.phases.Research.cost, {
      costNanos: 1_234_567_891,
      costUsd: 1.234_567_891,
      known: true,
    });
    assert.deepEqual(totals.phases.Implementation.cost, {
      costNanos: 10_780_000,
      costUsd: 0.010_78,
      known: true,
    });
    assert.deepEqual(totals.phases.Review.cost, {
      costNanos: null,
      costUsd: null,
      known: false,
    });
    assert.deepEqual(totals.phases.Missing.cost, {
      costNanos: null,
      costUsd: null,
      known: false,
    });
  });

  it("marks cumulative token overflow unknown when extending prior state", () => {
    const totals = aggregateUsage(
      {
        Next: {
          cost_usd: null,
          tokens: { input: 1, cached_input: 0, output: 0 },
        },
      },
      { Next: { kind: "codex", price: { input: 0, cached_input: 0, output: 0 } } },
      {
        costNanos: 0,
        costKnown: true,
        tokensInput: Number.MAX_SAFE_INTEGER,
        tokensCached: 0,
        tokensOutput: 0,
        tokensKnown: true,
      },
    );

    assert.equal(totals.tokensInput, Number.MAX_SAFE_INTEGER);
    assert.equal(totals.tokensKnown, false);
  });

  it("keeps an invalid prior total instead of restarting it at zero", () => {
    const totals = aggregateUsage(
      { Next: claudeUsage },
      { Next: { kind: "claude", price: null } },
      {
        costNanos: Number.NaN,
        costKnown: true,
        tokensInput: 7,
        tokensCached: 0,
        tokensOutput: 0,
        tokensKnown: true,
      },
    );

    assert.equal(Number.isNaN(totals.costNanos), true);
    assert.equal(totals.costKnown, false);
    // The phase itself is still priced; only the running total is unusable.
    assert.deepEqual(totals.phases.Next.cost, {
      costNanos: 1_234_567_891,
      costUsd: 1.234_567_891,
      known: true,
    });
    assert.equal(totals.tokensInput, 7);
  });
});

describe("normalizeLiteLlmPriceTable", () => {
  it("keeps valid entries, defaults cached input to zero and skips invalid entries", () => {
    assert.deepEqual(
      normalizeLiteLlmPriceTable({
        complete: {
          input_cost_per_token: 0.1,
          output_cost_per_token: 0.2,
          cache_read_input_token_cost: 0.03,
        },
        withoutCache: {
          input_cost_per_token: 0.4,
          output_cost_per_token: 0.5,
        },
        invalid: {
          input_cost_per_token: "0.6",
          output_cost_per_token: 0.7,
        },
      }),
      {
        complete: { input: 0.1, cached_input: 0.03, output: 0.2 },
        withoutCache: { input: 0.4, cached_input: 0, output: 0.5 },
      },
    );
  });
});
