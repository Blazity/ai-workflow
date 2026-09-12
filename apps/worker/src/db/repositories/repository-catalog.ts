/**
 * The repository catalog's whole database surface.
 *
 * Everything that reads or writes the catalog goes through here: the services
 * tier for the dashboard, and the engine's steps for the check configuration a
 * run executes. Nothing outside this file touches the three tables, which is
 * what keeps the client fence at zero and what lets the script groups migration
 * be one file to review rather than a diff spread over three tiers.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type {
  PrePrCheckRepositoryConfig,
  RepositoryCatalogSource,
  RepositoryRelationship,
} from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import {
  prePrCheckConfigVersions,
  repositories,
  repositoryCatalogState,
  repositoryProfileVersions,
} from "../schema.js";

export type RepositoryCatalogRow = typeof repositories.$inferSelect;
export type RepositoryProfileVersionRow = typeof repositoryProfileVersions.$inferSelect;

/** The catalog row plus the profile version it currently resolves to. Null when
 *  the row exists but was never given a profile (an allowlist seed or an
 *  import), which behaves exactly as an absent entry in the old global blob. */
export interface RepositoryWithProfile {
  repository: RepositoryCatalogRow;
  profile: RepositoryProfileVersionRow | null;
}

export interface RepositoryCatalogStateRow {
  activated: boolean;
  activatedAt: Date | null;
  activatedById: string | null;
  activatedByLabel: string | null;
}

/**
 * The configuration exactly as the engine's deprecated reader declares it: a
 * repository entry with a required `commands` array. The declaration is a lie
 * the stored blob already told (a grouped entry carries no `commands` at all)
 * and it is kept, not repaired, because repairing it is the workflow-graph
 * stage's change and not this one's. Storage is verbatim jsonb either way, so
 * the assertion bridges declarations only, never bytes.
 */
type StoredCheckConfig = {
  repositories: Array<PrePrCheckRepositoryConfig & { commands: string[] }>;
  batchTimeoutMinutes?: number;
};

/**
 * What a run's check-configuration readers need, in the shape they already
 * consumed.
 *
 * `config` is composed out of per-repository profiles, so editing one
 * repository cannot change what another repository's checks run. `version` is
 * the legacy global counter, kept because the publication gate has recorded it
 * on every run ever minted and a run in flight across this deployment must not
 * find its recorded number replaced by a different one. `repositoryVersions` is
 * the number the gate actually reasons about from now on.
 */
export interface CurrentCheckConfiguration {
  version: number | null;
  config: StoredCheckConfig;
  /**
   * `provider:owner/name` (cased down) to the CHECKS version composed into
   * `config` for it, never the profile version.
   *
   * Two counters exist precisely so this map can move only when the commands
   * change. Only repositories whose profile carries script groups appear: a
   * profile with none applies to nothing, exactly as a repository missing from
   * the blob did.
   */
  repositoryVersions: Record<string, number>;
  /** The newest profile composed into `config`: when it was written and by
   *  whom. Null when no profile carries script groups. The legacy checks screen
   *  shows it as the header of the current configuration; there is no other
   *  place left to read "who last changed this" from once the global blob stops
   *  being the source. */
  changedAt: Date | null;
  changedById: string | null;
  changedByLabel: string | null;
}

/**
 * The version a deployment that has never stored a global configuration reports.
 *
 * The publication gate requires a positive integer and compares it at Finalize,
 * so "no legacy row" cannot resolve to null once profiles exist or no gate
 * would ever be minted. 1 is stable forever on such a deployment, which is the
 * only property the comparison needs from it now that the per-repository
 * versions carry the real signal.
 */
const LEGACY_CONFIGURATION_VERSION_FALLBACK = 1;

const DEFAULT_VERSION_LIST_LIMIT = 50;

/** Who the seed says activated the catalog, so a later screen can offer the
 *  review that an operator's own click would not need. */
const SEED_ACTOR_ID = "seed";
const SEED_ACTOR_LABEL = "seeded from AGENT_ALLOWED_REPOS";

function repositoryKeyOf(repository: { provider: string; path: string }): string {
  return `${repository.provider}:${repository.path.toLowerCase()}`;
}

export function listRepositoryCatalogRows(
  db: Db,
  options: { enabledOnly?: boolean } = {},
) {
  const query = db.select().from(repositories);
  const filtered = options.enabledOnly
    ? query.where(eq(repositories.enabled, true))
    : query;
  return filtered.orderBy(asc(repositories.provider), asc(repositories.path));
}

export async function getRepositoryCatalogRow(db: Db, id: number) {
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1);
  return row ?? null;
}

/** Case insensitive on the path, because that is how access has always been
 *  decided here and a row stored as `acme/api` must answer for `Acme/Api`. */
export async function getRepositoryCatalogRowByPath(
  db: Db,
  input: { provider: string; path: string },
) {
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.provider, input.provider),
        sql`lower(${repositories.path}) = ${input.path.toLowerCase()}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface UpsertRepositoryProfileInput {
  provider: string;
  path: string;
  /**
   * The fields an operator authors about a repository. Every one of them is
   * optional and ABSENT MEANS UNCHANGED, not "set to empty".
   *
   * The legacy repository-scripts screen knows nothing about descriptions,
   * rules or relationships; when its save fans out into profiles it must carry
   * only what it actually owns, or a save on the checks screen would silently
   * erase what somebody wrote on the Repositories screen. The carry-forward
   * happens inside the statement, against the row as it is at write time, so
   * two writers cannot resurrect a stale value between a read and a write.
   */
  displayName?: string;
  defaultBranch?: string;
  description?: string;
  rules?: string;
  relationships?: RepositoryRelationship[];
  scriptGroups: Record<string, unknown> | null;
  gateGroups: string[] | null;
  actorId: string;
  actorLabel: string;
  reason: string;
  source?: RepositoryCatalogSource;
  /**
   * Whether a repository CREATED by this call may be touched by the agent.
   *
   * Defaults to false, and is ignored for a repository that already exists: a
   * profile save is never a grant. Configuring what to run in a repository and
   * deciding that the agent may enter it are two different decisions, made by
   * the enabled route and by the seed, and the authoring path must not make the
   * second one as a side effect of the first.
   */
  enabled?: boolean;
}

/**
 * Write a repository's profile and mint its next version, in one statement.
 *
 * One statement and not a transaction: production runs on neon-http, which
 * cannot open an interactive one, and the pglite driver used by the tests can,
 * so a two-statement version would pass every unit test and leave production
 * able to store a repository row whose version row never arrived. The
 * data-modifying CTEs are mutually exclusive by construction: `existing`
 * decides which of `inserted` and `updated` fires, and the version row is then
 * written against whichever returned.
 *
 * `resolved` is what makes absent fields mean unchanged: it reads the current
 * row and the profile it resolves to, and every value the statement writes is
 * taken from there unless this call supplied one.
 *
 * The checks version moves only when `script_groups` or `gate_groups` actually
 * change, compared with `IS NOT DISTINCT FROM` so that null and null match.
 * That is the whole point of keeping two counters: a run in flight fails at
 * Finalize when the commands it ran were re-configured under it, and survives
 * somebody fixing a typo in the repository's description.
 *
 * The `ON CONFLICT` clause is not redundant with `existing`: the lookup is case
 * insensitive and the unique index is not, so two writers racing on the exact
 * same casing still resolve to an update rather than a duplicate key error. It
 * bumps the checks version unconditionally, because in that race `resolved`
 * computed against no row at all; bumping fails an in-flight gate that might
 * have survived, which is the safe direction.
 */
export async function upsertRepositoryProfile(
  db: Db,
  input: UpsertRepositoryProfileInput,
): Promise<{ id: number; version: number; checksVersion: number }> {
  const text = (value: string | undefined) =>
    value === undefined ? sql`NULL::text` : sql`${value}::text`;
  const json = (value: unknown | null | undefined) =>
    value === undefined || value === null
      ? sql`NULL::jsonb`
      : sql`${JSON.stringify(value)}::jsonb`;
  const scriptGroups = json(input.scriptGroups);
  const gateGroups = json(input.gateGroups);
  const source = input.source ?? "manual";
  const result = await db.execute(sql`
    WITH existing AS (
      SELECT
        stored.id AS id,
        stored.display_name AS display_name,
        stored.default_branch AS default_branch,
        stored.description AS description,
        stored.rules AS rules,
        stored.relationships AS relationships,
        stored.current_checks_version AS current_checks_version,
        current_profile.script_groups AS script_groups,
        current_profile.gate_groups AS gate_groups
      FROM ${repositories} AS stored
      LEFT JOIN ${repositoryProfileVersions} AS current_profile
        ON current_profile.repository_id = stored.id
       AND current_profile.version = stored.current_profile_version
      WHERE stored.provider = ${input.provider}
        AND lower(stored.path) = ${input.path.toLowerCase()}
      LIMIT 1
    ), resolved AS (
      SELECT
        COALESCE(${text(input.displayName)}, existing.display_name, ${input.path})
          AS display_name,
        COALESCE(${text(input.defaultBranch)}, existing.default_branch, '')
          AS default_branch,
        COALESCE(${text(input.description)}, existing.description, '') AS description,
        COALESCE(${text(input.rules)}, existing.rules, '') AS rules,
        COALESCE(${json(input.relationships)}, existing.relationships, '[]'::jsonb)
          AS relationships,
        CASE
          WHEN existing.id IS NULL
            THEN CASE
              WHEN ${scriptGroups} IS NULL AND ${gateGroups} IS NULL THEN 0
              ELSE 1
            END
          WHEN existing.script_groups IS NOT DISTINCT FROM ${scriptGroups}
           AND existing.gate_groups IS NOT DISTINCT FROM ${gateGroups}
            THEN existing.current_checks_version
          ELSE existing.current_checks_version + 1
        END AS checks_version
      FROM (SELECT 1) AS anchor
      LEFT JOIN existing ON true
    ), inserted AS (
      INSERT INTO ${repositories} (
        provider, path, display_name, default_branch, description, rules,
        relationships, enabled, source, current_profile_version,
        current_checks_version
      )
      SELECT
        ${input.provider}, ${input.path}, resolved.display_name,
        resolved.default_branch, resolved.description, resolved.rules,
        resolved.relationships, ${input.enabled ?? false}, ${source}, 1,
        resolved.checks_version
      FROM resolved
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      ON CONFLICT (provider, path) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        default_branch = EXCLUDED.default_branch,
        description = EXCLUDED.description,
        rules = EXCLUDED.rules,
        relationships = EXCLUDED.relationships,
        current_profile_version = ${repositories}.current_profile_version + 1,
        current_checks_version = ${repositories}.current_checks_version + 1,
        updated_at = now()
      RETURNING id, current_profile_version, current_checks_version
    ), updated AS (
      UPDATE ${repositories} SET
        display_name = resolved.display_name,
        default_branch = resolved.default_branch,
        description = resolved.description,
        rules = resolved.rules,
        relationships = resolved.relationships,
        current_profile_version = ${repositories}.current_profile_version + 1,
        current_checks_version = resolved.checks_version,
        updated_at = now()
      FROM resolved
      WHERE ${repositories}.id IN (SELECT id FROM existing)
      RETURNING ${repositories}.id, ${repositories}.current_profile_version,
        ${repositories}.current_checks_version
    ), target AS (
      SELECT id, current_profile_version, current_checks_version FROM inserted
      UNION ALL
      SELECT id, current_profile_version, current_checks_version FROM updated
    )
    INSERT INTO ${repositoryProfileVersions} (
      repository_id, version, description, rules, relationships,
      script_groups, gate_groups, checks_version, actor_id, actor_label, reason
    )
    SELECT
      target.id, target.current_profile_version, resolved.description,
      resolved.rules, resolved.relationships, ${scriptGroups}, ${gateGroups},
      target.current_checks_version, ${input.actorId}, ${input.actorLabel},
      ${input.reason}
    FROM target, resolved
    RETURNING repository_id AS id, version, checks_version
  `);
  const row = (
    result as { rows?: Array<{ id: number; version: number; checks_version: number }> }
  ).rows?.[0];
  if (!row) throw new Error("repository profile upsert returned no version");
  return {
    id: Number(row.id),
    version: Number(row.version),
    checksVersion: Number(row.checks_version),
  };
}

/**
 * Turn a repository on or off. Deliberately not a profile change: a run in
 * flight must not find its checks configuration moved because somebody flipped
 * a switch, so this mints no version and the gate never sees it.
 */
export async function setRepositoryEnabled(
  db: Db,
  input: { id: number; enabled: boolean },
) {
  const [row] = await db
    .update(repositories)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(repositories.id, input.id))
    .returning();
  return row ?? null;
}

/** One profile version, by its key. The screens that want "the version this
 *  repository currently resolves to" ask for it directly rather than listing a
 *  page of history and scanning it for a number they already hold. */
export async function getRepositoryProfileVersionRow(
  db: Db,
  repositoryId: number,
  version: number,
): Promise<RepositoryProfileVersionRow | null> {
  const [row] = await db
    .select()
    .from(repositoryProfileVersions)
    .where(
      and(
        eq(repositoryProfileVersions.repositoryId, repositoryId),
        eq(repositoryProfileVersions.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A repository and the profile it currently resolves to, by path, in one
 *  keyed read. The legacy fan-out uses it to decide whether a save changes
 *  anything at all before it writes. */
export async function getRepositoryWithProfileByPath(
  db: Db,
  input: { provider: string; path: string },
): Promise<RepositoryWithProfile | null> {
  const repository = await getRepositoryCatalogRowByPath(db, input);
  if (!repository) return null;
  const profile =
    repository.currentProfileVersion > 0
      ? await getRepositoryProfileVersionRow(
          db,
          repository.id,
          repository.currentProfileVersion,
        )
      : null;
  return { repository, profile };
}

export function listRepositoryProfileVersionRows(
  db: Db,
  repositoryId: number,
  limit: number = DEFAULT_VERSION_LIST_LIMIT,
) {
  return db
    .select()
    .from(repositoryProfileVersions)
    .where(eq(repositoryProfileVersions.repositoryId, repositoryId))
    .orderBy(desc(repositoryProfileVersions.version))
    .limit(limit);
}

/** Every catalog row with the profile version it currently resolves to, in one
 *  join rather than a correlated max() per repository. */
export async function listRepositoriesWithProfiles(
  db: Db,
  options: { enabledOnly?: boolean } = {},
): Promise<RepositoryWithProfile[]> {
  const query = db
    .select({ repository: repositories, profile: repositoryProfileVersions })
    .from(repositories)
    .leftJoin(
      repositoryProfileVersions,
      and(
        eq(repositoryProfileVersions.repositoryId, repositories.id),
        eq(repositoryProfileVersions.version, repositories.currentProfileVersion),
      ),
    );
  const filtered = options.enabledOnly
    ? query.where(eq(repositories.enabled, true))
    : query;
  const rows = await filtered.orderBy(asc(repositories.provider), asc(repositories.path));
  return rows.map((row) => ({ repository: row.repository, profile: row.profile ?? null }));
}

export async function getRepositoryCatalogStateRow(
  db: Db,
): Promise<RepositoryCatalogStateRow> {
  const [row] = await db.select().from(repositoryCatalogState).limit(1);
  // Absent means "never seeded and never activated", which is the bridge. A
  // deployment whose build has not run the seed yet, and every unit test that
  // only replays migrations, lands here and behaves exactly as today.
  return row
    ? {
        activated: row.activated,
        activatedAt: row.activatedAt,
        activatedById: row.activatedById,
        activatedByLabel: row.activatedByLabel,
      }
    : {
        activated: false,
        activatedAt: null,
        activatedById: null,
        activatedByLabel: null,
      };
}

/** One statement, so a second click cannot create a second state row. */
export async function activateRepositoryCatalog(
  db: Db,
  input: { actorId: string; actorLabel?: string; now?: Date },
): Promise<RepositoryCatalogStateRow> {
  const now = input.now ?? new Date();
  const actorLabel = input.actorLabel ?? null;
  const [row] = await db
    .insert(repositoryCatalogState)
    .values({
      id: 1,
      activated: true,
      activatedAt: now,
      activatedById: input.actorId,
      activatedByLabel: actorLabel,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: repositoryCatalogState.id,
      set: {
        activated: true,
        activatedAt: now,
        activatedById: input.actorId,
        activatedByLabel: actorLabel,
        updatedAt: now,
      },
    })
    .returning();
  return {
    activated: row?.activated ?? true,
    activatedAt: row?.activatedAt ?? now,
    activatedById: row?.activatedById ?? input.actorId,
    activatedByLabel: row?.activatedByLabel ?? actorLabel,
  };
}

/**
 * Repositories a live claim is working in that the catalog would stop selecting
 * once it is activated.
 *
 * The population is honest about what it can see. `active_runs` carries a
 * subject and a ticket and no repository at all, and `workflow_owned_branches`
 * records one row per ticket and repository with NO run id, so there is no
 * column anywhere that ties a branch to the run that created it. The join is
 * therefore on the ticket key, and what comes back is "repositories with
 * branches on tickets that currently hold a claim", not "repositories this run
 * is writing to right now": a ticket re-run after an earlier run touched a
 * repository still lists that repository.
 *
 * That is why each entry carries the tickets and the run ids it came from. An
 * admin about to end the bridge can see WHY a repository is listed and go look
 * at the run, instead of being handed a bare name and asked to trust it.
 */
export interface ClaimedRepositoryNotEnabled {
  /** `provider:owner/name`, cased down: the acknowledgement key. */
  key: string;
  /** The repository as the branch registry spells it, for display. */
  displayName: string;
  ticketKeys: string[];
  runIds: string[];
}

export async function listClaimedRepositoriesNotEnabled(
  db: Db,
): Promise<ClaimedRepositoryNotEnabled[]> {
  const result = await db.execute(sql`
    SELECT
      branches.provider AS provider,
      min(branches.repo_path) AS repo_path,
      array_agg(DISTINCT claims.ticket_key) AS ticket_keys,
      array_remove(array_agg(DISTINCT claims.run_id), NULL) AS run_ids
    FROM workflow_owned_branches AS branches
    JOIN active_runs AS claims ON claims.ticket_key = branches.ticket_key
    LEFT JOIN ${repositories} AS catalog
      ON catalog.provider = branches.provider
     AND lower(catalog.path) = lower(branches.repo_path)
    WHERE catalog.id IS NULL OR catalog.enabled = false
    GROUP BY branches.provider, lower(branches.repo_path)
    ORDER BY branches.provider, lower(branches.repo_path)
  `);
  const rows =
    (
      result as {
        rows?: Array<{
          provider: string;
          repo_path: string;
          ticket_keys: string[] | null;
          run_ids: string[] | null;
        }>;
      }
    ).rows ?? [];
  return rows.map((row) => ({
    key: `${row.provider}:${row.repo_path.toLowerCase()}`,
    displayName: row.repo_path,
    ticketKeys: [...(row.ticket_keys ?? [])].sort(),
    runIds: [...(row.run_ids ?? [])].sort(),
  }));
}

/**
 * Compose the check configuration a run executes out of per-repository
 * profiles.
 *
 * The stored provider and path win over whatever the profile's own script
 * groups entry repeats, so a profile edited by hand cannot point a repository's
 * commands at a different repository.
 *
 * The legacy global blob contributes exactly two things and nothing else: the
 * version counter the publication gate has always recorded, and
 * `batchTimeoutMinutes`, which is a deployment-wide bound rather than anything
 * a repository owns. Its `repositories` payload is read by nobody after this
 * stage; the cleanup stage drops the table.
 *
 * `enabled` is deliberately NOT a filter here. This composes what to run in a
 * repository, and a run never reaches a repository it may not touch: the run
 * carries its own enabled set, decided once when it was dispatched, so a
 * repository switched off while checks are in flight must not have its commands
 * vanish from under the run that is already inside it. Filtering here would
 * also make the catalog's on/off switch move what the checks do, which is the
 * one thing `setRepositoryEnabled` promises it never does.
 */
export async function getCurrentCheckConfiguration(
  db: Db,
): Promise<CurrentCheckConfiguration> {
  const [legacy] = await db
    .select({
      version: prePrCheckConfigVersions.version,
      config: prePrCheckConfigVersions.config,
    })
    .from(prePrCheckConfigVersions)
    .orderBy(desc(prePrCheckConfigVersions.version))
    .limit(1);
  const withProfiles = await listRepositoriesWithProfiles(db);
  const entries: PrePrCheckRepositoryConfig[] = [];
  const repositoryVersions: Record<string, number> = {};
  let newest: RepositoryProfileVersionRow | null = null;
  for (const { repository, profile } of withProfiles) {
    if (!profile?.scriptGroups) continue;
    if (!newest || profile.createdAt > newest.createdAt) newest = profile;
    const entry = {
      ...(profile.scriptGroups as Record<string, unknown>),
      provider: repository.provider,
      repoPath: repository.path,
      ...(profile.gateGroups ? { gateGroups: profile.gateGroups } : {}),
    } as PrePrCheckRepositoryConfig;
    entries.push(entry);
    repositoryVersions[repositoryKeyOf(repository)] = profile.checksVersion;
  }
  const batchTimeoutMinutes = (legacy?.config as { batchTimeoutMinutes?: number } | undefined)
    ?.batchTimeoutMinutes;
  const config = {
    repositories: entries,
    ...(typeof batchTimeoutMinutes === "number" ? { batchTimeoutMinutes } : {}),
  } as StoredCheckConfig;
  const changed = {
    changedAt: newest?.createdAt ?? null,
    changedById: newest?.actorId ?? null,
    changedByLabel: newest?.actorLabel ?? null,
  };
  if (entries.length === 0) {
    return { version: legacy?.version ?? null, config, repositoryVersions, ...changed };
  }
  return {
    version: legacy?.version ?? LEGACY_CONFIGURATION_VERSION_FALLBACK,
    config,
    repositoryVersions,
    ...changed,
  };
}

export function listConnectedRepositoryCatalogRows(
  options: { enabledOnly?: boolean } = {},
) {
  return listRepositoryCatalogRows(getDb(), options);
}

export function getConnectedRepositoryCatalogRow(id: number) {
  return getRepositoryCatalogRow(getDb(), id);
}

export function getConnectedRepositoryCatalogRowByPath(input: {
  provider: string;
  path: string;
}) {
  return getRepositoryCatalogRowByPath(getDb(), input);
}

export function upsertConnectedRepositoryProfile(input: UpsertRepositoryProfileInput) {
  return upsertRepositoryProfile(getDb(), input);
}

export function setConnectedRepositoryEnabled(input: { id: number; enabled: boolean }) {
  return setRepositoryEnabled(getDb(), input);
}

export function getConnectedRepositoryProfileVersionRow(
  repositoryId: number,
  version: number,
) {
  return getRepositoryProfileVersionRow(getDb(), repositoryId, version);
}

export function getConnectedRepositoryWithProfileByPath(input: {
  provider: string;
  path: string;
}) {
  return getRepositoryWithProfileByPath(getDb(), input);
}

export function listConnectedRepositoryProfileVersionRows(
  repositoryId: number,
  limit?: number,
) {
  return listRepositoryProfileVersionRows(getDb(), repositoryId, limit);
}

export function getConnectedRepositoryCatalogStateRow() {
  return getRepositoryCatalogStateRow(getDb());
}

export function activateConnectedRepositoryCatalog(input: {
  actorId: string;
  actorLabel?: string;
  now?: Date;
}) {
  return activateRepositoryCatalog(getDb(), input);
}

export function listConnectedClaimedRepositoriesNotEnabled() {
  return listClaimedRepositoriesNotEnabled(getDb());
}

export function getConnectedCurrentCheckConfiguration() {
  return getCurrentCheckConfiguration(getDb());
}

/**
 * The import commit, which is the seed insert under another name.
 *
 * Deliberately the same function. An import and the allowlist seed create the
 * same thing, rows with no profile, and the seed's insert already is the one
 * statement with the case-insensitive guard and the do-nothing conflict clause
 * that neon-http forces and that the consecutive-writes gate checks for. A
 * second spelling would be a second place for that guard to go wrong, and the
 * only difference between the two callers is the `source` they pass.
 */
export function importConnectedRepositoryCatalogEntries(input: {
  repositories: Array<{ provider: string; path: string }>;
  enabled: boolean;
}) {
  return seedRepositoryCatalogEntries(getDb(), { ...input, source: "imported" });
}

/**
 * Every repository pinned by a stored workflow definition version, published or
 * draft.
 *
 * All versions, not only the deployed one. A pin grants access today, so a
 * repository named by a draft an author is still editing must survive into the
 * catalog: importing only deployed pins would quietly take a repository away
 * from the next publish.
 */
export async function listPinnedRepositoriesFromDefinitions(
  db: Db,
): Promise<Array<{ provider: string; path: string }>> {
  const result = await db.execute(sql`
    SELECT DISTINCT
      pinned.value->>'provider' AS provider,
      btrim(pinned.value->>'repoPath') AS path
    FROM workflow_definition_versions AS versions,
      jsonb_array_elements(
        COALESCE(versions.definition->'repositoryScope'->'repositories', '[]'::jsonb)
      ) AS pinned(value)
    WHERE pinned.value->>'provider' IN ('github', 'gitlab')
      AND COALESCE(btrim(pinned.value->>'repoPath'), '') <> ''
    ORDER BY 1, 2
  `);
  const rows = (result as { rows?: Array<{ provider: string; path: string }> }).rows ?? [];
  return rows.map((row) => ({ provider: row.provider, path: row.path }));
}

/**
 * Create catalog rows for repositories this deployment already grants access
 * to, in one multi-row insert.
 *
 * Idempotent twice over: the `NOT EXISTS` guard is case insensitive, so a row
 * stored as `Acme/Api` is not duplicated by an allowlist entry spelled
 * `acme/api`, and the `ON CONFLICT` clause catches the exact-case race the
 * guard cannot. Rows are created with no profile (`current_profile_version` 0),
 * which is how "known and granted, but nothing configured" is spelled.
 */
export async function seedRepositoryCatalogEntries(
  db: Db,
  input: {
    repositories: Array<{ provider: string; path: string }>;
    source: RepositoryCatalogSource;
    enabled: boolean;
  },
): Promise<number> {
  // Deduplicated first, and the same way the catalog compares repositories.
  // The allowlist variable and the definition pins overlap constantly, and the
  // guard below only sees the table: two candidates spelled `Acme/Api` and
  // `acme/api` in ONE call would both pass it and the unique index, which is
  // exact-case, would not stop them either.
  const seen = new Set<string>();
  const unique: Array<{ provider: string; path: string }> = [];
  for (const repository of input.repositories) {
    const key = `${repository.provider}:${repository.path.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(repository);
  }
  if (unique.length === 0) return 0;
  const values = sql.join(
    unique.map((repository) => sql`(${repository.provider}, ${repository.path})`),
    sql`, `,
  );
  const result = await db.execute(sql`
    INSERT INTO ${repositories} (
      provider, path, display_name, source, enabled, current_profile_version
    )
    SELECT
      candidate.provider, candidate.path, candidate.path, ${input.source},
      ${input.enabled}, 0
    FROM (VALUES ${values}) AS candidate(provider, path)
    WHERE NOT EXISTS (
      SELECT 1 FROM ${repositories} AS existing
      WHERE existing.provider = candidate.provider
        AND lower(existing.path) = lower(candidate.path)
    )
    ON CONFLICT (provider, path) DO NOTHING
    RETURNING id
  `);
  return ((result as { rows?: unknown[] }).rows ?? []).length;
}

/**
 * Write the catalog state row, once.
 *
 * On conflict it does nothing rather than updating: activation is an operator's
 * decision and a seed that ran again on the next deploy must never re-decide
 * it. A deployment that activated the catalog and later emptied its allowlist
 * variable stays activated; one that never activated stays on the bridge.
 */
export async function seedRepositoryCatalogState(
  db: Db,
  input: { activated: boolean; now?: Date },
): Promise<RepositoryCatalogStateRow> {
  const now = input.now ?? new Date();
  await db
    .insert(repositoryCatalogState)
    .values({
      id: 1,
      activated: input.activated,
      activatedAt: input.activated ? now : null,
      // Named, not anonymous. An activation nobody clicked is still an
      // activation, and the Repositories screen has to be able to say so: the
      // deployment was already restricted to this exact list, and the seed
      // wrote that list down rather than widening it.
      activatedById: input.activated ? SEED_ACTOR_ID : null,
      activatedByLabel: input.activated ? SEED_ACTOR_LABEL : null,
      updatedAt: now,
    })
    .onConflictDoNothing();
  return getRepositoryCatalogStateRow(db);
}

/**
 * Move the global script groups blob into one profile per repository it names.
 *
 * Two statements because they answer two questions and neither is a multi-row
 * change the other has to be atomic with: the first creates the rows the blob
 * names that the catalog does not have yet, the second gives a profile to every
 * named row that has none. Re-running is a no-op in both: the insert is guarded
 * on existence, and the update fires only on `current_profile_version = 0`, so
 * a repository that already has a profile is left exactly as it is.
 *
 * A row created here is DISABLED. The rows that may be enabled are the ones the
 * allowlist and the definition pins seeded before this ran, and a repository
 * that only ever appeared in the checks configuration was never a grant: the
 * configuration says what to run IF the agent may touch a repository, never
 * that it may.
 */
export async function migrateScriptGroupsIntoProfiles(
  db: Db,
): Promise<{ repositoriesCreated: number; profilesCreated: number }> {
  const blobEntries = sql`
    WITH latest AS (
      SELECT config FROM ${prePrCheckConfigVersions} ORDER BY version DESC LIMIT 1
    ), entries AS (
      SELECT
        element.value AS entry,
        element.value->>'provider' AS provider,
        btrim(element.value->>'repoPath') AS path
      FROM latest,
        jsonb_array_elements(COALESCE(latest.config->'repositories', '[]'::jsonb))
          AS element(value)
      WHERE element.value->>'provider' IN ('github', 'gitlab')
        AND COALESCE(btrim(element.value->>'repoPath'), '') <> ''
    )
  `;
  const created = await db.execute(sql`
    ${blobEntries}
    INSERT INTO ${repositories} (
      provider, path, display_name, source, enabled, current_profile_version
    )
    SELECT entries.provider, entries.path, entries.path, 'migrated', false, 0
    FROM entries
    WHERE NOT EXISTS (
      SELECT 1 FROM ${repositories} AS existing
      WHERE existing.provider = entries.provider
        AND lower(existing.path) = lower(entries.path)
    )
    ON CONFLICT (provider, path) DO NOTHING
    RETURNING id
  `);
  const profiles = await db.execute(sql`
    ${blobEntries}, bumped AS (
      UPDATE ${repositories} AS target
      SET current_profile_version = 1, current_checks_version = 1, updated_at = now()
      FROM entries
      WHERE target.provider = entries.provider
        AND lower(target.path) = lower(entries.path)
        AND target.current_profile_version = 0
      RETURNING target.id AS id, entries.entry AS entry
    )
    INSERT INTO ${repositoryProfileVersions} (
      repository_id, version, script_groups, gate_groups, checks_version,
      actor_id, actor_label, reason
    )
    SELECT
      bumped.id, 1, bumped.entry,
      CASE
        WHEN jsonb_typeof(bumped.entry->'gateGroups') = 'array'
        THEN bumped.entry->'gateGroups'
        ELSE NULL
      END,
      1,
      'migration', 'migration',
      'script groups migration from pre_pr_check_config_versions'
    FROM bumped
    ON CONFLICT (repository_id, version) DO NOTHING
    RETURNING repository_id
  `);
  return {
    repositoriesCreated: ((created as { rows?: unknown[] }).rows ?? []).length,
    profilesCreated: ((profiles as { rows?: unknown[] }).rows ?? []).length,
  };
}
