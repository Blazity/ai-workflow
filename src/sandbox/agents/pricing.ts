export interface TokenPrice {
  input: number;
  cached_input: number;
  output: number;
}

interface CacheEntry {
  fetchedAt: number;
  data: Record<string, TokenPrice>;
}
let cache: CacheEntry | null = null;

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
}

async function loadAll(): Promise<Record<string, TokenPrice> | null> {
  const { env } = await import("../../../env.js");
  const ttl = env.CODEX_PRICING_TTL_MS;
  if (cache && Date.now() - cache.fetchedAt < ttl) return cache.data;

  try {
    const r = await fetch(env.CODEX_PRICING_URL);
    if (!r.ok) return null;
    const json = await r.json();
    const out: Record<string, TokenPrice> = {};
    for (const [name, entry] of Object.entries(json as Record<string, LiteLLMEntry>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const input = entry.input_cost_per_token;
      const output = entry.output_cost_per_token;
      if (typeof input !== "number" || typeof output !== "number") continue;
      out[name] = {
        input,
        output,
        cached_input: typeof entry.cache_read_input_token_cost === "number"
          ? entry.cache_read_input_token_cost
          : 0,
      };
    }
    cache = { fetchedAt: Date.now(), data: out };
    return out;
  } catch {
    return null;
  }
}

export async function fetchModelPrice(model: string): Promise<TokenPrice | null> {
  const all = await loadAll();
  return all?.[model] ?? null;
}

/** Test-only: clear the in-memory cache. */
export function _resetPricingCache(): void { cache = null; }
