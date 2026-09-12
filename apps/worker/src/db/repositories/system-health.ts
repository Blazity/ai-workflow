import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { SystemHealthResponse } from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import {
  envMarker,
  systemHealthObservationCounters,
  systemHealthScans,
  webhookTriggerDeliveries,
  webhookTriggerEndpoints,
  webhookTriggerRejectionCounters,
} from "../schema.js";

const SCOPE = "deployment";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

export type SystemHealthObservationOutcome = "accepted" | "rejected";

export type SystemHealthObservation = {
  outcome: SystemHealthObservationOutcome;
  reason: string;
  count: number;
  observedAt: Date;
};

function observationWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function recordSystemHealthObservation(
  db: Db,
  input: {
    integrationId: string;
    checkId: string;
    scope?: string;
    outcome: SystemHealthObservationOutcome;
    reason: string;
  },
  now: Date = new Date(),
): Promise<void> {
  await db.insert(systemHealthObservationCounters).values({
    integrationId: input.integrationId,
    checkId: input.checkId,
    scope: input.scope ?? SCOPE,
    windowStart: observationWindowStart(now),
    outcome: input.outcome,
    reason: input.reason,
    count: 1,
    lastObservedAt: now,
  }).onConflictDoUpdate({
    target: [
      systemHealthObservationCounters.integrationId,
      systemHealthObservationCounters.checkId,
      systemHealthObservationCounters.scope,
      systemHealthObservationCounters.windowStart,
      systemHealthObservationCounters.outcome,
      systemHealthObservationCounters.reason,
    ],
    set: { count: sql`${systemHealthObservationCounters.count} + 1`, lastObservedAt: now },
  });
}

export function recordConnectedSystemHealthObservation(
  input: Parameters<typeof recordSystemHealthObservation>[1],
  now?: Date,
) {
  return recordSystemHealthObservation(getDb(), input, now);
}

export async function getLatestSystemHealthObservations(
  db: Db,
  integrationId: string,
  checkId: string,
  scope?: string,
): Promise<SystemHealthObservation[]> {
  const rows = await db.select({
    outcome: systemHealthObservationCounters.outcome,
    reason: systemHealthObservationCounters.reason,
    count: systemHealthObservationCounters.count,
    observedAt: systemHealthObservationCounters.lastObservedAt,
  }).from(systemHealthObservationCounters).where(and(
    eq(systemHealthObservationCounters.integrationId, integrationId),
    eq(systemHealthObservationCounters.checkId, checkId),
    ...(scope ? [eq(systemHealthObservationCounters.scope, scope)] : []),
  )).orderBy(desc(systemHealthObservationCounters.lastObservedAt));
  return rows.filter((row): row is SystemHealthObservation =>
    row.outcome === "accepted" || row.outcome === "rejected",
  );
}

export function getConnectedLatestSystemHealthObservations(
  integrationId: string,
  checkId: string,
  scope?: string,
) {
  return getLatestSystemHealthObservations(getDb(), integrationId, checkId, scope);
}

export async function sweepSystemHealthObservations(db: Db, now: Date = new Date()): Promise<void> {
  await db.delete(systemHealthObservationCounters).where(lt(
    systemHealthObservationCounters.windowStart,
    new Date(observationWindowStart(now).getTime() - RETENTION_DAYS * DAY_MS),
  ));
}

export function sweepConnectedSystemHealthObservations(now?: Date) {
  return sweepSystemHealthObservations(getDb(), now);
}

export async function saveSystemHealthScan(db: Db, report: SystemHealthResponse): Promise<void> {
  await db.insert(systemHealthScans).values({
    scope: SCOPE,
    generatedAt: new Date(report.generatedAt),
    report,
  }).onConflictDoUpdate({
    target: systemHealthScans.scope,
    set: { generatedAt: new Date(report.generatedAt), report },
  });
}

export function saveConnectedSystemHealthScan(report: SystemHealthResponse) {
  return saveSystemHealthScan(getDb(), report);
}

export async function readSystemHealthScan(db: Db): Promise<SystemHealthResponse | null> {
  const rows = await db.select({ report: systemHealthScans.report }).from(systemHealthScans)
    .where(eq(systemHealthScans.scope, SCOPE)).limit(1);
  return rows[0]?.report ?? null;
}

export function readConnectedSystemHealthScan() {
  return readSystemHealthScan(getDb());
}

async function readDeploymentEnvironmentMarker(
  db: Db,
): Promise<{ env: string | null; endpointHost: string | null } | null> {
  const [row] = await db.select({ env: envMarker.env, endpointHost: envMarker.endpointHost })
    .from(envMarker).where(eq(envMarker.id, 1)).limit(1);
  return row ?? null;
}

export function readConnectedDeploymentEnvironmentMarker() {
  return readDeploymentEnvironmentMarker(getDb());
}

async function checkDatabaseConnectivity(db: Db): Promise<void> {
  await db.execute(sql.raw("select 1"));
}

export function checkConnectedDatabaseConnectivity() {
  return checkDatabaseConnectivity(getDb());
}

async function listCustomWebhookEndpointStates(db: Db) {
  return db.select({ id: webhookTriggerEndpoints.id, revokedAt: webhookTriggerEndpoints.revokedAt })
    .from(webhookTriggerEndpoints);
}

export function listConnectedCustomWebhookEndpointStates() {
  return listCustomWebhookEndpointStates(getDb());
}

async function getLatestActiveCustomWebhookDelivery(db: Db) {
  return db.select({ createdAt: webhookTriggerDeliveries.createdAt })
    .from(webhookTriggerDeliveries)
    .innerJoin(webhookTriggerEndpoints, eq(webhookTriggerDeliveries.endpointId, webhookTriggerEndpoints.id))
    .where(isNull(webhookTriggerEndpoints.revokedAt))
    .orderBy(desc(webhookTriggerDeliveries.createdAt))
    .limit(1);
}

export function getConnectedLatestActiveCustomWebhookDelivery() {
  return getLatestActiveCustomWebhookDelivery(getDb());
}

async function listActiveCustomWebhookRejections(db: Db, since: Date) {
  return db.select({ count: webhookTriggerRejectionCounters.count })
    .from(webhookTriggerRejectionCounters)
    .innerJoin(webhookTriggerEndpoints, eq(webhookTriggerRejectionCounters.endpointId, webhookTriggerEndpoints.id))
    .where(and(
      isNull(webhookTriggerEndpoints.revokedAt),
      gte(webhookTriggerRejectionCounters.windowStart, since),
    )).limit(1);
}

export function listConnectedActiveCustomWebhookRejections(since: Date) {
  return listActiveCustomWebhookRejections(getDb(), since);
}
