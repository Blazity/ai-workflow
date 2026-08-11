import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  FIRST_SLICE_TOOLS,
  type McpEnvelope,
  type SanitizeOptions,
} from "./contracts.js";

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

export const MCP_CONTRACT_HASH = hashCanonicalJson({
  errors: [
    "UNAUTHENTICATED",
    "INSUFFICIENT_SCOPE",
    "FORBIDDEN",
    "NOT_FOUND",
    "VALIDATION_FAILED",
    "CONFLICT",
    "IDEMPOTENCY_CONFLICT",
    "RATE_LIMITED",
    "DEPENDENCY_UNAVAILABLE",
    "INTERNAL_ERROR",
  ],
  tools: FIRST_SLICE_TOOLS,
});

const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const CONTROL_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const BEARER_CREDENTIAL = /(Authorization\s*:\s*Bearer\s+)[^\s"'\\]+/giu;
const GITHUB_CREDENTIAL = /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gu;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu;

function replaceCounted(
  value: string,
  pattern: RegExp | string,
  replacement: string | ((substring: string, ...args: string[]) => string),
  count: { value: number },
): string {
  if (typeof pattern === "string") {
    if (pattern.length === 0) return value;
    let offset = 0;
    while ((offset = value.indexOf(pattern, offset)) !== -1) {
      count.value += 1;
      offset += pattern.length;
    }
    return value.split(pattern).join(replacement as string);
  }
  return value.replace(pattern, (...args: [string, ...string[]]) => {
    count.value += 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
}

function sanitizeString(
  input: string,
  secrets: readonly string[],
  redactions: { value: number },
): string {
  let value = Buffer.from(input, "utf8").toString("utf8");
  value = replaceCounted(value, PRIVATE_KEY, "[REDACTED]", redactions);
  value = replaceCounted(
    value,
    BEARER_CREDENTIAL,
    (_match, prefix) => `${prefix}[REDACTED]`,
    redactions,
  );
  value = replaceCounted(value, GITHUB_CREDENTIAL, "[REDACTED]", redactions);
  for (const secret of secrets) {
    value = replaceCounted(value, secret, "[REDACTED]", redactions);
  }
  value = replaceCounted(value, ANSI_SEQUENCE, "", redactions);
  value = replaceCounted(value, CONTROL_BYTES, "", redactions);
  return value;
}

function sanitizeValue(
  input: unknown,
  secrets: readonly string[],
  redactions: { value: number },
  seen: WeakSet<object>,
): unknown {
  if (typeof input === "string") return sanitizeString(input, secrets, redactions);
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) {
    if (seen.has(input)) return "[REDACTED]";
    seen.add(input);
    return input.map((item) => sanitizeValue(item, secrets, redactions, seen));
  }
  if (input && typeof input === "object") {
    if (seen.has(input)) return "[REDACTED]";
    seen.add(input);
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        sanitizeString(key, secrets, redactions),
        sanitizeValue(value, secrets, redactions, seen),
      ]),
    );
  }
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "number" && !Number.isFinite(input)) return null;
  if (input === undefined || typeof input === "function" || typeof input === "symbol") {
    return null;
  }
  return input;
}

export function sanitizeMcpData<T>(data: T, options: SanitizeOptions): McpEnvelope<T> {
  const redactions = { value: 0 };
  const sanitized = sanitizeValue(
    data,
    options.secrets?.filter((secret) => secret.length > 0) ?? [],
    redactions,
    new WeakSet(),
  ) as T;
  const baseMeta: McpEnvelope<T>["meta"] = {
    requestId: options.requestId,
    traceId: options.traceId,
    serverVersion: process.env.MCP_SERVER_VERSION ?? "0.1.0",
    contractHash: MCP_CONTRACT_HASH,
    trust: options.trust,
    truncated: false,
    redactions: redactions.value,
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
  };
  const envelope: McpEnvelope<T> = { data: sanitized, meta: baseMeta };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") <= options.maxBytes) {
    return envelope;
  }

  const digest = `sha256:${hashCanonicalJson(sanitized)}`;
  return {
    data: { digest, truncated: true } as T,
    meta: {
      ...baseMeta,
      truncated: true,
      nextCursor: options.nextCursor ?? digest,
    },
  };
}
