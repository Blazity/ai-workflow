// Seeded so values are identical across SSR and client renders — Math.random
// would mismatch (hydration errors) and produce unstable IDs for trace links.

/** mulberry32 — small, fast, seedable PRNG returning floats in [0, 1). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic, plausible-looking series for decorative sparklines.
 * Same seed → same array, on both server and client.
 */
export function sparkSeries(seed: number, n: number, base = 0.5, amp = 0.5): number[] {
  const r = makeRng(seed * 2654435761);
  return Array.from(
    { length: n },
    (_, i) => base + Math.sin(i * 0.5 + seed) * amp * 0.55 + r() * amp,
  );
}

/** Deterministic jitter around a center value (used for eval mini-sparklines). */
export function jitterSeries(seed: number, n: number, center: number, spread: number): number[] {
  const r = makeRng(seed * 40503 + 7);
  return Array.from({ length: n }, () => center + (r() - 0.5) * spread);
}
