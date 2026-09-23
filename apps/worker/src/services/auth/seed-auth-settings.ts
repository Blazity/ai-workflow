import { settingDefinition } from "@integrations/registry";
import { readAllSettings } from "../../db/repositories/settings.js";
import type { Db } from "../../db/types.js";

const ORGANIZATION_NAME_KEY = "DASHBOARD_ORG_NAME";

/** The stored organization display name, or its registry default when absent. */
export async function loadSeedAuthOrganizationName(db: Db): Promise<string> {
  const stored = (await readAllSettings(db)).find(
    (row) => row.key === ORGANIZATION_NAME_KEY,
  );
  const value = stored
    ? stored.value
    : settingDefinition(ORGANIZATION_NAME_KEY)?.default;
  if (typeof value !== "string") {
    throw new TypeError(
      `[seed-auth-user] ${ORGANIZATION_NAME_KEY} must resolve to a string`,
    );
  }
  return value;
}
