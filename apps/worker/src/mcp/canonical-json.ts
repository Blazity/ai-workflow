import { createHash } from "node:crypto";

/**
 * Canonical JSON and its digest, lifted out of sanitize-result.ts so the contract
 * artifact can hash the tool surface without an import cycle: contract-artifact.ts
 * needs the digest, and sanitize-result.ts needs the contract hash the artifact
 * produces. Both now depend on this leaf instead of on each other.
 *
 * sanitize-result.ts re-exports both functions, so its existing callers
 * (transport.ts, execute-tool.ts, tools/workflows.ts) are untouched.
 */

type JsonPrimitive = string | number | boolean | null;
type CanonicalValue = JsonPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown, inArray = false): CanonicalValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item, true) ?? null);
  }
  if (typeof value === "object") {
    const toJson = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJson === "function") return canonicalValue(toJson.call(value), inArray);
    const sorted: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      const normalized = canonicalValue((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) sorted[key] = normalized;
    }
    return sorted;
  }
  return inArray ? null : undefined;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value) ?? null);
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
