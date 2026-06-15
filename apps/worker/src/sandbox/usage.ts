import type { PhaseUsage } from "./agents/types.js";
import type { TokenPrice } from "./agents/pricing.js";

export type { PhaseUsage } from "./agents/types.js";
export type { TokenPrice };

export type PriceLookup = (model: string) => TokenPrice | null;

/**
 * Slack-friendly usage line. Computes Codex costs from tokens when a price
 * is available; falls back to "cost unknown" for Codex without pricing.
 *
 * For each phase:
 *   - cost_usd != null → use it directly (Claude path)
 *   - tokens != null + priceLookup yields a price → compute cost
 *   - else → tokens-only, marked "cost unknown"
 */
export function formatUsageReport(
  phases: Record<string, PhaseUsage | null>,
  priceLookup?: PriceLookup,
  model?: string,
): string {
  const parts: string[] = [];
  let totalCost = 0;
  let anyUnknown = false;

  for (const [name, usage] of Object.entries(phases)) {
    if (!usage) { parts.push(`${name}: n/a`); continue; }
    const mins = Math.round(usage.duration_ms / 60_000);
    let costLabel: string;
    if (usage.cost_usd != null) {
      totalCost += usage.cost_usd;
      costLabel = `$${usage.cost_usd.toFixed(2)}`;
    } else if (usage.tokens && priceLookup && model) {
      const price = priceLookup(model);
      if (price) {
        const cost = usage.tokens.input * price.input
                   + usage.tokens.cached_input * price.cached_input
                   + usage.tokens.output * price.output;
        totalCost += cost;
        costLabel = `$${cost.toFixed(2)}`;
      } else {
        anyUnknown = true;
        costLabel = `${usage.tokens.input}/${usage.tokens.output} tok (cost unknown)`;
      }
    } else if (usage.tokens) {
      anyUnknown = true;
      costLabel = `${usage.tokens.input}/${usage.tokens.output} tok (cost unknown)`;
    } else {
      anyUnknown = true;
      costLabel = "cost unknown";
    }
    parts.push(`${name}: ${costLabel} (${mins}m)`);
  }

  const total = anyUnknown ? `$${totalCost.toFixed(2)}+ total` : `$${totalCost.toFixed(2)} total`;
  return `Usage: ${total} | ${parts.join(" | ")}`;
}

/** Cost of a single phase in USD, or null when it can't be priced. Mirrors the
 * selection rule in formatUsageReport: Claude reports cost_usd directly; Codex
 * is priced from tokens when a lookup is available; otherwise unknown. */
export function phaseCostUsd(
  usage: PhaseUsage,
  priceLookup?: PriceLookup,
  model?: string,
): { costUsd: number | null; known: boolean } {
  if (usage.cost_usd != null) return { costUsd: usage.cost_usd, known: true };
  if (usage.tokens && priceLookup && model) {
    const price = priceLookup(model);
    if (price) {
      const cost =
        usage.tokens.input * price.input +
        usage.tokens.cached_input * price.cached_input +
        usage.tokens.output * price.output;
      return { costUsd: cost, known: true };
    }
  }
  return { costUsd: null, known: false };
}

export interface PhaseTotal {
  costUsd: number | null;
  tokens: PhaseUsage["tokens"];
  durationMs: number;
  numTurns: number;
}

export interface UsageTotals {
  /** Sum of every priced phase. */
  costUsd: number;
  /** False if any present phase couldn't be priced — costUsd is then a lower bound. */
  costKnown: boolean;
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
  /** Per-phase breakdown, persisted as the run's `phases` jsonb. */
  phases: Record<string, PhaseTotal>;
}

/** Numeric sibling of formatUsageReport: aggregates accumulated PhaseUsage into
 * the totals + per-phase breakdown the telemetry table stores. */
export function computeUsageTotals(
  phases: Record<string, PhaseUsage | null>,
  priceLookup?: PriceLookup,
  model?: string,
): UsageTotals {
  let costUsd = 0;
  let tokensInput = 0;
  let tokensCached = 0;
  let tokensOutput = 0;
  let costKnown = true;
  const breakdown: Record<string, PhaseTotal> = {};

  for (const [name, usage] of Object.entries(phases)) {
    if (!usage) {
      breakdown[name] = { costUsd: null, tokens: null, durationMs: 0, numTurns: 0 };
      costKnown = false;
      continue;
    }
    const { costUsd: c, known } = phaseCostUsd(usage, priceLookup, model);
    if (c != null) costUsd += c;
    if (!known) costKnown = false;
    if (usage.tokens) {
      tokensInput += usage.tokens.input;
      tokensCached += usage.tokens.cached_input;
      tokensOutput += usage.tokens.output;
    }
    breakdown[name] = {
      costUsd: c,
      tokens: usage.tokens,
      durationMs: usage.duration_ms,
      numTurns: usage.num_turns,
    };
  }

  return { costUsd, costKnown, tokensInput, tokensCached, tokensOutput, phases: breakdown };
}
