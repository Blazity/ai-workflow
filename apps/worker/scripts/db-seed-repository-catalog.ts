/**
 * Build-time repository catalog seeder. Runs after `db:migrate` in `pnpm build`,
 * where Vercel injects the deployment's environment.
 *
 * It is here and not in the migration because the decision it makes cannot be
 * made in SQL: whether this deployment is already restricted is a property of
 * the `AGENT_ALLOWED_REPOS` variable, which a migration cannot read. Everything
 * that follows from that decision then has to run in the same place, in order,
 * so the script groups migration can tell an already-granted repository from
 * one that only ever appeared in a checks configuration.
 *
 * Idempotent throughout: every write is guarded on existence, so a redeploy
 * seeds nothing new and an operator's later decisions are never re-decided.
 * A failed build stops the deploy, so a half-seeded production cannot exist.
 *
 * It never activates a deployment that was unrestricted. An empty allowlist
 * means the agent may touch every repository the installation can see, and a
 * seed that quietly ended that would take repositories away from workflows
 * nobody had been asked about.
 */
import { config } from "dotenv";

// Load .env.local (where `vercel env pull` writes) before .env; dotenv never
// overrides vars already set, so real env (Vercel build) always wins.
config({ path: [".env.local", ".env"], quiet: true });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  listPinnedRepositoriesFromDefinitions,
  listRepositoryCatalogRows,
  migrateScriptGroupsIntoProfiles,
  seedRepositoryCatalogEntries,
  seedRepositoryCatalogState,
} from "../src/db/repositories/repository-catalog.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[seed-repository-catalog] DATABASE_URL not set, skipping.");
  process.exit(0);
}

/** The allowlist, parsed exactly as the runtime predicate parses it: comma
 *  separated, trimmed, and an entry with no slash ignored rather than widening
 *  the list to "everything". */
function allowlistPaths(): string[] {
  const raw = process.env.AGENT_ALLOWED_REPOS ?? "";
  return [
    ...new Set(
      raw
        .split(",")
        .map((path) => path.trim())
        .filter((path) => /^[^/\s]+(?:\/[^/\s]+)+$/.test(path)),
    ),
  ];
}

/**
 * Which provider an allowlist entry belongs to.
 *
 * The variable carries paths and no provider, so the provider has to come from
 * somewhere that knows: a definition pin or a stored checks entry naming the
 * same path is authoritative, and for anything left over the deployment's
 * configured providers are the only remaining answer. A deployment with both
 * providers configured and a path neither of them named therefore gets a row
 * per provider, one of which is a repository that does not exist; that row
 * grants access to nothing and an operator can disable it, which is a better
 * failure than silently dropping a repository from the allowlist.
 *
 * An empty answer means nothing knows. The caller fails the build rather than
 * guessing, so a wrong row is never written in the first place.
 */
function providersFor(
  path: string,
  known: Map<string, string[]>,
  configured: string[],
): string[] {
  return known.get(path.toLowerCase()) ?? configured;
}

/**
 * The providers this deployment is actually configured for, or nothing.
 *
 * It never guesses. Assuming github for an allowlist entry nothing else names
 * would create a granted row for a repository that may not exist, on a
 * deployment that might be GitLab only, and the operator would have no way to
 * tell that row apart from one they meant. The caller turns "nothing" into a
 * failed build when the allowlist is non-empty, which is loud, reversible and
 * happens before anything is written.
 */
async function configuredProviderKinds(): Promise<string[]> {
  try {
    const { getConfiguredVcsProviders } = await import("../src/infra/vcs-config.js");
    return getConfiguredVcsProviders().map((provider) => provider.kind);
  } catch (error) {
    console.warn(
      `[seed-repository-catalog] could not read the configured VCS providers: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

async function knownProviders(db: Db): Promise<Map<string, string[]>> {
  const known = new Map<string, string[]>();
  const record = (provider: string, path: string): void => {
    const key = path.toLowerCase();
    const providers = known.get(key) ?? [];
    if (!providers.includes(provider)) providers.push(provider);
    known.set(key, providers);
  };
  for (const pinned of await listPinnedRepositoriesFromDefinitions(db)) {
    record(pinned.provider, pinned.path);
  }
  for (const row of await listRepositoryCatalogRows(db)) {
    record(row.provider, row.path);
  }
  return known;
}

const sql = neon(url);
const db = drizzle({ client: sql, schema }) as unknown as Db;

const allowlist = allowlistPaths();
const activated = allowlist.length > 0;
const configured = await configuredProviderKinds();
const known = await knownProviders(db);

const unresolved = allowlist.filter(
  (path) => providersFor(path, known, configured).length === 0,
);
if (unresolved.length > 0) {
  console.error(
    `[seed-repository-catalog] AGENT_ALLOWED_REPOS names ${unresolved.length} ` +
      `repositor${unresolved.length === 1 ? "y" : "ies"} (${unresolved.join(", ")}) ` +
      "whose VCS provider cannot be determined: no workflow definition pins them, " +
      "no catalog row names them, and this deployment has no configured VCS " +
      "provider to attribute them to. Configure the provider credentials, or " +
      "remove the entries from AGENT_ALLOWED_REPOS.",
  );
  process.exit(1);
}

/** One row per provider and path, compared the way the catalog compares them.
 *  The allowlist and the definition pins overlap constantly, and `Acme/Api` in
 *  the variable with `acme/api` on a pin is the same repository. */
function dedupe(
  entries: Array<{ provider: string; path: string }>,
): Array<{ provider: string; path: string }> {
  const seen = new Set<string>();
  const unique: Array<{ provider: string; path: string }> = [];
  for (const entry of entries) {
    const key = `${entry.provider}:${entry.path.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

const granted = dedupe([
  ...allowlist.flatMap((path) =>
    providersFor(path, known, configured).map((provider) => ({ provider, path })),
  ),
  ...(await listPinnedRepositoriesFromDefinitions(db)),
]);
const seeded = await seedRepositoryCatalogEntries(db, {
  repositories: granted,
  source: "seeded",
  enabled: true,
});
const state = await seedRepositoryCatalogState(db, { activated });
const migrated = await migrateScriptGroupsIntoProfiles(db);
const rows = await listRepositoryCatalogRows(db);
const enabled = rows.filter((row) => row.enabled).length;

console.log(
  `[seed-repository-catalog] allowlist entries: ${allowlist.length}; ` +
    `granted rows created: ${seeded}; ` +
    `script groups rows created: ${migrated.repositoriesCreated}; ` +
    `profiles created: ${migrated.profilesCreated}; ` +
    `enabled rows: ${enabled} of ${rows.length}; ` +
    `activated: ${state.activated}.`,
);
