import {
  aggregateUsage,
  type CostProvider,
  type CostProviderKind,
  type TokenPrice,
} from "@shared/costs";
import type { PhaseUsage } from "./agents/types.js";

export type { PhaseUsage } from "./agents/types.js";
;

export type PriceLookup = (model: string) => TokenPrice | null;
export type PhaseProviders = Record<string, CostProviderKind | undefined>;

/**
 * Every phase carries the price of its model, whichever provider ran it and
 * whether or not the caller could name one: a phase that reports tokens and no
 * dollar cost is priced from that table, exactly as before the extraction.
 */
function resolveCostProvider(
  priceLookup: PriceLookup | undefined,
  model: string | undefined,
): CostProvider {
  return {
    price: priceLookup && model ? priceLookup(model) : null,
  };
}

function costProvidersForPhases(
  phases: Record<string, PhaseUsage | null>,
  _providersByPhase: PhaseProviders,
  priceLookup?: PriceLookup,
  model?: string,
  modelsByPhase?: Record<string, string>,
): Record<string, CostProvider> {
  return Object.fromEntries(
    Object.keys(phases).map((name) => [
      name,
      resolveCostProvider(
        priceLookup,
        modelsByPhase?.[name] ?? model,
      ),
    ]),
  );
}

/**
 * Slack-friendly usage line over the canonical provider cost calculation.
 */
export function formatUsageReport(
  phases: Record<string, PhaseUsage | null>,
  providersByPhase: PhaseProviders,
  priceLookup?: PriceLookup,
  model?: string,
  modelsByPhase?: Record<string, string>,
): string {
  const parts: string[] = [];
  const totals = aggregateUsage(
    phases,
    costProvidersForPhases(
      phases,
      providersByPhase,
      priceLookup,
      model,
      modelsByPhase,
    ),
  );

  for (const [name, usage] of Object.entries(phases)) {
    if (!usage) { parts.push(`${name}: n/a`); continue; }
    const mins = Math.round(usage.duration_ms / 60_000);
    const cost = totals.phases[name].cost;
    let costLabel: string;
    if (cost.known) {
      costLabel = `$${cost.costUsd.toFixed(2)}`;
    } else if (usage.tokens) {
      costLabel = `${usage.tokens.input}/${usage.tokens.output} tok (cost unknown)`;
    } else {
      costLabel = "cost unknown";
    }
    parts.push(`${name}: ${costLabel} (${mins}m)`);
  }

  const total = totals.costKnown
    ? `$${totals.costUsd.toFixed(2)} total`
    : `$${totals.costUsd.toFixed(2)}+ total`;
  return `Usage: ${total} | ${parts.join(" | ")}`;
}

interface PhaseTotal {
  costUsd: number | null;
  tokens: PhaseUsage["tokens"];
  durationMs: number;
  numTurns: number;
  model?: string | null;
}

export interface UsageTotals {
  /** Sum of every priced phase. */
  costUsd: number;
  /** False if any present phase couldn't be priced — costUsd is then a lower bound. */
  costKnown: boolean;
  /** Null when any launched phase lacks authoritative token usage. */
  tokensInput: number | null;
  tokensCached: number | null;
  tokensOutput: number | null;
  /** Per-phase breakdown, persisted as the run's `phases` jsonb. */
  phases: Record<string, PhaseTotal>;
}

/** Numeric sibling of formatUsageReport: aggregates accumulated PhaseUsage into
 * the totals + per-phase breakdown the telemetry table stores. */
export function computeUsageTotals(
  phases: Record<string, PhaseUsage | null>,
  providersByPhase: PhaseProviders,
  priceLookup?: PriceLookup,
  model?: string,
  modelsByPhase?: Record<string, string>,
): UsageTotals {
  const totals = aggregateUsage(
    phases,
    costProvidersForPhases(
      phases,
      providersByPhase,
      priceLookup,
      model,
      modelsByPhase,
    ),
  );
  const breakdown: Record<string, PhaseTotal> = {};

  for (const [name, usage] of Object.entries(phases)) {
    const phaseModel = modelsByPhase?.[name] ?? model;
    if (!usage) {
      breakdown[name] = { costUsd: null, tokens: null, durationMs: 0, numTurns: 0, model: phaseModel ?? null };
      continue;
    }
    breakdown[name] = {
      costUsd: totals.phases[name].cost.costUsd,
      tokens: usage.tokens,
      durationMs: usage.duration_ms,
      numTurns: usage.num_turns,
      model: phaseModel ?? null,
    };
  }

  return {
    costUsd: totals.costUsd,
    costKnown: totals.costKnown,
    tokensInput: totals.tokensKnown ? totals.tokensInput : null,
    tokensCached: totals.tokensKnown ? totals.tokensCached : null,
    tokensOutput: totals.tokensKnown ? totals.tokensOutput : null,
    phases: breakdown,
  };
}
