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
  backfillRepositoryDefaultBranches,
  listPinnedRepositoriesFromDefinitions,
  listRepositoryCatalogRows,
  migrateScriptGroupsIntoProfiles,
  readRepositoryCatalogStateRow,
  seedRepositoryCatalogEntries,
  seedRepositoryCatalogState,
} from "../src/db/repositories/repository-catalog.js";
import { seedActivationConflict } from "../src/services/repository-catalog/policy.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[seed-repository-catalog] DATABASE_URL not set, skipping.");
  process.exit(0);
}

/** The allowlist, parsed exactly as the runtime predicate parses it: comma
 *  separated, trimmed, and an entry with no slash ignored rather than widening
 *  the list to "everything".
 *
 *  Deprecated. `AGENT_ALLOWED_REPOS` is replaced by the Repositories page, and
 *  the cleanup release (stage H2) deletes this script and refuses to boot with
 *  the variable set; a deployment that still sets it is told so on every
 *  build. */
function allowlistPaths(): string[] {
  const raw = process.env.AGENT_ALLOWED_REPOS ?? "";
  if (raw.trim() !== "") {
    console.warn(
      "[seed-repository-catalog] AGENT_ALLOWED_REPOS is deprecated: the " +
        "Repositories page decides repository access now, and this seed is " +
        "removed in the cleanup release (stage H2), which refuses to boot " +
        "while the variable is set. Curate the catalog on the Repositories " +
        "page, then remove AGENT_ALLOWED_REPOS from this deployment.",
    );
  }
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

/**
 * The default branch each repository the installation exposes reports, keyed
 * the way the catalog keys repositories.
 *
 * Best effort, and deliberately so. `AGENT_ALLOWED_REPOS` is a comma-separated
 * list of paths: it knows no branches, so every row this seed creates carries
 * an empty default branch and every screen then reports "not recorded" for
 * ever, because the entry page treats identity as read-only. The provider
 * directory is the only place that knows, and asking it is a network call
 * inside a build: a provider that is down, rate limited or not configured must
 * leave the branch unrecorded rather than fail the deploy.
 */
/** One sentence for both ways the listing can come back short, so a partial
 *  failure reads like the total one it is a slice of. */
function warnDirectoryUnlisted(detail: string): void {
  console.warn(
    `[seed-repository-catalog] could not list the provider directory, so default ` +
      `branches are left unrecorded: ${detail}`,
  );
}

async function providerDefaultBranches(): Promise<
  Array<{ provider: string; path: string; defaultBranch: string }>
> {
  try {
    const { listCachedRepositoryDirectory } = await import(
      "../src/services/repository-discovery/index.js"
    );
    const directory = await listCachedRepositoryDirectory();
    // A provider that answered with an error contributes no repositories, and
    // the call still resolves. Without this the seed would print a clean line
    // over a directory that is missing a whole provider, and the rows for it
    // would keep an empty branch with nothing on the build log to say why.
    for (const provider of directory.providers) {
      if (provider.status !== "error") continue;
      warnDirectoryUnlisted(`${provider.provider}: ${provider.error ?? "unknown error"}`);
    }
    return directory.repositories.map((repository) => ({
      provider: repository.provider,
      path: repository.repoPath,
      defaultBranch: repository.defaultBranch,
    }));
  } catch (error) {
    warnDirectoryUnlisted(error instanceof Error ? error.message : String(error));
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

/**
 * An activated catalog is a curated one: somebody opened the Repositories page,
 * read the dialog naming every repository that holds an active run claim, and
 * decided. What the variable says is no longer the deployment's answer, so the
 * two things built from it stand down here: the allowlist-derived rows, which
 * would re-add repositories an admin left out and re-enable ones an admin
 * disabled, and the activation write, which is that admin's decision to make.
 *
 * Only those two. The rest of this script is not about the allowlist at all:
 * the definition pins keep a repository a deployed workflow targets in the
 * catalog, the default-branch backfill repairs rows created before the branch
 * was recorded, and the script-groups migration is a one-off every build still
 * owes. Skipping those with an early exit is how a curated deployment quietly
 * stops getting fixes it has nothing to do with the variable to receive.
 */
const priorState = await readRepositoryCatalogStateRow(db);
const curated = priorState?.activated === true;
/** The allowlist as this build may act on it: nothing, once curated. */
const seedableAllowlist = curated ? [] : allowlist;

const configured = await configuredProviderKinds();
const known = await knownProviders(db);

const unresolved = seedableAllowlist.filter(
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

// Before anything is written: a restricted deployment whose stored state says
// the catalog is off would deploy a worker that reaches everything. The state
// row is written once and never re-decided, so this build cannot fix it by
// writing; it fails and says which two facts disagree. Checked here, next to
// the unresolved-provider gate above, so a refused build leaves nothing
// half-seeded behind it.
const activationConflict = seedActivationConflict({
  allowlistSize: allowlist.length,
  storedActivated: priorState ? priorState.activated : null,
});
if (activationConflict) {
  console.error(`[seed-repository-catalog] ${activationConflict}`);
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

const directory = await providerDefaultBranches();
const branchOf = new Map(
  directory.map((entry) => [
    `${entry.provider}:${entry.path.toLowerCase()}`,
    entry.defaultBranch,
  ]),
);
const granted = dedupe([
  ...seedableAllowlist.flatMap((path) =>
    providersFor(path, known, configured).map((provider) => ({ provider, path })),
  ),
  ...(await listPinnedRepositoriesFromDefinitions(db)),
]).map((entry) =>
  // Recorded when the row is created, from the directory above. Empty when the
  // directory could not be listed, which the backfill below repairs on the next
  // build that can.
  Object.assign(entry, {
    defaultBranch: branchOf.get(`${entry.provider}:${entry.path.toLowerCase()}`) ?? "",
  }),
);
const seeded = await seedRepositoryCatalogEntries(db, {
  repositories: granted,
  source: "seeded",
  enabled: true,
});
// The one-off repair for every row that already exists with no branch: rows
// this seed created on an earlier build, and rows an import created before the
// branch was recorded. Only empty values are filled.
const branchesFilled = await backfillRepositoryDefaultBranches(db, directory);
// Written only while the variable is still the answer. A curated catalog
// already has its state row, and re-deciding it on every build is what this
// stands down from.
const state = curated
  ? { activated: true }
  : await seedRepositoryCatalogState(db, { activated });
const migrated = await migrateScriptGroupsIntoProfiles(db);
const rows = await listRepositoryCatalogRows(db);
const enabled = rows.filter((row) => row.enabled).length;

if (curated) {
  console.log(
    "[seed-repository-catalog] the catalog is activated, so it is curated on " +
      "the Repositories page: this build seeded no rows from " +
      "AGENT_ALLOWED_REPOS and left the activation state alone. Repository " +
      "pins, default branches and script groups were still reconciled below. " +
      "Remove AGENT_ALLOWED_REPOS from this deployment; the cleanup release " +
      "(stage H2) deletes this script.",
  );
}

console.log(
  `[seed-repository-catalog] allowlist entries: ${seedableAllowlist.length}; ` +
    `granted rows created: ${seeded}; ` +
    `default branches filled: ${branchesFilled}; ` +
    `script groups rows created: ${migrated.repositoriesCreated}; ` +
    `profiles created: ${migrated.profilesCreated}; ` +
    `enabled rows: ${enabled} of ${rows.length}; ` +
    `activated: ${state.activated}.`,
);
