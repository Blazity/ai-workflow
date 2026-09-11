import {
  DashboardAuthError,
  canEditPrePrChecks,
  withCanonicalGroupOrder,
  type DashboardRole,
  type PrePrCheckConfigVersion,
} from "@shared/contracts";
import type { Db } from "../../db/types.js";
import {
  getConnectedCurrentPrePrCheckConfigRow,
  getConnectedPrePrCheckConfigVersionRow,
  getCurrentPrePrCheckConfigRow,
  getPrePrCheckConfigVersionRow,
  insertConnectedPrePrCheckConfigVersion,
  insertPrePrCheckConfigVersion,
  listConnectedPrePrCheckConfigVersionRows,
  listPrePrCheckConfigVersionRows,
} from "../../db/repositories/pre-pr-checks.js";
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

/**
 * One canonical order for the groups of every config that leaves this store.
 *
 * The config is stored as jsonb, which reorders object keys (by length, then
 * alphabetically), so the order a config comes back in is not the order it was
 * saved in and is not stable across a save/reload round-trip. The editor
 * decides "unsaved changes" by comparing the listing's newest config with the
 * one on screen, so a non-canonical read shows a freshly loaded screen as
 * dirty. Applied at every exit rather than at each caller, because the callers
 * are the surfaces that would each have to remember.
 */
function canonicalRow(row: PrePrCheckConfigVersionRow): PrePrCheckConfigVersionRow {
  return { ...row, config: withCanonicalGroupOrder(row.config) };
}

export async function getCurrentPrePrCheckConfig(
  db: Db,
): Promise<PrePrCheckConfigVersionRow | null> {
  const row = await getCurrentPrePrCheckConfigRow(db);
  return row ? canonicalRow(row) : null;
}

export async function listPrePrCheckConfigVersions(
  db: Db,
): Promise<PrePrCheckConfigVersionRow[]> {
  const rows = await listPrePrCheckConfigVersionRows(db, VERSION_LIST_LIMIT);
  return rows.map(canonicalRow);
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
  const rows = await insertPrePrCheckConfigVersion(db, {
    config: input.config,
    createdById: input.actorId,
    createdByLabel: input.actorLabel,
    restoredFromVersion: input.restoredFromVersion ?? null,
  });
  return canonicalRow(rows[0]!);
}

export async function restorePrePrCheckConfig(
  db: Db,
  input: { actorRole: DashboardRole; actorId: string; actorLabel: string; version: number },
): Promise<PrePrCheckConfigVersionRow> {
  if (!canEditPrePrChecks(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const rows = await getPrePrCheckConfigVersionRow(db, input.version);
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

export function serializePrePrCheckConfigVersion(
  row: PrePrCheckConfigVersionRow,
): PrePrCheckConfigVersion {
  return {
    version: row.version,
    config: row.config,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}

export function listConnectedPrePrCheckConfigVersions() {
  return listConnectedPrePrCheckConfigVersionRows(VERSION_LIST_LIMIT).then((rows) =>
    rows.map(canonicalRow),
  );
}

export function getConnectedCurrentPrePrCheckConfig() {
  return getConnectedCurrentPrePrCheckConfigRow().then((row) =>
    row ? canonicalRow(row) : null,
  );
}

export function saveConnectedPrePrCheckConfig(input: SavePrePrCheckConfigInput) {
  if (!canEditPrePrChecks(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  return insertConnectedPrePrCheckConfigVersion({
    config: input.config,
    createdById: input.actorId,
    createdByLabel: input.actorLabel,
    restoredFromVersion: input.restoredFromVersion ?? null,
  }).then((rows) => canonicalRow(rows[0]!));
}

export async function restoreConnectedPrePrCheckConfig(
  input: Parameters<typeof restorePrePrCheckConfig>[1],
) {
  if (!canEditPrePrChecks(input.actorRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const [source] = await getConnectedPrePrCheckConfigVersionRow(input.version);
  if (!source) throw new DashboardAuthError(404, "Unknown version");
  return saveConnectedPrePrCheckConfig({
    actorRole: input.actorRole,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    config: source.config,
    restoredFromVersion: source.version,
  });
}
