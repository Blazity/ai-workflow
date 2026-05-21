import { createHash } from "node:crypto";
import type { CheckCacheManifest } from "./types.js";

const MANIFEST_OPEN = "<!-- ai-workflow-cache";
const MANIFEST_CLOSE = "-->";
/** Hard cap to defend against pathological output_text values. */
const MAX_MANIFEST_BYTES = 32_000;

export function serializeCacheManifest(manifest: CheckCacheManifest): string {
  // Format:
  //   <!-- ai-workflow-cache
  //   {...json...}
  //   -->
  return `${MANIFEST_OPEN}\n${JSON.stringify(manifest)}\n${MANIFEST_CLOSE}`;
}

/**
 * Parse a cache manifest out of an arbitrary text blob (Check Run output.text).
 * Returns null for any of:
 * - text is null/empty
 * - no marker found
 * - JSON is malformed
 * - manifest is too large
 * - cache_version != 1
 * - shape does not match (defensive)
 */
export function parseCacheManifest(text: string | null | undefined): CheckCacheManifest | null {
  if (!text) return null;
  const start = text.indexOf(MANIFEST_OPEN);
  if (start < 0) return null;
  const after = start + MANIFEST_OPEN.length;
  const end = text.indexOf(MANIFEST_CLOSE, after);
  if (end < 0) return null;
  const body = text.slice(after, end).trim();
  if (Buffer.byteLength(body, "utf8") > MAX_MANIFEST_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isValidManifest(parsed)) return null;
  return parsed as CheckCacheManifest;
}

function isValidManifest(value: unknown): value is CheckCacheManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.cache_version !== 1) return false;
  if (typeof v.check_id !== "string") return false;
  if (typeof v.config_hash !== "string") return false;
  if (typeof v.files !== "object" || v.files === null) return false;
  for (const [path, entry] of Object.entries(v.files as Record<string, unknown>)) {
    if (typeof path !== "string") return false;
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.content_hash !== "string") return false;
    if (e.status !== "completed" && e.status !== "skipped" && e.status !== "failed") return false;
    if (typeof e.finding_count !== "number") return false;
    if (e.previous_check_run_id !== undefined && typeof e.previous_check_run_id !== "number") return false;
  }
  return true;
}

/** Identity check for a cached per-file entry. Returns true only when ALL fields match. */
export interface CacheIdentity {
  config_hash: string;
  check_id: string;
  content_hash: string;
}

export function isCacheEntryValid(
  manifest: CheckCacheManifest,
  path: string,
  identity: CacheIdentity,
): boolean {
  if (manifest.config_hash !== identity.config_hash) return false;
  if (manifest.check_id !== identity.check_id) return false;
  const entry = manifest.files[path];
  if (!entry) return false;
  if (entry.content_hash !== identity.content_hash) return false;
  return entry.status === "completed";
}

/** Stable sha256 of a UTF-8 string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Recursively sort object keys so JSON.stringify is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable hash of an arbitrary JSON-serializable value. Keys are sorted so two
 * objects with the same content but different insertion order produce the same
 * digest.
 */
export function stableHash(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(value)));
}

/**
 * Inputs that uniquely identify the *configuration* under which a per-file AI
 * review result was produced. Combined into a single config_hash that lives at
 * the manifest level — any mismatch invalidates every entry in the manifest.
 *
 * Per spec (docs/superpowers/specs/2026-05-19-pr-review-extensions-design.md
 * line 968-982), a cached result is valid only when ALL of these match:
 * check ID, check kind, AI mode, model, prompt source + prompt hash, relevant
 * params hash, file path, file content hash. The manifest's `check_id`
 * covers check id; `config_hash` (built here) covers the rest at config level;
 * the per-file `content_hash` covers the file content.
 */
export interface AiReviewIdentityInputs {
  check_kind: string;
  ai_mode: string;
  model: string;
  prompt_source_id: string;
  prompt_hash: string;
  /** Relevant subset of params that affects output (data list, limits, etc.). */
  params_subset: unknown;
}

/**
 * Build the config_hash that goes into a per-file AI-review manifest. Any
 * change to model, prompt, mode, or relevant params produces a different hash
 * and therefore invalidates the cache.
 */
export function buildAiReviewConfigHash(inputs: AiReviewIdentityInputs): string {
  return stableHash({
    v: 1,
    check_kind: inputs.check_kind,
    ai_mode: inputs.ai_mode,
    model: inputs.model,
    prompt_source_id: inputs.prompt_source_id,
    prompt_hash: inputs.prompt_hash,
    params: inputs.params_subset,
  });
}
