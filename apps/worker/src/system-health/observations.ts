import { createHash } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { systemHealthObservationCounters } from "../db/schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

export type SystemHealthObservationOutcome = "accepted" | "rejected";

export type SystemHealthObservation = {
  outcome: SystemHealthObservationOutcome;
  reason: string;
  count: number;
  observedAt: Date;
};

export function systemHealthObservationWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function systemHealthObservationScope(secret: string | undefined): string {
  if (!secret) return "deployment:unconfigured";
  return `deployment:${createHash("sha256").update(secret).digest("hex")}`;
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
  await db
    .insert(systemHealthObservationCounters)
    .values({
      integrationId: input.integrationId,
      checkId: input.checkId,
      scope: input.scope ?? "deployment",
      windowStart: systemHealthObservationWindowStart(now),
      outcome: input.outcome,
      reason: input.reason,
      count: 1,
      lastObservedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        systemHealthObservationCounters.integrationId,
        systemHealthObservationCounters.checkId,
        systemHealthObservationCounters.scope,
        systemHealthObservationCounters.windowStart,
        systemHealthObservationCounters.outcome,
        systemHealthObservationCounters.reason,
      ],
      set: {
        count: sql`${systemHealthObservationCounters.count} + 1`,
        lastObservedAt: now,
      },
    });
}

export async function getLatestSystemHealthObservations(
  db: Db,
  integrationId: string,
  checkId: string,
  scope?: string,
): Promise<SystemHealthObservation[]> {
  const rows = await db
    .select({
      outcome: systemHealthObservationCounters.outcome,
      reason: systemHealthObservationCounters.reason,
      count: systemHealthObservationCounters.count,
      observedAt: systemHealthObservationCounters.lastObservedAt,
    })
    .from(systemHealthObservationCounters)
    .where(
      and(
        eq(systemHealthObservationCounters.integrationId, integrationId),
        eq(systemHealthObservationCounters.checkId, checkId),
        ...(scope ? [eq(systemHealthObservationCounters.scope, scope)] : []),
      ),
    )
    .orderBy(desc(systemHealthObservationCounters.lastObservedAt));
  return rows.filter(
    (row): row is SystemHealthObservation =>
      row.outcome === "accepted" || row.outcome === "rejected",
  );
}

export async function sweepSystemHealthObservations(
  db: Db,
  now: Date = new Date(),
): Promise<void> {
  await db
    .delete(systemHealthObservationCounters)
    .where(
      lt(
        systemHealthObservationCounters.windowStart,
        new Date(
          systemHealthObservationWindowStart(now).getTime() - RETENTION_DAYS * DAY_MS,
        ),
      ),
    );
}
