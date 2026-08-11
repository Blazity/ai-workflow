import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { mcpAuditEvents } from "../db/schema.js";
import type { McpAuditInput } from "./contracts.js";
import { MCP_CONTRACT_HASH } from "./sanitize-result.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function pruneMcpAudits(
  db: Db,
  now: Date,
  retentionDays = Number(process.env.MCP_AUDIT_RETENTION_DAYS ?? 365),
): Promise<void> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  await db.delete(mcpAuditEvents).where(lt(mcpAuditEvents.occurredAt, cutoff));
}

export async function writeMcpAudit(db: Db, event: McpAuditInput): Promise<void> {
  await pruneMcpAudits(db, event.occurredAt);
  await db.insert(mcpAuditEvents).values({
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
    contractHash: MCP_CONTRACT_HASH,
    occurredAt: event.occurredAt,
  });
}

export async function listMcpAuditsForOrganization(
  db: Db,
  organizationId: string,
  filter: { since: Date },
) {
  return db
    .select()
    .from(mcpAuditEvents)
    .where(
      and(
        eq(mcpAuditEvents.organizationId, organizationId),
        gte(mcpAuditEvents.occurredAt, filter.since),
      ),
    )
    .orderBy(desc(mcpAuditEvents.occurredAt));
}
