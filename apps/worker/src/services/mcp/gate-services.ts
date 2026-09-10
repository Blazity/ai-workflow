/**
 * The three ledgers every MCP call passes through, bound to one handle.
 *
 * Audit, rate limit and idempotency are not what a tool does; they are what is
 * recorded and spent whatever the tool does, and every call writes all three
 * whether it reads or mutates. They are separated from the tool operations so
 * that the list of things a tool may reach stays a list of tool operations.
 */
import type { Db } from "../../db/client.js";
import { writeMcpAudit } from "./audit-store.js";
import type {
  IdempotencyInput,
  McpActorContext,
  McpAuditInput,
  McpAuditToolName,
} from "./contracts.js";
import {
  beginMcpMutation,
  completeMcpMutation,
  failMcpMutation,
  releaseMcpMutation,
} from "./idempotency-store.js";
import {
  consumeMcpRateLimit,
  type McpRateLimitVerdict,
} from "./rate-limit-store.js";

export interface McpGateServices {
  /** Append one audit row. Fail-closed for every tool class, reads included. */
  writeAudit(row: McpAuditInput): Promise<void>;
  /** Spend one unit of the caller's per-window budget. */
  consumeRateLimit(input: {
    actor: McpActorContext;
    toolName: McpAuditToolName;
    limit: number;
    now: Date;
  }): Promise<McpRateLimitVerdict>;
  /** Take, or replay, the idempotency key a mutation was sent with. */
  beginMutation<T>(
    input: IdempotencyInput,
  ): Promise<{ kind: "execute"; leaseId: string } | { kind: "replay"; response: T }>;
  completeMutation<T>(leaseId: string, response: T, now: Date): Promise<void>;
  failMutation(
    leaseId: string,
    errorCode: Parameters<typeof failMcpMutation>[2],
    now: Date,
  ): Promise<void>;
  releaseMutation(leaseId: string): Promise<void>;
}

export function createMcpGateServices(db: Db): McpGateServices {
  return {
    writeAudit: (row) => writeMcpAudit(db, row),
    consumeRateLimit: (input) => consumeMcpRateLimit({ db, ...input }),
    beginMutation: <T,>(input: IdempotencyInput) => beginMcpMutation<T>(db, input),
    completeMutation: <T,>(leaseId: string, response: T, now: Date) =>
      completeMcpMutation<T>(db, leaseId, response, now),
    failMutation: (leaseId, errorCode, now) =>
      failMcpMutation(db, leaseId, errorCode, now),
    releaseMutation: (leaseId) => releaseMcpMutation(db, leaseId),
  };
}
