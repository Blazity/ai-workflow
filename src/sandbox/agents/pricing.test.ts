import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../env.js", () => ({
  env: {
    CODEX_PRICING_URL: "https://example.test/prices.json",
    CODEX_PRICING_TTL_MS: 3_600_000,
  },
}));

const SAMPLE = {
  "gpt-5-codex": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000007,
  },
};

describe("fetchModelPrice", () => {
  beforeEach(() => { vi.resetModules(); });

  it("normalises LiteLLM JSON to TokenPrice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => SAMPLE,
    }));
    const { fetchModelPrice } = await import("./pricing.js");
    const p = await fetchModelPrice("gpt-5-codex");
    expect(p).toEqual({ input: 0.000003, cached_input: 0.0000007, output: 0.000015 });
  });

  it("returns null on miss", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const { fetchModelPrice } = await import("./pricing.js");
    expect(await fetchModelPrice("unknown")).toBeNull();
  });

  it("returns null on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const { fetchModelPrice } = await import("./pricing.js");
    expect(await fetchModelPrice("any")).toBeNull();
  });

  it("caches successful responses within TTL (one fetch for two calls)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => SAMPLE });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchModelPrice } = await import("./pricing.js");
    await fetchModelPrice("gpt-5-codex");
    await fetchModelPrice("gpt-5-codex");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
