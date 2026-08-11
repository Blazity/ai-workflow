import { Buffer } from "node:buffer";
import { and, eq, lte } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { mcpIdempotencyKeys } from "../db/schema.js";
import {
  McpPublicError,
  type IdempotencyInput,
  type McpErrorCode,
} from "./contracts.js";

type Lease = Omit<IdempotencyInput, "now" | "expiresAt"> & { expiresAt: string };

function namespaceWhere(input: IdempotencyInput | Lease) {
  return and(
    eq(mcpIdempotencyKeys.organizationId, input.organizationId),
    eq(mcpIdempotencyKeys.actorSubject, input.actorSubject),
    eq(mcpIdempotencyKeys.clientId, input.clientId),
    eq(mcpIdempotencyKeys.toolName, input.toolName),
    eq(mcpIdempotencyKeys.idempotencyKey, input.idempotencyKey),
  );
}

function leaseFor(input: IdempotencyInput): string {
  const lease: Lease = {
    organizationId: input.organizationId,
    actorSubject: input.actorSubject,
    clientId: input.clientId,
    toolName: input.toolName,
    idempotencyKey: input.idempotencyKey,
    payloadHash: input.payloadHash,
    expiresAt: input.expiresAt.toISOString(),
  };
  return Buffer.from(JSON.stringify(lease), "utf8").toString("base64url");
}

function parseLease(leaseId: string): Lease {
  try {
    const parsed = JSON.parse(Buffer.from(leaseId, "base64url").toString("utf8")) as Lease;
    if (
      !parsed ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.actorSubject !== "string" ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.toolName !== "string" ||
      typeof parsed.idempotencyKey !== "string" ||
      typeof parsed.payloadHash !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      !Number.isFinite(new Date(parsed.expiresAt).getTime())
    ) {
      throw new Error("invalid lease");
    }
    return parsed;
  } catch {
    throw new McpPublicError("INTERNAL_ERROR", "Invalid mutation lease", false);
  }
}

function retryableCode(code: McpErrorCode): boolean {
  return code === "DEPENDENCY_UNAVAILABLE" || code === "RATE_LIMITED";
}

function safeReplayMessage(code: McpErrorCode): string {
  switch (code) {
    case "DEPENDENCY_UNAVAILABLE":
      return "Dependency unavailable";
    case "RATE_LIMITED":
      return "Rate limit exceeded";
    case "CONFLICT":
      return "Conflict";
    case "IDEMPOTENCY_CONFLICT":
      return "Idempotency conflict";
    case "FORBIDDEN":
    case "INSUFFICIENT_SCOPE":
      return "Access denied";
    case "NOT_FOUND":
      return "Not found";
    case "VALIDATION_FAILED":
      return "Validation failed";
    case "UNAUTHENTICATED":
      return "Authentication required";
    case "INTERNAL_ERROR":
      return "Internal error";
  }
}

export async function beginMcpMutation<T>(
  db: Db,
  input: IdempotencyInput,
): Promise<{ kind: "execute"; leaseId: string } | { kind: "replay"; response: T }> {
  const inserted = await db
    .insert(mcpIdempotencyKeys)
    .values({
      organizationId: input.organizationId,
      actorSubject: input.actorSubject,
      clientId: input.clientId,
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      state: "started",
      safeResponse: null,
      errorCode: null,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning({ payloadHash: mcpIdempotencyKeys.payloadHash });
  if (inserted.length > 0) return { kind: "execute", leaseId: leaseFor(input) };

  const existingRows = await db
    .select()
    .from(mcpIdempotencyKeys)
    .where(namespaceWhere(input))
    .limit(1);
  let existing = existingRows[0];
  if (!existing) {
    throw new McpPublicError("CONFLICT", "Concurrent mutation, retry", true);
  }

  if (existing.expiresAt.getTime() <= input.now.getTime()) {
    const reclaimed = await db
      .update(mcpIdempotencyKeys)
      .set({
        payloadHash: input.payloadHash,
        state: "started",
        safeResponse: null,
        errorCode: null,
        expiresAt: input.expiresAt,
      })
      .where(
        and(namespaceWhere(input), lte(mcpIdempotencyKeys.expiresAt, input.now)),
      )
      .returning();
    if (reclaimed.length > 0) return { kind: "execute", leaseId: leaseFor(input) };
    const refreshed = await db
      .select()
      .from(mcpIdempotencyKeys)
      .where(namespaceWhere(input))
      .limit(1);
    existing = refreshed[0];
    if (!existing) throw new McpPublicError("CONFLICT", "Concurrent mutation, retry", true);
  }

  if (existing.payloadHash !== input.payloadHash) {
    throw new McpPublicError(
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key was used with a different payload",
      false,
    );
  }
  if (existing.state === "completed") {
    return { kind: "replay", response: existing.safeResponse as T };
  }
  if (existing.state === "failed") {
    const code = (existing.errorCode ?? "INTERNAL_ERROR") as McpErrorCode;
    throw new McpPublicError(code, safeReplayMessage(code), retryableCode(code));
  }
  throw new McpPublicError("CONFLICT", "Mutation is still in progress; retry", true);
}

export async function completeMcpMutation<T>(
  db: Db,
  leaseId: string,
  response: T,
): Promise<void> {
  const lease = parseLease(leaseId);
  const updated = await db
    .update(mcpIdempotencyKeys)
    .set({ state: "completed", safeResponse: response, errorCode: null })
    .where(
      and(
        namespaceWhere(lease),
        eq(mcpIdempotencyKeys.payloadHash, lease.payloadHash),
        eq(mcpIdempotencyKeys.expiresAt, new Date(lease.expiresAt)),
        eq(mcpIdempotencyKeys.state, "started"),
      ),
    )
    .returning({ state: mcpIdempotencyKeys.state });
  if (updated.length === 0) {
    throw new McpPublicError("CONFLICT", "Mutation lease is no longer active", true);
  }
}

export async function failMcpMutation(
  db: Db,
  leaseId: string,
  errorCode: McpErrorCode,
): Promise<void> {
  const lease = parseLease(leaseId);
  const updated = await db
    .update(mcpIdempotencyKeys)
    .set({ state: "failed", safeResponse: null, errorCode })
    .where(
      and(
        namespaceWhere(lease),
        eq(mcpIdempotencyKeys.payloadHash, lease.payloadHash),
        eq(mcpIdempotencyKeys.expiresAt, new Date(lease.expiresAt)),
        eq(mcpIdempotencyKeys.state, "started"),
      ),
    )
    .returning({ state: mcpIdempotencyKeys.state });
  if (updated.length === 0) {
    throw new McpPublicError("CONFLICT", "Mutation lease is no longer active", true);
  }
}
