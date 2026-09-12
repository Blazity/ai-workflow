/**
 * Build-time settings seeder. Runs right after `db:migrate` in `pnpm build`,
 * where Vercel exposes the deployment's environment to the build step, so the
 * Settings page shows what this deployment is actually configured with instead
 * of an empty form the operator has to fill in from memory.
 *
 * Idempotent by construction: one insert that does nothing on conflict, so a
 * redeploy never overwrites a decision an operator made in the dashboard, and
 * a key whose variable is unset gets no row at all and keeps resolving through
 * the registry default.
 *
 * Locally (no DATABASE_URL) this is a warn-and-skip no-op, the same as
 * `db:migrate`, so `pnpm build` still works without a database. The imports
 * are dynamic for the same reason the auth seeder's are: reaching the settings
 * module validates the whole environment, which a machine with no database
 * configured cannot satisfy.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

if (!process.env.DATABASE_URL) {
  console.warn("[db-seed-settings] DATABASE_URL not set, skipping settings seed.");
  process.exit(0);
}

const { getDb } = await import("../src/db/client.js");
const { seedSettings } = await import("../src/db/repositories/settings.js");
const { settingsSeedRows } = await import("../src/services/settings/index.js");

const rows = settingsSeedRows();
const created = await seedSettings(getDb(), { rows, actor: "environment" });
console.log(
  `[db-seed-settings] ${rows.length} configured ${
    rows.length === 1 ? "setting" : "settings"
  }, ${created} newly stored.`,
);
