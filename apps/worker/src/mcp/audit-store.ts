import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";

import { env } from "../../env.js";
import type { Db } from "../db/client.js";
import { mcpAuditEvents } from "../db/schema.js";
import type { McpAuditInput } from "./contracts.js";
import { MCP_CONTRACT_HASH } from "./sanitize-result.js";

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
  const retentionDays = options.retentionDays ?? env.MCP_AUDIT_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const due = await db
    .select({ id: mcpAuditEvents.id })
    .from(mcpAuditEvents)
    .where(lt(mcpAuditEvents.occurredAt, cutoff))
    .orderBy(asc(mcpAuditEvents.occurredAt))
    .limit(options.limit ?? PRUNE_BATCH_LIMIT);
  if (due.length === 0) return { deleted: 0 };

  // Counted from what the delete actually removed, so a concurrent tick that
  // already took some of this batch cannot inflate the reported number.
  const deleted = await db
    .delete(mcpAuditEvents)
    .where(
      inArray(
        mcpAuditEvents.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: mcpAuditEvents.id });
  return { deleted: deleted.length };
}

export async function writeMcpAudit(db: Db, event: McpAuditInput): Promise<void> {
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
