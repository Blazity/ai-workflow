import { desc, eq } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { prePrCheckConfigVersions, user } from "../schema.js";

export async function getCurrentPrePrCheckConfigRow(db: Db) {
  const [row] = await db
    .select()
    .from(prePrCheckConfigVersions)
    .orderBy(desc(prePrCheckConfigVersions.version))
    .limit(1);
  return row ?? null;
}

export function listPrePrCheckConfigVersionRows(db: Db, limit: number) {
  return db
    .select()
    .from(prePrCheckConfigVersions)
    .orderBy(desc(prePrCheckConfigVersions.version))
    .limit(limit);
}

export function insertPrePrCheckConfigVersion(
  db: Db,
  input: {
    config: NonNullable<typeof prePrCheckConfigVersions.$inferInsert["config"]>;
    createdById: string;
    createdByLabel: string;
    restoredFromVersion: number | null;
  },
) {
  return db
    .insert(prePrCheckConfigVersions)
    .values(input)
    .returning();
}

export function getPrePrCheckConfigVersionRow(db: Db, version: number) {
  return db
    .select()
    .from(prePrCheckConfigVersions)
    .where(eq(prePrCheckConfigVersions.version, version))
    .limit(1);
}

export async function getDashboardUserLabelRow(db: Db, userId: string) {
  const [row] = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

export function getConnectedCurrentPrePrCheckConfigRow() {
  return getCurrentPrePrCheckConfigRow(getDb());
}

export function listConnectedPrePrCheckConfigVersionRows(limit: number) {
  return listPrePrCheckConfigVersionRows(getDb(), limit);
}

export function insertConnectedPrePrCheckConfigVersion(
  input: Parameters<typeof insertPrePrCheckConfigVersion>[1],
) {
  return insertPrePrCheckConfigVersion(getDb(), input);
}

export function getConnectedPrePrCheckConfigVersionRow(version: number) {
  return getPrePrCheckConfigVersionRow(getDb(), version);
}

export function getConnectedDashboardUserLabelRow(userId: string) {
  return getDashboardUserLabelRow(getDb(), userId);
}
