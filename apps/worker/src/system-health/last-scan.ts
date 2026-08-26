import { eq } from "drizzle-orm";
import type { SystemHealthResponse } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { systemHealthScans } from "../db/schema.js";

const SCOPE = "deployment";

/** Overwrites the stored scan so the Health screen can show it on load. */
export async function saveSystemHealthScan(
  db: Db,
  report: SystemHealthResponse,
): Promise<void> {
  await db
    .insert(systemHealthScans)
    .values({
      scope: SCOPE,
      generatedAt: new Date(report.generatedAt),
      report,
    })
    .onConflictDoUpdate({
      target: systemHealthScans.scope,
      set: { generatedAt: new Date(report.generatedAt), report },
    });
}

/** The last stored scan, or `null` before the first one. Never runs a probe. */
export async function readSystemHealthScan(
  db: Db,
): Promise<SystemHealthResponse | null> {
  const rows = await db
    .select({ report: systemHealthScans.report })
    .from(systemHealthScans)
    .where(eq(systemHealthScans.scope, SCOPE))
    .limit(1);
  return rows[0]?.report ?? null;
}
