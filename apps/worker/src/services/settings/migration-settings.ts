import {
  resolveSettingsSnapshot,
  type SettingsEnvironmentReader,
  type SettingsSnapshot,
} from "@shared/contracts";
import { readAllSettings } from "../../db/repositories/settings.js";
import type { Db } from "../../db/types.js";

export type MigrationSettings = Pick<
  SettingsSnapshot,
  "AGENT_KIND" | "ENABLE_REVIEW_PHASE" | "ENABLE_LEAK_REVIEW"
>;

const NO_ENVIRONMENT: SettingsEnvironmentReader = {
  value: () => void 0,
  isSet: () => false,
};

/**
 * The settings that shape build-time workflow templates. One repository read
 * preserves each stored decision and lets the registry default answer only a
 * key whose row does not exist.
 */
export async function loadMigrationSettings(db: Db): Promise<MigrationSettings> {
  const rows = await readAllSettings(db);
  const settings = resolveSettingsSnapshot(
    new Map(rows.map((row) => [row.key, row.value])),
    NO_ENVIRONMENT,
  ).snapshot;
  return {
    AGENT_KIND: settings.AGENT_KIND,
    ENABLE_REVIEW_PHASE: settings.ENABLE_REVIEW_PHASE,
    ENABLE_LEAK_REVIEW: settings.ENABLE_LEAK_REVIEW,
  };
}
