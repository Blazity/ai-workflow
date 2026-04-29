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
