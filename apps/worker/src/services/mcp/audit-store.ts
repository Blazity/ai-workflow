import { randomUUID } from "node:crypto";
import type { Db } from "../../db/types.js";
import {
  insertConnectedMcpAuditEvent,
  insertMcpAuditEvent,
  listMcpAuditEvents,
  pruneConnectedMcpAuditEvents,
  pruneMcpAuditEvents,
} from "../../db/repositories/mcp.js";
import { mcpSettings } from "../settings/index.js";
import type { McpAuditInput } from "./contracts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH_LIMIT = 100;

// Retention sweep for the cron to call. It stays off the request path and
// deletes one bounded batch per call: the bare occurred_at cutoff misses the
// organization-led index, so an unbounded delete degrades to a full scan, and
// this one runs every minute. Oldest first, so repeated ticks converge.
export async function pruneMcpAudits(
  db: Db,
  now: Date,
  options: { retentionDays?: number; limit?: number } = {},
): Promise<{ deleted: number }> {
  const retentionDays = options.retentionDays ?? mcpSettings().auditRetentionDays;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  return {
    deleted: await pruneMcpAuditEvents(db, {
      cutoff,
      limit: options.limit ?? PRUNE_BATCH_LIMIT,
    }),
  };
}

export async function pruneConnectedMcpAudits(
  now: Date,
  options: { retentionDays?: number; limit?: number } = {},
): Promise<{ deleted: number }> {
  const retentionDays = options.retentionDays ?? mcpSettings().auditRetentionDays;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  return {
    deleted: await pruneConnectedMcpAuditEvents({
      cutoff,
      limit: options.limit ?? PRUNE_BATCH_LIMIT,
    }),
  };
}

export async function writeMcpAudit(db: Db, event: McpAuditInput): Promise<void> {
  await insertMcpAuditEvent(db, {
    id: randomUUID(),
    requestId: event.requestId,
    traceId: event.traceId,
    organizationId: event.actor.organizationId,
    actorSubject: event.actor.subject,
    clientId: event.actor.clientId,
    role: event.actor.role,
    scopes: [...event.actor.scopes].sort(),
    toolName: event.toolName,
    mutationClass: event.mutationClass,
    targetRefs: [...event.targetRefs],
    inputHash: event.inputHash,
    outputHash: event.outputHash,
    idempotencyKeyHash: event.idempotencyKeyHash,
    outcome: event.outcome,
    errorCode: event.errorCode,
    latencyMs: event.latencyMs,
    serverVersion: process.env.MCP_SERVER_VERSION ?? "0.1.0",
    contractHash: event.contractHash,
    occurredAt: event.occurredAt,
  });
}

export async function writeConnectedMcpAudit(event: McpAuditInput): Promise<void> {
  await insertConnectedMcpAuditEvent({
    id: randomUUID(),
    requestId: event.requestId,
    traceId: event.traceId,
    organizationId: event.actor.organizationId,
    actorSubject: event.actor.subject,
    clientId: event.actor.clientId,
    role: event.actor.role,
    scopes: [...event.actor.scopes].sort(),
    toolName: event.toolName,
    mutationClass: event.mutationClass,
    targetRefs: [...event.targetRefs],
    inputHash: event.inputHash,
    outputHash: event.outputHash,
    idempotencyKeyHash: event.idempotencyKeyHash,
    outcome: event.outcome,
    errorCode: event.errorCode,
    latencyMs: event.latencyMs,
    serverVersion: process.env.MCP_SERVER_VERSION ?? "0.1.0",
    contractHash: event.contractHash,
    occurredAt: event.occurredAt,
  });
}

export async function listMcpAuditsForOrganization(
  db: Db,
  organizationId: string,
  filter: { since: Date },
) {
  return listMcpAuditEvents(db, { organizationId, since: filter.since });
}
