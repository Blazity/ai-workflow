import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { prePrCheckConfigVersions } from "../db/schema.js";
import { canEditPrePrChecks, type DashboardRole } from "../lib/auth/roles.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import type { PrePrCheckConfig } from "./config.js";

const VERSION_LIST_LIMIT = 50;

export interface PrePrCheckConfigVersionRow {
  version: number;
  config: PrePrCheckConfig;
  createdAt: Date;
  createdById: string;
  createdByLabel: string;
  restoredFromVersion: number | null;
}

export async function getCurrentPrePrCheckConfig(
  db: Db,
): Promise<PrePrCheckConfigVersionRow | null> {
  const rows = await db
    .select()
    .from(prePrCheckConfigVersions)
    .orderBy(desc(prePrCheckConfigVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPrePrCheckConfigVersions(
  db: Db,
): Promise<PrePrCheckConfigVersionRow[]> {
  return db
    .select()
    .from(prePrCheckConfigVersions)
    .orderBy(desc(prePrCheckConfigVersions.version))
    .limit(VERSION_LIST_LIMIT);
}

export interface SavePrePrCheckConfigInput {
  actorRole: DashboardRole;
  actorId: string;
  actorLabel: string;
  config: PrePrCheckConfig;
  restoredFromVersion?: number;
}

export async function savePrePrCheckConfig(
  db: Db,
  input: SavePrePrCheckConfigInput,
): Promise<PrePrCheckConfigVersionRow> {
  if (!canEditPrePrChecks(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const rows = await db
    .insert(prePrCheckConfigVersions)
    .values({
      config: input.config,
      createdById: input.actorId,
      createdByLabel: input.actorLabel,
      restoredFromVersion: input.restoredFromVersion ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function restorePrePrCheckConfig(
  db: Db,
  input: { actorRole: DashboardRole; actorId: string; actorLabel: string; version: number },
): Promise<PrePrCheckConfigVersionRow> {
  if (!canEditPrePrChecks(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const rows = await db
    .select()
    .from(prePrCheckConfigVersions)
    .where(eq(prePrCheckConfigVersions.version, input.version))
    .limit(1);
  const source = rows[0];
  if (!source) {
    throw new DashboardAuthError(404, "Unknown version");
  }
  return savePrePrCheckConfig(db, {
    actorRole: input.actorRole,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    config: source.config,
    restoredFromVersion: source.version,
  });
}
