import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, max, or, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import {
  mcpAuditEvents,
  mcpIdempotencyKeys,
  mcpRateLimitWindows,
  member,
  oauthClient,
  organization,
  promptLibrary,
  promptLibraryVersions,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowRuns,
} from "../schema.js";

function affectedRowCount(result: unknown): number {
  const value = (result as { rows?: Array<{ deleted?: number | string }> }).rows?.[0]?.deleted;
  return typeof value === "number" ? value : Number(value ?? 0);
}

export async function pruneMcpAuditEvents(
  db: Db,
  input: { cutoff: Date; limit: number },
): Promise<number> {
  const result = await db.execute(sql`
    WITH due AS MATERIALIZED (
      SELECT id
      FROM mcp_audit_events
      WHERE occurred_at < ${input.cutoff}
      ORDER BY occurred_at ASC
      LIMIT ${input.limit}
    ), deleted AS (
      DELETE FROM mcp_audit_events event
      USING due
      WHERE event.id = due.id
      RETURNING event.id
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);
  return affectedRowCount(result);
}

export function pruneConnectedMcpAuditEvents(input: Parameters<typeof pruneMcpAuditEvents>[1]) {
  return pruneMcpAuditEvents(getDb(), input);
}

export async function insertMcpAuditEvent(
  db: Db,
  event: typeof mcpAuditEvents.$inferInsert,
): Promise<void> {
  await db.insert(mcpAuditEvents).values(event);
}

export function insertConnectedMcpAuditEvent(event: Parameters<typeof insertMcpAuditEvent>[1]) {
  return insertMcpAuditEvent(getDb(), event);
}

export async function listMcpAuditEvents(
  db: Db,
  input: { organizationId: string; since: Date },
) {
  return db
    .select()
    .from(mcpAuditEvents)
    .where(
      and(
        eq(mcpAuditEvents.organizationId, input.organizationId),
        gte(mcpAuditEvents.occurredAt, input.since),
      ),
    )
    .orderBy(desc(mcpAuditEvents.occurredAt));
}

export async function sweepExpiredMcpRateLimitWindows(db: Db, now: Date): Promise<void> {
  await db.delete(mcpRateLimitWindows).where(lt(mcpRateLimitWindows.expiresAt, now));
}

export function sweepConnectedExpiredMcpRateLimitWindows(now: Date): Promise<void> {
  return sweepExpiredMcpRateLimitWindows(getDb(), now);
}

export async function consumeMcpRateLimitWindow(
  db: Db,
  input: {
    organizationId: string;
    actorSubject: string;
    clientId: string;
    toolName: string;
    windowStartedAt: Date;
    expiresAt: Date;
  },
): Promise<number> {
  const rows = await db
    .insert(mcpRateLimitWindows)
    .values({ ...input, requestCount: 1 })
    .onConflictDoUpdate({
      target: [
        mcpRateLimitWindows.organizationId,
        mcpRateLimitWindows.actorSubject,
        mcpRateLimitWindows.clientId,
        mcpRateLimitWindows.toolName,
        mcpRateLimitWindows.windowStartedAt,
      ],
      set: { requestCount: sql`${mcpRateLimitWindows.requestCount} + 1` },
    })
    .returning({ requestCount: mcpRateLimitWindows.requestCount });
  return rows[0]?.requestCount ?? 1;
}

export function consumeConnectedMcpRateLimitWindow(
  input: Parameters<typeof consumeMcpRateLimitWindow>[1],
): Promise<number> {
  return consumeMcpRateLimitWindow(getDb(), input);
}

export async function findMcpOrganizationBySlug(db: Db, slug: string) {
  const [row] = await db
    .select({ id: organization.id, slug: organization.slug })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function findMcpOauthClient(db: Db, clientId: string) {
  const [row] = await db
    .select({ referenceId: oauthClient.referenceId, scopes: oauthClient.scopes })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return row ?? null;
}

export async function findMcpMemberRole(
  db: Db,
  input: { organizationId: string; userId: string },
) {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, input.organizationId), eq(member.userId, input.userId)))
    .limit(1);
  return row ?? null;
}

export function findConnectedMcpOrganizationBySlug(slug: string) {
  return findMcpOrganizationBySlug(getDb(), slug);
}

export function findConnectedMcpOauthClient(clientId: string) {
  return findMcpOauthClient(getDb(), clientId);
}

export function findConnectedMcpMemberRole(input: Parameters<typeof findMcpMemberRole>[1]) {
  return findMcpMemberRole(getDb(), input);
}

export function listMcpWorkflowDefinitionPage(db: Db, limit: number) {
  return db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      enabled: workflowDefinitions.enabled,
      deployedVersion: workflowDefinitions.deployedVersion,
    })
    .from(workflowDefinitions)
    .where(isNull(workflowDefinitions.archivedAt))
    .orderBy(asc(workflowDefinitions.id))
    .limit(limit + 1);
}

export function readMcpDeployedDefinitionVersions(
  db: Db,
  pairs: readonly { definitionId: number; version: number }[],
) {
  return pairs.length === 0
    ? Promise.resolve([])
    : db
        .select({
          definitionId: workflowDefinitionVersions.definitionId,
          definition: workflowDefinitionVersions.definition,
        })
        .from(workflowDefinitionVersions)
        .where(
          or(
            ...pairs.map((pair) =>
              and(
                eq(workflowDefinitionVersions.definitionId, pair.definitionId),
                eq(workflowDefinitionVersions.version, pair.version),
              ),
            ),
          ),
        );
}

export function listMcpPromptPage(db: Db, limit: number) {
  return db
    .select({ id: promptLibrary.id, slug: promptLibrary.slug, name: promptLibrary.name })
    .from(promptLibrary)
    .where(isNull(promptLibrary.archivedAt))
    .orderBy(asc(promptLibrary.id))
    .limit(limit + 1);
}

export function readMcpPromptHeadVersions(db: Db, promptIds: readonly number[]) {
  if (promptIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      promptId: promptLibraryVersions.promptId,
      currentVersion: max(promptLibraryVersions.version),
    })
    .from(promptLibraryVersions)
    .where(inArray(promptLibraryVersions.promptId, [...promptIds]))
    .groupBy(promptLibraryVersions.promptId);
}

export async function listMcpTicketRunPage(db: Db, ticketKey: string, limit: number) {
  const rows = await db
    .select({
      runId: workflowRuns.runId,
      workflowId: workflowRuns.workflowId,
      workflowName: workflowRuns.workflowName,
      status: workflowRuns.status,
      ticketKey: workflowRuns.ticketKey,
      createdAt: workflowRuns.createdAt,
      firstSeenAt: workflowRuns.firstSeenAt,
      startedAt: workflowRuns.startedAt,
      completedAt: workflowRuns.completedAt,
      durationSec: workflowRuns.durationSec,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.ticketKey, ticketKey))
    .orderBy(sql`coalesce(${workflowRuns.startedAt}, ${workflowRuns.firstSeenAt}) desc`)
    .limit(limit + 1);
  return rows;
}

export function listConnectedMcpWorkflowDefinitionPage(limit: number) {
  return listMcpWorkflowDefinitionPage(getDb(), limit);
}

export function readConnectedMcpDeployedDefinitionVersions(
  pairs: readonly { definitionId: number; version: number }[],
) {
  return readMcpDeployedDefinitionVersions(getDb(), pairs);
}

export function listConnectedMcpPromptPage(limit: number) {
  return listMcpPromptPage(getDb(), limit);
}

export function readConnectedMcpPromptHeadVersions(promptIds: readonly number[]) {
  return readMcpPromptHeadVersions(getDb(), promptIds);
}

export function listConnectedMcpTicketRunPage(ticketKey: string, limit: number) {
  return listMcpTicketRunPage(getDb(), ticketKey, limit);
}

export interface McpIdempotencyIdentity {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: string;
  idempotencyKey: string;
}

function mcpIdempotencyIdentityWhere(input: McpIdempotencyIdentity) {
  return and(
    eq(mcpIdempotencyKeys.organizationId, input.organizationId),
    eq(mcpIdempotencyKeys.actorSubject, input.actorSubject),
    eq(mcpIdempotencyKeys.clientId, input.clientId),
    eq(mcpIdempotencyKeys.toolName, input.toolName),
    eq(mcpIdempotencyKeys.idempotencyKey, input.idempotencyKey),
  );
}

export async function insertMcpIdempotencyLease(
  db: Db,
  input: McpIdempotencyIdentity & { payloadHash: string; expiresAt: Date },
): Promise<boolean> {
  const rows = await db.insert(mcpIdempotencyKeys).values({
    ...input,
    state: "started",
    safeResponse: null,
    errorCode: null,
  }).onConflictDoNothing().returning({ payloadHash: mcpIdempotencyKeys.payloadHash });
  return rows.length > 0;
}

export async function findMcpIdempotencyRow(db: Db, input: McpIdempotencyIdentity) {
  const [row] = await db.select().from(mcpIdempotencyKeys)
    .where(mcpIdempotencyIdentityWhere(input)).limit(1);
  return row ?? null;
}

export async function reclaimMcpIdempotencyLease(
  db: Db,
  input: McpIdempotencyIdentity & { payloadHash: string; now: Date; expiresAt: Date },
): Promise<boolean> {
  const rows = await db.update(mcpIdempotencyKeys).set({
    payloadHash: input.payloadHash,
    state: "started",
    safeResponse: null,
    errorCode: null,
    expiresAt: input.expiresAt,
  }).where(and(
    mcpIdempotencyIdentityWhere(input),
    lte(mcpIdempotencyKeys.expiresAt, input.now),
  )).returning({ state: mcpIdempotencyKeys.state });
  return rows.length > 0;
}

export async function completeMcpIdempotencyLease(
  db: Db,
  input: McpIdempotencyIdentity & {
    payloadHash: string;
    leaseExpiresAt: Date;
    response: unknown;
    expiresAt: Date;
  },
): Promise<boolean> {
  const rows = await db.update(mcpIdempotencyKeys).set({
    state: "completed",
    safeResponse: input.response,
    errorCode: null,
    expiresAt: input.expiresAt,
  }).where(and(
    mcpIdempotencyIdentityWhere(input),
    eq(mcpIdempotencyKeys.payloadHash, input.payloadHash),
    eq(mcpIdempotencyKeys.expiresAt, input.leaseExpiresAt),
    eq(mcpIdempotencyKeys.state, "started"),
  )).returning({ state: mcpIdempotencyKeys.state });
  return rows.length > 0;
}

export async function failMcpIdempotencyLease(
  db: Db,
  input: McpIdempotencyIdentity & {
    payloadHash: string;
    leaseExpiresAt: Date;
    errorCode: string;
    expiresAt: Date;
  },
): Promise<boolean> {
  const rows = await db.update(mcpIdempotencyKeys).set({
    state: "failed",
    safeResponse: null,
    errorCode: input.errorCode,
    expiresAt: input.expiresAt,
  }).where(and(
    mcpIdempotencyIdentityWhere(input),
    eq(mcpIdempotencyKeys.payloadHash, input.payloadHash),
    eq(mcpIdempotencyKeys.expiresAt, input.leaseExpiresAt),
    eq(mcpIdempotencyKeys.state, "started"),
  )).returning({ state: mcpIdempotencyKeys.state });
  return rows.length > 0;
}

export async function releaseMcpIdempotencyLease(
  db: Db,
  input: McpIdempotencyIdentity & { payloadHash: string; leaseExpiresAt: Date },
): Promise<boolean> {
  const rows = await db.delete(mcpIdempotencyKeys).where(and(
    mcpIdempotencyIdentityWhere(input),
    eq(mcpIdempotencyKeys.payloadHash, input.payloadHash),
    eq(mcpIdempotencyKeys.expiresAt, input.leaseExpiresAt),
    eq(mcpIdempotencyKeys.state, "started"),
  )).returning({ state: mcpIdempotencyKeys.state });
  return rows.length > 0;
}

export async function sweepExpiredMcpIdempotencyKeys(
  db: Db,
  now: Date,
  limit: number,
): Promise<number> {
  const result = await db.execute(sql`
    WITH due AS MATERIALIZED (
      SELECT expires_at
      FROM mcp_idempotency_keys
      WHERE expires_at < ${now}
      ORDER BY expires_at ASC
      LIMIT ${limit}
    ), due_instants AS (
      SELECT DISTINCT expires_at FROM due
    ), deleted AS (
      DELETE FROM mcp_idempotency_keys key
      USING due_instants
      WHERE key.expires_at < ${now}
        AND key.expires_at = due_instants.expires_at
      RETURNING key.expires_at
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);
  return affectedRowCount(result);
}

export const insertConnectedMcpIdempotencyLease = (
  input: Parameters<typeof insertMcpIdempotencyLease>[1],
) => insertMcpIdempotencyLease(getDb(), input);
export const findConnectedMcpIdempotencyRow = (
  input: Parameters<typeof findMcpIdempotencyRow>[1],
) => findMcpIdempotencyRow(getDb(), input);
export const reclaimConnectedMcpIdempotencyLease = (
  input: Parameters<typeof reclaimMcpIdempotencyLease>[1],
) => reclaimMcpIdempotencyLease(getDb(), input);
export const completeConnectedMcpIdempotencyLease = (
  input: Parameters<typeof completeMcpIdempotencyLease>[1],
) => completeMcpIdempotencyLease(getDb(), input);
export const failConnectedMcpIdempotencyLease = (
  input: Parameters<typeof failMcpIdempotencyLease>[1],
) => failMcpIdempotencyLease(getDb(), input);
export const releaseConnectedMcpIdempotencyLease = (
  input: Parameters<typeof releaseMcpIdempotencyLease>[1],
) => releaseMcpIdempotencyLease(getDb(), input);
export const sweepConnectedExpiredMcpIdempotencyKeys = (
  now: Date,
  limit: number,
) => sweepExpiredMcpIdempotencyKeys(getDb(), now, limit);

export async function findMcpOAuthClient(db: Db, clientId: string) {
  const [client] = await db
    .select({ referenceId: oauthClient.referenceId, scopes: oauthClient.scopes })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return client ?? null;
}

export async function findMcpDeploymentOrganizationId(db: Db, slug: string) {
  const [row] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

export async function findMcpOrganizationMemberRole(
  db: Db,
  organizationId: string,
  userId: string,
) {
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return membership?.role ?? null;
}
