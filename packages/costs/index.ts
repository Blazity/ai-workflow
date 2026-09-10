export interface TokenPrice {
  input: number;
  cached_input: number;
  output: number;
}

export interface LiteLlmPriceEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
}

export interface CostTokens {
  input: number;
  cached_input: number;
  output: number;
}

export interface CostUsage {
  cost_usd: number | null;
  tokens: CostTokens | null;
}

export type CostProviderKind = "claude" | "codex";

/**
 * How one phase can be priced. `kind` records which harness produced the usage
 * and never selects the formula: either harness may report a dollar cost, and
 * either may leave a token-only usage that the model's price turns into one.
 * `kind` is absent when the caller could not state a provider, which still
 * prices from `price`. `price` is the phase model's token price when the price
 * table has one.
 */
export interface CostProvider {
  kind?: CostProviderKind;
  price: TokenPrice | null;
}

export type UsageCostResult =
  | { costNanos: number; costUsd: number; known: true }
  | { costNanos: null; costUsd: null; known: false };

export interface AggregatedUsagePhase {
  cost: UsageCostResult;
  tokens: CostTokens | null;
}

export interface UsageAggregateState {
  /** Sum of every known usage cost. */
  costNanos: number;
  costKnown: boolean;
  /** Sum of every valid token count, even when another usage is unknown. */
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
  tokensKnown: boolean;
}

export interface AggregatedUsage extends UsageAggregateState {
  /** Dollar projection of costNanos. */
  costUsd: number;
  phases: Record<string, AggregatedUsagePhase>;
}

const USD_NANOS = 1_000_000_000;
const UNKNOWN_COST: UsageCostResult = {
  costNanos: null,
  costUsd: null,
  known: false,
};

/**
 * Dollars as authoritative integer nanodollars, or null when the value cannot
 * be one. The spend and any limit compared against it must round identically,
 * so both sides call this.
 */
export function usdToNanos(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const nanos = Math.round(value * USD_NANOS);
  return Number.isSafeInteger(nanos) ? nanos : null;
}

function validTokens(tokens: CostTokens | null): tokens is CostTokens {
  return (
    tokens !== null &&
    [tokens.input, tokens.cached_input, tokens.output].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  );
}

function validAggregateNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function knownCost(costNanos: number): UsageCostResult {
  return {
    costNanos,
    costUsd: costNanos / USD_NANOS,
    known: true,
  };
}

/**
 * A phase's cost: the reported dollar amount when the harness gives a usable
 * one, otherwise the model's token price applied to the reported tokens. The
 * order is the same for both providers. A harness that reports tokens and no
 * cost (every in-process LLM call does) must stay priceable, or a run under a
 * cost cap fails as unverifiable.
 */
export function costForUsage(
  provider: CostProvider,
  usage: CostUsage,
): UsageCostResult {
  if (typeof usage.cost_usd === "number" && usage.cost_usd >= 0) {
    const costNanos = usdToNanos(usage.cost_usd);
    return costNanos === null ? UNKNOWN_COST : knownCost(costNanos);
  }

  if (!validTokens(usage.tokens) || provider.price === null) return UNKNOWN_COST;
  const inputNanos = usdToNanos(provider.price.input);
  const cachedInputNanos = usdToNanos(provider.price.cached_input);
  const outputNanos = usdToNanos(provider.price.output);
  if (inputNanos === null || cachedInputNanos === null || outputNanos === null) {
    return UNKNOWN_COST;
  }

  const costNanos =
    usage.tokens.input * inputNanos +
    usage.tokens.cached_input * cachedInputNanos +
    usage.tokens.output * outputNanos;
  return Number.isSafeInteger(costNanos) ? knownCost(costNanos) : UNKNOWN_COST;
}

export function aggregateUsage(
  phases: Readonly<Record<string, CostUsage | null>>,
  providersByPhase: Readonly<Record<string, CostProvider | undefined>>,
  initial?: UsageAggregateState,
): AggregatedUsage {
  const priorCostNanos = initial?.costNanos ?? 0;
  const priorInput = initial?.tokensInput ?? 0;
  const priorCached = initial?.tokensCached ?? 0;
  const priorOutput = initial?.tokensOutput ?? 0;
  const initialCostValid = validAggregateNumber(priorCostNanos);
  const initialTokensValid = [priorInput, priorCached, priorOutput].every(
    (value) => validAggregateNumber(value),
  );
  // A prior total that fails validation is still what the caller has spent.
  // Keep it and clear only the known flag: restarting the running total at 0
  // would report a fraction of a run's real cost as if it were the whole.
  let costNanos = priorCostNanos;
  let tokensInput = priorInput;
  let tokensCached = priorCached;
  let tokensOutput = priorOutput;
  let tokensKnown = (initial?.tokensKnown ?? true) && initialTokensValid;
  let costKnown = (initial?.costKnown ?? true) && initialCostValid;
  const breakdown: Record<string, AggregatedUsagePhase> = {};

  for (const [name, usage] of Object.entries(phases)) {
    const provider = providersByPhase[name];
    const cost = usage && provider ? costForUsage(provider, usage) : UNKNOWN_COST;
    if (cost.costNanos !== null) {
      const nextCostNanos = costNanos + cost.costNanos;
      if (Number.isSafeInteger(nextCostNanos)) {
        costNanos = nextCostNanos;
      } else {
        costKnown = false;
      }
    }
    if (!cost.known) costKnown = false;

    if (usage && validTokens(usage.tokens)) {
      const nextInput = tokensInput + usage.tokens.input;
      const nextCached = tokensCached + usage.tokens.cached_input;
      const nextOutput = tokensOutput + usage.tokens.output;
      if (
        Number.isSafeInteger(nextInput) &&
        Number.isSafeInteger(nextCached) &&
        Number.isSafeInteger(nextOutput)
      ) {
        tokensInput = nextInput;
        tokensCached = nextCached;
        tokensOutput = nextOutput;
      } else {
        tokensKnown = false;
      }
    } else {
      tokensKnown = false;
    }

    breakdown[name] = {
      cost,
      tokens: usage?.tokens ?? null,
    };
  }

  return {
    costNanos,
    costUsd: costNanos / USD_NANOS,
    costKnown,
    tokensInput,
    tokensCached,
    tokensOutput,
    tokensKnown,
    phases: breakdown,
  };
}

export function normalizeLiteLlmPriceTable(
  value: unknown,
): Record<string, TokenPrice> {
  if (typeof value !== "object" || value === null) return {};

  const prices: Record<string, TokenPrice> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const entry = candidate as LiteLlmPriceEntry;
    const input = entry.input_cost_per_token;
    const output = entry.output_cost_per_token;
    if (typeof input !== "number" || typeof output !== "number") continue;
    prices[name] = {
      input,
      output,
      cached_input:
        typeof entry.cache_read_input_token_cost === "number"
          ? entry.cache_read_input_token_cost
          : 0,
    };
  }
  return prices;
}
