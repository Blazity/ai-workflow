import { and, eq } from "drizzle-orm";
import type { HarnessCapabilityCatalog, HarnessProvider } from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import { harnessCapabilityCatalogs, organization } from "../schema.js";

export type HarnessCapabilityCatalogRow = typeof harnessCapabilityCatalogs.$inferSelect;

export async function findHarnessCapabilityCatalog(
  db: Db,
  input: { organizationId: string; provider: HarnessProvider; cliVersion: string },
): Promise<HarnessCapabilityCatalogRow | null> {
  const [row] = await db
    .select()
    .from(harnessCapabilityCatalogs)
    .where(
      and(
        eq(harnessCapabilityCatalogs.organizationId, input.organizationId),
        eq(harnessCapabilityCatalogs.provider, input.provider),
        eq(harnessCapabilityCatalogs.cliVersion, input.cliVersion),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function markHarnessCapabilityCatalogRefreshFailure(
  db: Db,
  input: { id: number; now: Date; error: string },
): Promise<HarnessCapabilityCatalogRow | null> {
  const [row] = await db
    .update(harnessCapabilityCatalogs)
    .set({
      lastRefreshFailedAt: input.now,
      lastRefreshError: input.error,
      updatedAt: input.now,
    })
    .where(eq(harnessCapabilityCatalogs.id, input.id))
    .returning();
  return row ?? null;
}

export async function upsertHarnessCapabilityCatalog(
  db: Db,
  input: {
    organizationId: string;
    provider: HarnessProvider;
    cliVersion: string;
    catalog: HarnessCapabilityCatalog;
    catalogHash: string;
    now: Date;
  },
): Promise<HarnessCapabilityCatalogRow> {
  const [row] = await db
    .insert(harnessCapabilityCatalogs)
    .values({
      organizationId: input.organizationId,
      provider: input.provider,
      cliVersion: input.cliVersion,
      catalog: input.catalog,
      catalogHash: input.catalogHash,
      fetchedAt: input.now,
      lastRefreshFailedAt: null,
      lastRefreshError: null,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        harnessCapabilityCatalogs.organizationId,
        harnessCapabilityCatalogs.provider,
        harnessCapabilityCatalogs.cliVersion,
      ],
      set: {
        catalog: input.catalog,
        catalogHash: input.catalogHash,
        fetchedAt: input.now,
        lastRefreshFailedAt: null,
        lastRefreshError: null,
        updatedAt: input.now,
      },
    })
    .returning();
  return row!;
}

export async function listHarnessCapabilityOrganizationIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: organization.id }).from(organization);
  return rows.map((row) => row.id);
}

export function createHarnessCapabilityCatalogRepository(db: Db) {
  return {
    find(input: Parameters<typeof findHarnessCapabilityCatalog>[1]) {
      return findHarnessCapabilityCatalog(db, input);
    },
    markRefreshFailure(input: Parameters<typeof markHarnessCapabilityCatalogRefreshFailure>[1]) {
      return markHarnessCapabilityCatalogRefreshFailure(db, input);
    },
    upsert(input: Parameters<typeof upsertHarnessCapabilityCatalog>[1]) {
      return upsertHarnessCapabilityCatalog(db, input);
    },
    listOrganizationIds() {
      return listHarnessCapabilityOrganizationIds(db);
    },
  };
}

export function createConnectedHarnessCapabilityCatalogRepository() {
  return createHarnessCapabilityCatalogRepository(getDb());
}
