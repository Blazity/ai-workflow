import {
  normalizeLiteLlmPriceTable,
  type TokenPrice,
} from "@shared/costs";

interface CacheEntry {
  fetchedAt: number;
  data: Record<string, TokenPrice>;
}
let cache: CacheEntry | null = null;

async function loadAll(): Promise<Record<string, TokenPrice> | null> {
  const { env } = await import("../../infra/vcs-config.js");
  const ttl = env.CODEX_PRICING_TTL_MS;
  if (cache && Date.now() - cache.fetchedAt < ttl) return cache.data;

  try {
    const r = await fetch(env.CODEX_PRICING_URL);
    if (!r.ok) return null;
    const out = normalizeLiteLlmPriceTable(await r.json());
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
