/**
 * The repository catalog's whole database surface.
 *
 * Everything that reads or writes the catalog goes through here: the services
 * tier for the dashboard, and the engine's steps for the check configuration a
 * run executes. Nothing outside this file touches the three tables, which is
 * what keeps the client fence at zero and what lets the script groups migration
 * be one file to review rather than a diff spread over three tiers.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  REPOSITORY_CATALOG_SEED_ACTIVATION_REASON,
  REPOSITORY_CATALOG_SEED_ACTOR_ID,
  REPOSITORY_CATALOG_SEED_ACTOR_LABEL,
} from "@shared/contracts";
import type {
  PrePrCheckRepositoryConfig,
  RepositoryCatalogSource,
  RepositoryProfileField,
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
  /** Why the bridge was ended. Null on a deployment that activated before the
   *  column existed, which is not an empty reason. */
  activationReason: string | null;
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

/** A catalog row plus how many script groups the profile it resolves to
 *  declares. */
export type RepositoryCatalogRowWithGroupCount = RepositoryCatalogRow & {
  scriptGroupCount: number;
};

/**
 * Every catalog row with its script group count, in ONE query.
 *
 * The count is the number of keys under the stored entry's `groups` object,
 * read with `jsonb_object_keys` in a lateral, rather than a read per row: the
 * Repositories list renders every repository the deployment knows, and a count
 * per row would be a query per row on the one screen that already loads the
 * most.
 *
 * A profile that stores the legacy flat shape (a `commands` array and no
 * `groups`) counts 1, because that is exactly how many groups the engine
 * normalizes it into. A row with no profile, or a profile with no script
 * groups, counts 0.
 */
export async function listRepositoryCatalogRowsWithGroupCounts(
  db: Db,
): Promise<RepositoryCatalogRowWithGroupCount[]> {
  const rows = await db
    .select({
      row: repositories,
      // Correlated once per row inside the SAME statement, which is what "no
      // N+1" means here: one round trip, whatever the catalog's size. Written
      // as a subquery rather than a grouped join because the count is per
      // repository and a join on `jsonb_object_keys` would multiply the catalog
      // rows by their group counts before collapsing them again.
      //
      // The outer columns are spelled table-qualified rather than interpolated:
      // drizzle renders a column reference bare, and a bare `id` inside this
      // subquery binds to the PROFILE's own id, which silently correlates
      // nothing and returns every version of every repository.
      scriptGroupCount: sql<number>`(
        SELECT CASE
          WHEN jsonb_typeof(profile.script_groups->'groups') = 'object'
            THEN (SELECT count(*) FROM jsonb_object_keys(profile.script_groups->'groups'))
          WHEN jsonb_typeof(profile.script_groups->'commands') = 'array' THEN 1
          ELSE 0
        END
        FROM ${repositoryProfileVersions} AS profile
        WHERE profile.repository_id = "repositories"."id"
          AND profile.version = "repositories"."current_profile_version"
      )`,
    })
    .from(repositories)
    .orderBy(asc(repositories.provider), asc(repositories.path));
  return rows.map((row) =>
    Object.assign(row.row, { scriptGroupCount: Number(row.scriptGroupCount ?? 0) }),
  );
}

/**
 * The three columns a dispatch decision needs, and nothing else.
 *
 * Every HTTP request, cron tick and MCP call loads this, while the rules blob,
 * the relationships and the descriptions on the full row are read by the two
 * screens that render them. Selecting them on the dispatch path would move the
 * whole catalog across the wire on every webhook delivery for no answer it can
 * give.
 *
 * Not exported: its only caller is the connected wrapper below, and the
 * unused-code gate is right that a second entry point nobody has asked for is
 * not worth the export.
 */
function listRepositoryCatalogKeys(db: Db) {
  return db
    .select({
      provider: repositories.provider,
      path: repositories.path,
      enabled: repositories.enabled,
    })
    .from(repositories);
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
  /** Absent means unchanged; an explicit null clears the entry, which is how
   *  "no checks apply to this repository" is spelled. */
  scriptGroups?: Record<string, unknown> | null;
  gateGroups?: string[] | null;
  /** Absent means unchanged; an explicit null clears it back to the operator
   *  ceiling. */
  batchTimeoutMinutes?: number | null;
  actorId: string;
  actorLabel: string;
  reason: string;
  source?: RepositoryCatalogSource;
  /**
   * The profile version the caller believes is current, as a concurrency
   * token.
   *
   * A PREDICATE INSIDE THE STATEMENT, not a read before it. The screen used to
   * re-read the row and refuse when it had moved, which leaves the window
   * between the read and the write wide open; here the write itself selects no
   * candidate row when the version has moved, and the caller is told which
   * version is current instead. Absent means "write unconditionally", which is
   * what a client written before this field existed sends.
   */
  expectedProfileVersion?: number;
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
 * taken from there unless this call supplied one. For the three NULLABLE
 * profile fields (`script_groups`, `gate_groups`, `batch_timeout_minutes`) that
 * takes a `provided` flag rather than a COALESCE, because a null value and an
 * absent field are different requests and SQL cannot tell them apart from the
 * value alone: absent leaves the stored value, null clears it.
 *
 * The checks version moves only when `script_groups` or `gate_groups` actually
 * change, compared with `IS DISTINCT FROM` so that null and null match. That is
 * the whole point of keeping two counters: a run in flight fails at Finalize
 * when the commands it ran were re-configured under it, and survives somebody
 * fixing a typo in the repository's description. `batch_timeout_minutes`
 * deliberately does NOT move it: the ceiling is not a command, the gate
 * fingerprints commands, and a run in flight already froze the ceiling it
 * loaded.
 *
 * Two outcomes write nothing and both are normal, so the statement always
 * returns exactly one row saying which happened:
 *
 *   - **refused**, when `expectedProfileVersion` names a version that is no
 *     longer current. The predicate is inside the statement, so there is no
 *     window between checking and writing;
 *   - **unchanged**, when nothing this request asks for differs from what is
 *     stored. No version is minted, because the history is what an operator
 *     reads to find out what changed and a row per click is how it stops being
 *     readable.
 *
 * The `ON CONFLICT` clause is not redundant with `existing`: the lookup is case
 * insensitive and the unique index is not, so two writers racing on the exact
 * same casing still resolve to an update rather than a duplicate key error. It
 * bumps the checks version unconditionally, because in that race `resolved`
 * computed against no row at all; bumping fails an in-flight gate that might
 * have survived, which is the safe direction.
 */
export interface UpsertRepositoryProfileResult {
  id: number;
  version: number;
  checksVersion: number;
  /** False when this call wrote no version row: nothing it asked for differed
   *  from what is stored. `version` is then the version already current. */
  minted: boolean;
  /** Which profile fields moved. Empty exactly when `minted` is false, or when
   *  the call created a repository whose first profile sets nothing. */
  changedFields: RepositoryProfileField[];
}

/** The conflict outcome: the write was refused because the profile moved. */
export interface UpsertRepositoryProfileConflict {
  conflict: true;
  currentVersion: number;
}

// A caller that sends no `expectedProfileVersion` asked for no concurrency
// check, so no conflict can come back and the overload says so. Without this
// every caller would have to narrow a union one of its two arms can never
// take, which is noise that hides the callers where the check is real.
export function upsertRepositoryProfile(
  db: Db,
  input: UpsertRepositoryProfileInput & { expectedProfileVersion: number },
): Promise<UpsertRepositoryProfileResult | UpsertRepositoryProfileConflict>;
export function upsertRepositoryProfile(
  db: Db,
  input: UpsertRepositoryProfileInput & { expectedProfileVersion?: undefined },
): Promise<UpsertRepositoryProfileResult>;
export async function upsertRepositoryProfile(
  db: Db,
  input: UpsertRepositoryProfileInput,
): Promise<UpsertRepositoryProfileResult | UpsertRepositoryProfileConflict> {
  const text = (value: string | undefined) =>
    value === undefined ? sql`NULL::text` : sql`${value}::text`;
  const json = (value: unknown | null | undefined) =>
    value === undefined || value === null
      ? sql`NULL::jsonb`
      : sql`${JSON.stringify(value)}::jsonb`;
  // Literal keywords rather than bound parameters: a bare `$1` in a CASE
  // predicate leaves Postgres unable to infer the parameter's type, and these
  // three flags are decided here, not by the caller's data.
  const flag = (value: boolean) => (value ? sql`TRUE` : sql`FALSE`);
  const scriptGroups = json(input.scriptGroups);
  const gateGroups = json(input.gateGroups);
  const batchTimeout =
    input.batchTimeoutMinutes === undefined || input.batchTimeoutMinutes === null
      ? sql`NULL::integer`
      : sql`${input.batchTimeoutMinutes}::integer`;
  const expected =
    input.expectedProfileVersion === undefined
      ? sql`NULL::integer`
      : sql`${input.expectedProfileVersion}::integer`;
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
        stored.current_profile_version AS current_profile_version,
        stored.current_checks_version AS current_checks_version,
        current_profile.script_groups AS script_groups,
        current_profile.gate_groups AS gate_groups,
        current_profile.batch_timeout_minutes AS batch_timeout_minutes
      FROM ${repositories} AS stored
      LEFT JOIN ${repositoryProfileVersions} AS current_profile
        ON current_profile.repository_id = stored.id
       AND current_profile.version = stored.current_profile_version
      WHERE stored.provider = ${input.provider}
        AND lower(stored.path) = ${input.path.toLowerCase()}
      LIMIT 1
    ), resolved AS (
      SELECT
        existing.id AS existing_id,
        COALESCE(existing.current_profile_version, 0) AS existing_profile_version,
        COALESCE(existing.current_checks_version, 0) AS existing_checks_version,
        COALESCE(${text(input.displayName)}, existing.display_name, ${input.path})
          AS display_name,
        COALESCE(${text(input.defaultBranch)}, existing.default_branch, '')
          AS default_branch,
        COALESCE(${text(input.description)}, existing.description, '') AS description,
        COALESCE(${text(input.rules)}, existing.rules, '') AS rules,
        COALESCE(${json(input.relationships)}, existing.relationships, '[]'::jsonb)
          AS relationships,
        CASE WHEN ${flag(input.scriptGroups !== undefined)}
          THEN ${scriptGroups} ELSE existing.script_groups END AS script_groups,
        CASE WHEN ${flag(input.gateGroups !== undefined)}
          THEN ${gateGroups} ELSE existing.gate_groups END AS gate_groups,
        CASE WHEN ${flag(input.batchTimeoutMinutes !== undefined)}
          THEN ${batchTimeout} ELSE existing.batch_timeout_minutes END
          AS batch_timeout_minutes,
        COALESCE(existing.description, '') AS prior_description,
        COALESCE(existing.rules, '') AS prior_rules,
        COALESCE(existing.relationships, '[]'::jsonb) AS prior_relationships,
        existing.script_groups AS prior_script_groups,
        existing.gate_groups AS prior_gate_groups,
        existing.batch_timeout_minutes AS prior_batch_timeout_minutes
      FROM (SELECT 1) AS anchor
      LEFT JOIN existing ON true
    ), decided AS (
      SELECT
        resolved.*,
        (resolved.existing_id IS NULL) AS creating,
        (${expected} IS NULL OR ${expected} = resolved.existing_profile_version)
          AS allowed,
        (resolved.description IS DISTINCT FROM resolved.prior_description)
          AS changed_description,
        (resolved.rules IS DISTINCT FROM resolved.prior_rules) AS changed_rules,
        (resolved.relationships IS DISTINCT FROM resolved.prior_relationships)
          AS changed_relationships,
        (resolved.script_groups IS DISTINCT FROM resolved.prior_script_groups)
          AS changed_script_groups,
        (resolved.gate_groups IS DISTINCT FROM resolved.prior_gate_groups)
          AS changed_gate_groups,
        (resolved.batch_timeout_minutes
           IS DISTINCT FROM resolved.prior_batch_timeout_minutes)
          AS changed_batch_timeout_minutes,
        CASE
          WHEN resolved.existing_id IS NULL
            THEN CASE
              WHEN resolved.script_groups IS NULL AND resolved.gate_groups IS NULL
                THEN 0
              ELSE 1
            END
          WHEN resolved.script_groups IS NOT DISTINCT FROM resolved.prior_script_groups
           AND resolved.gate_groups IS NOT DISTINCT FROM resolved.prior_gate_groups
            THEN resolved.existing_checks_version
          ELSE resolved.existing_checks_version + 1
        END AS checks_version
      FROM resolved
    ), planned AS (
      SELECT
        decided.*,
        (
          decided.creating
          OR decided.changed_description
          OR decided.changed_rules
          OR decided.changed_relationships
          OR decided.changed_script_groups
          OR decided.changed_gate_groups
          OR decided.changed_batch_timeout_minutes
        ) AS changed
      FROM decided
    ), inserted AS (
      INSERT INTO ${repositories} (
        provider, path, display_name, default_branch, description, rules,
        relationships, enabled, source, current_profile_version,
        current_checks_version
      )
      SELECT
        ${input.provider}, ${input.path}, planned.display_name,
        planned.default_branch, planned.description, planned.rules,
        planned.relationships, ${input.enabled ?? false}, ${source}, 1,
        planned.checks_version
      FROM planned
      WHERE planned.creating AND planned.allowed
      -- Reachable only when somebody else inserted this repository between the
      -- existing read above and this INSERT. planned was computed against a row
      -- that did not exist, so every value it carries for a field this call did
      -- NOT supply is the empty fallback, not the stored one: writing EXCLUDED
      -- unconditionally would blank the winner's description, rules or default
      -- branch. Each column is therefore written only when the request actually
      -- carried it, exactly as the resolved CTE decides for the ordinary path.
      -- What this statement cannot recover is the three profile-only fields,
      -- which live on the version row and are invisible to this snapshot; the
      -- version minted by a lost create race carries this call's values for
      -- those. A create race is rare and both writers are authoring the same
      -- repository, so a lost script-groups edit is a stale version to re-save,
      -- not a blanked repository.
      ON CONFLICT (provider, path) DO UPDATE SET
        display_name = CASE WHEN ${flag(input.displayName !== undefined)}
          THEN EXCLUDED.display_name ELSE ${repositories}.display_name END,
        default_branch = CASE WHEN ${flag(input.defaultBranch !== undefined)}
          THEN EXCLUDED.default_branch ELSE ${repositories}.default_branch END,
        description = CASE WHEN ${flag(input.description !== undefined)}
          THEN EXCLUDED.description ELSE ${repositories}.description END,
        rules = CASE WHEN ${flag(input.rules !== undefined)}
          THEN EXCLUDED.rules ELSE ${repositories}.rules END,
        relationships = CASE WHEN ${flag(input.relationships !== undefined)}
          THEN EXCLUDED.relationships ELSE ${repositories}.relationships END,
        current_profile_version = ${repositories}.current_profile_version + 1,
        current_checks_version = ${repositories}.current_checks_version + 1,
        updated_at = now()
      RETURNING id, current_profile_version, current_checks_version,
        description, rules, relationships
    ), updated AS (
      UPDATE ${repositories} SET
        -- Identity, and only when this call actually carried it. planned
        -- already coalesces an omitted field to the stored value, so this is
        -- belt and braces for the two fields a screen must never move: a
        -- Repositories tab that saves rules does not send a display name or a
        -- default branch, and a stale screen that once read them must not be
        -- able to write them back over a provider import or a backfill.
        display_name = CASE WHEN ${flag(input.displayName !== undefined)}
          THEN planned.display_name ELSE ${repositories}.display_name END,
        default_branch = CASE WHEN ${flag(input.defaultBranch !== undefined)}
          THEN planned.default_branch ELSE ${repositories}.default_branch END,
        description = planned.description,
        rules = planned.rules,
        relationships = planned.relationships,
        current_profile_version = ${repositories}.current_profile_version + 1,
        current_checks_version = planned.checks_version,
        updated_at = now()
      FROM planned
      WHERE ${repositories}.id = planned.existing_id
        -- The predicate travels with the write. planned.allowed was computed
        -- from the version the existing read saw, so on its own it is a read
        -- and then a write; re-stating the version against the row being
        -- updated is what makes the concurrency token a qual this UPDATE
        -- evaluates, so a version that moved between the two selects no row
        -- here rather than being overwritten.
        AND ${repositories}.current_profile_version = planned.existing_profile_version
        AND planned.allowed
        AND planned.changed
      RETURNING ${repositories}.id, ${repositories}.current_profile_version,
        ${repositories}.current_checks_version, ${repositories}.description,
        ${repositories}.rules, ${repositories}.relationships
    ), target AS (
      -- The values as WRITTEN, not as planned: on the create-race path above
      -- they differ, and the version row must record what the repository row
      -- actually holds.
      SELECT id, current_profile_version, current_checks_version,
        description, rules, relationships FROM inserted
      UNION ALL
      SELECT id, current_profile_version, current_checks_version,
        description, rules, relationships FROM updated
    ), minted AS (
      INSERT INTO ${repositoryProfileVersions} (
        repository_id, version, description, rules, relationships,
        script_groups, gate_groups, batch_timeout_minutes, checks_version,
        actor_id, actor_label, reason
      )
      SELECT
        target.id, target.current_profile_version, target.description,
        target.rules, target.relationships, planned.script_groups,
        planned.gate_groups, planned.batch_timeout_minutes,
        target.current_checks_version, ${input.actorId}, ${input.actorLabel},
        ${input.reason}
      FROM target, planned
      RETURNING repository_id AS id, version, checks_version
    )
    SELECT
      COALESCE((SELECT id FROM minted), planned.existing_id) AS id,
      COALESCE((SELECT version FROM minted), planned.existing_profile_version)
        AS version,
      COALESCE((SELECT checks_version FROM minted), planned.existing_checks_version)
        AS checks_version,
      EXISTS (SELECT 1 FROM minted) AS minted,
      -- Allowed is not what the snapshot decided, it is what the write did.
      -- planned.allowed compares the token against the version the existing
      -- read saw; the UPDATE re-states that version as a qual, so a commit that
      -- lands between the two matches no row and writes nothing. Reporting the
      -- snapshot's verdict there would answer a refused write with
      -- minted = false and allowed = true, which the service maps to
      -- unchanged: true, and the screen would say the stored profile already
      -- matches a change it never took. A planned change that wrote no row is a
      -- conflict, and falls into the same 409 path as a stale token.
      (
        planned.allowed
        AND (NOT planned.changed OR EXISTS (SELECT 1 FROM target))
      ) AS allowed,
      -- The version the caller has to reload past. On the lost-race path this
      -- is the version the snapshot saw rather than the one the winner minted:
      -- a re-read here would run on this statement's snapshot and return the
      -- same number, so the honest answer is "your token is no longer current,
      -- read the row again", which is what the 409 tells the screen to do.
      planned.existing_profile_version AS current_version,
      planned.changed_description,
      planned.changed_rules,
      planned.changed_relationships,
      planned.changed_script_groups,
      planned.changed_gate_groups,
      planned.changed_batch_timeout_minutes
    FROM planned
  `);
  const row = (
    result as {
      rows?: Array<{
        id: number | null;
        version: number;
        checks_version: number;
        minted: boolean;
        allowed: boolean;
        current_version: number;
        changed_description: boolean;
        changed_rules: boolean;
        changed_relationships: boolean;
        changed_script_groups: boolean;
        changed_gate_groups: boolean;
        changed_batch_timeout_minutes: boolean;
      }>;
    }
  ).rows?.[0];
  if (!row) throw new Error("repository profile upsert returned no outcome");
  if (!row.allowed) {
    return { conflict: true, currentVersion: Number(row.current_version) };
  }
  if (row.id === null) throw new Error("repository profile upsert returned no row id");
  const changedFields: RepositoryProfileField[] = [];
  if (row.changed_description) changedFields.push("description");
  if (row.changed_rules) changedFields.push("rules");
  if (row.changed_relationships) changedFields.push("relationships");
  if (row.changed_script_groups) changedFields.push("scriptGroups");
  if (row.changed_gate_groups) changedFields.push("gateGroups");
  if (row.changed_batch_timeout_minutes) changedFields.push("batchTimeoutMinutes");
  return {
    id: Number(row.id),
    version: Number(row.version),
    checksVersion: Number(row.checks_version),
    minted: Boolean(row.minted),
    changedFields,
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

/** One repository's standing rules, as the current profile version holds them. */
export interface RepositoryRulesRow {
  /** `provider:owner/name`, cased down: the key a run carries. */
  key: string;
  /** The profile version the rules came from, so a compiled prompt can record
   *  which edit it was built on. */
  version: number;
  rules: string;
}

/**
 * The rules of the named repositories, read over the SAME current-profile-
 * version join the script groups are composed from at block time
 * (`listRepositoriesWithProfiles` above, `getCurrentCheckConfiguration` below).
 *
 * The key set is pushed into the query rather than filtered afterwards: this
 * sits on the critical path before the agent starts, up to three times a run,
 * and a deployment's catalog is far larger than the handful of repositories one
 * run opens. So the database returns the run's rows, not the catalog's.
 *
 * The composite key is spelled table-qualified inside the template. Drizzle
 * renders a column reference bare, and a bare name is whatever the innermost
 * scope binds it to; qualifying it is what keeps this predicate about
 * `repositories` no matter what the join adds later.
 *
 * A repository with no profile, or a profile whose rules are blank, contributes
 * nothing rather than an empty section: an empty heading in a prompt reads as
 * "this repository deliberately has no rules", which is not what a repository
 * nobody has configured yet means. The blank check is in SQL for the same
 * reason the key match is, and it is a POSIX class rather than `btrim`, whose
 * one-argument form trims spaces only and would let a rules field of newlines
 * through.
 *
 * The engine reaches it through the connected wrapper below, which is the only
 * caller a step can have; the db-taking form is exported for the test that
 * proves the composite-key predicate really is a predicate.
 */
export async function listRepositoryRules(
  db: Db,
  keys: readonly string[],
): Promise<RepositoryRulesRow[]> {
  if (keys.length === 0) return [];
  const key = sql<string>`(
    "repositories"."provider" || ':' || lower("repositories"."path")
  )`;
  const rows = await db
    .select({
      key,
      version: repositoryProfileVersions.version,
      rules: repositoryProfileVersions.rules,
    })
    .from(repositories)
    .innerJoin(
      repositoryProfileVersions,
      and(
        eq(repositoryProfileVersions.repositoryId, repositories.id),
        eq(repositoryProfileVersions.version, repositories.currentProfileVersion),
      ),
    )
    .where(
      and(
        inArray(key, [...new Set(keys)]),
        sql`${repositoryProfileVersions.rules} !~ '^[[:space:]]*$'`,
      ),
    )
    .orderBy(asc(repositories.provider), asc(repositories.path));
  return rows.map((row) => ({
    key: row.key,
    version: row.version,
    rules: row.rules,
  }));
}

/**
 * The state row as stored, or null when no build has ever written one.
 *
 * The two are NOT the same fact, which is why this exists next to the reader
 * below. "No row yet" means nothing has been decided; "a row saying false"
 * means some build decided the catalog is off, and because the seed writes with
 * `onConflictDoNothing`, no later build can change its mind. Only the build
 * gate needs to tell them apart, and it has to
 * (`seedActivationConflict` in services/repository-catalog/policy.ts).
 */
export async function readRepositoryCatalogStateRow(
  db: Db,
): Promise<RepositoryCatalogStateRow | null> {
  const [row] = await db.select().from(repositoryCatalogState).limit(1);
  return row
    ? {
        activated: row.activated,
        activatedAt: row.activatedAt,
        activatedById: row.activatedById,
        activatedByLabel: row.activatedByLabel,
        activationReason: row.activationReason,
      }
    : null;
}

export async function getRepositoryCatalogStateRow(
  db: Db,
): Promise<RepositoryCatalogStateRow> {
  // Absent means "never seeded and never activated", which is the bridge: a
  // deployment whose build has not run the seed yet, and every unit test that
  // only replays migrations. It is NOT a statement that the deployment is
  // unrestricted on purpose. A deployment that DOES restrict itself through
  // AGENT_ALLOWED_REPOS and finds a stored row saying false is a build failure,
  // not a bridge (see `readRepositoryCatalogStateRow` above); this reader
  // deliberately cannot see the difference, because nothing at runtime should
  // act on it.
  return (
    (await readRepositoryCatalogStateRow(db)) ?? {
      activated: false,
      activatedAt: null,
      activatedById: null,
      activatedByLabel: null,
      activationReason: null,
    }
  );
}

/** One statement, so a second click cannot create a second state row. */
export async function activateRepositoryCatalog(
  db: Db,
  input: { actorId: string; actorLabel?: string; reason: string; now?: Date },
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
      activationReason: input.reason,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: repositoryCatalogState.id,
      set: {
        activated: true,
        activatedAt: now,
        activatedById: input.actorId,
        activatedByLabel: actorLabel,
        activationReason: input.reason,
        updatedAt: now,
      },
    })
    .returning();
  return {
    activated: row?.activated ?? true,
    activatedAt: row?.activatedAt ?? now,
    activatedById: row?.activatedById ?? input.actorId,
    activatedByLabel: row?.activatedByLabel ?? actorLabel,
    activationReason: row?.activationReason ?? input.reason,
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
 * The legacy global blob contributes exactly one thing now: the version counter
 * the publication gate has always recorded. Its `repositories` payload is read
 * by nobody after this stage; the cleanup stage drops the table.
 *
 * `batchTimeoutMinutes` comes from the profiles too, as the LARGEST value any
 * composed repository asks for. It is a whole-run ceiling shared by every
 * repository in the batch, so what a profile records is a claim about how long
 * THIS repository's checks take; honouring the smallest claim would starve the
 * repository that asked for more, and honouring the last one read would make
 * the answer depend on the catalog's sort order.
 *
 * `repositoryKeys` is what makes "any composed repository" mean the run's
 * repositories rather than the whole catalog. Without it, one repository
 * somewhere in the catalog asking for 120 minutes raised the ceiling of every
 * run in the deployment, including runs that never open it, and because the
 * value was then always set the operator ceiling could never apply again. So a
 * caller that knows which repositories the run touches passes them, the MAX is
 * taken over those profiles alone, and when none of them asks for anything the
 * field is left unset, which is how `checksCeilingMsOf` is told to use the
 * operator ceiling. A scoped call does NOT consult the legacy global blob: that
 * blob is one number for the deployment and cannot say anything about which
 * repositories this run entered.
 *
 * With `repositoryKeys` absent the answer is the deployment-wide one it has
 * always been, legacy fallback included. That is the shape the callers who want
 * a configuration rather than a ceiling still ask for.
 *
 * `enabled` is deliberately NOT a filter here. This composes what to run in a
 * repository, and a run never reaches a repository it may not touch: the run
 * carries its own enabled set, decided once when it was dispatched, so a
 * repository switched off while checks are in flight must not have its commands
 * vanish from under the run that is already inside it. Filtering here would
 * also make the catalog's on/off switch move what the checks do, which is the
 * one thing `setRepositoryEnabled` promises it never does.
 */
export interface CurrentCheckConfigurationOptions {
  /** `provider:owner/name` for the repositories this run touches. Absent means
   *  the whole catalog; see the note on the ceiling above. */
  repositoryKeys?: readonly string[];
}

export async function getCurrentCheckConfiguration(
  db: Db,
  options: CurrentCheckConfigurationOptions = {},
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
  let profileBatchTimeoutMinutes: number | null = null;
  // null means "no scope given": every profile counts towards the ceiling, the
  // deployment-wide answer. A Set, even an empty one, scopes it.
  const scope =
    options.repositoryKeys === undefined ? null : new Set(options.repositoryKeys);
  for (const { repository, profile } of withProfiles) {
    if (!profile?.scriptGroups) continue;
    if (!newest || profile.createdAt > newest.createdAt) newest = profile;
    const key = repositoryKeyOf(repository);
    const entry = {
      ...(profile.scriptGroups as Record<string, unknown>),
      provider: repository.provider,
      repoPath: repository.path,
      ...(profile.gateGroups ? { gateGroups: profile.gateGroups } : {}),
    } as PrePrCheckRepositoryConfig;
    entries.push(entry);
    repositoryVersions[key] = profile.checksVersion;
    if (
      typeof profile.batchTimeoutMinutes === "number" &&
      (scope === null || scope.has(key))
    ) {
      profileBatchTimeoutMinutes = Math.max(
        profileBatchTimeoutMinutes ?? 0,
        profile.batchTimeoutMinutes,
      );
    }
  }
  const batchTimeoutMinutes =
    scope === null
      ? profileBatchTimeoutMinutes ??
        (legacy?.config as { batchTimeoutMinutes?: number } | undefined)
          ?.batchTimeoutMinutes
      : (profileBatchTimeoutMinutes ?? undefined);
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

export function listConnectedRepositoryCatalogRowsWithGroupCounts() {
  return listRepositoryCatalogRowsWithGroupCounts(getDb());
}

export function listConnectedRepositoryCatalogKeys() {
  return listRepositoryCatalogKeys(getDb());
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

export function upsertConnectedRepositoryProfile(
  input: UpsertRepositoryProfileInput & { expectedProfileVersion: number },
): Promise<UpsertRepositoryProfileResult | UpsertRepositoryProfileConflict>;
export function upsertConnectedRepositoryProfile(
  input: UpsertRepositoryProfileInput & { expectedProfileVersion?: undefined },
): Promise<UpsertRepositoryProfileResult>;
export function upsertConnectedRepositoryProfile(input: UpsertRepositoryProfileInput) {
  // Branching rather than casting: the two overloads differ in what they can
  // RETURN, and a cast picks the wider one for every caller, including the ones
  // that told the type system they sent no token and can therefore never see a
  // conflict. This narrows on the same field the overloads are keyed on, so the
  // implementation agrees with the signature instead of overruling it.
  const { expectedProfileVersion, ...rest } = input;
  return expectedProfileVersion === undefined
    ? upsertRepositoryProfile(getDb(), rest)
    : upsertRepositoryProfile(getDb(), { ...rest, expectedProfileVersion });
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
  reason: string;
  now?: Date;
}) {
  return activateRepositoryCatalog(getDb(), input);
}

export function listConnectedClaimedRepositoriesNotEnabled() {
  return listClaimedRepositoriesNotEnabled(getDb());
}

export function getConnectedCurrentCheckConfiguration(
  options: CurrentCheckConfigurationOptions = {},
) {
  return getCurrentCheckConfiguration(getDb(), options);
}

export function listConnectedRepositoryRules(keys: readonly string[]) {
  return listRepositoryRules(getDb(), keys);
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
  repositories: Array<{ provider: string; path: string; defaultBranch?: string }>;
  enabled: boolean;
}) {
  return seedRepositoryCatalogEntries(getDb(), {
    repositories: input.repositories,
    enabled: input.enabled,
    source: "imported",
  });
}

export function backfillConnectedRepositoryDefaultBranches(
  directory: ReadonlyArray<{ provider: string; path: string; defaultBranch: string }>,
) {
  return backfillRepositoryDefaultBranches(getDb(), directory);
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
    repositories: Array<{ provider: string; path: string; defaultBranch?: string }>;
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
  const unique: Array<{ provider: string; path: string; defaultBranch?: string }> = [];
  for (const repository of input.repositories) {
    const key = `${repository.provider}:${repository.path.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(repository);
  }
  if (unique.length === 0) return 0;
  const values = sql.join(
    unique.map(
      (repository) =>
        sql`(${repository.provider}, ${repository.path}, ${repository.defaultBranch ?? ""})`,
    ),
    sql`, `,
  );
  const result = await db.execute(sql`
    INSERT INTO ${repositories} (
      provider, path, display_name, default_branch, source, enabled,
      current_profile_version
    )
    SELECT
      candidate.provider, candidate.path, candidate.path,
      candidate.default_branch, ${input.source}, ${input.enabled}, 0
    FROM (VALUES ${values}) AS candidate(provider, path, default_branch)
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
 * Fill in the default branch on rows that have none, from a provider listing.
 *
 * The rows the allowlist seed created carry no default branch at all: the seed
 * reads a comma-separated variable, which knows the path and nothing else, so
 * every seeded entry reports "default branch: not recorded" until somebody
 * types one, and no screen lets them. This is the one-off repair, and it runs
 * whenever a caller already holds a provider listing (the import commit, and
 * the build-time seed when it can list).
 *
 * Only EMPTY values are filled. A recorded branch is left exactly as it is: the
 * provider's default can change, and quietly rewriting a stored value from a
 * listing would be this function deciding something it was not asked to decide.
 *
 * One statement, like every other multi-row write here, because neon-http
 * cannot open a transaction.
 */
export async function backfillRepositoryDefaultBranches(
  db: Db,
  candidates: ReadonlyArray<{ provider: string; path: string; defaultBranch: string }>,
): Promise<number> {
  const usable = candidates.filter(
    (candidate) => candidate.defaultBranch.trim().length > 0,
  );
  if (usable.length === 0) return 0;
  const values = sql.join(
    usable.map(
      (candidate) =>
        sql`(${candidate.provider}, ${candidate.path.toLowerCase()}, ${candidate.defaultBranch})`,
    ),
    sql`, `,
  );
  const result = await db.execute(sql`
    UPDATE ${repositories} AS target
    SET default_branch = candidate.default_branch, updated_at = now()
    FROM (VALUES ${values}) AS candidate(provider, path, default_branch)
    WHERE target.provider = candidate.provider
      AND lower(target.path) = candidate.path
      AND COALESCE(btrim(target.default_branch), '') = ''
    RETURNING target.id
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
      activatedById: input.activated ? REPOSITORY_CATALOG_SEED_ACTOR_ID : null,
      activatedByLabel: input.activated ? REPOSITORY_CATALOG_SEED_ACTOR_LABEL : null,
      // The seed records a reason for the same purpose an operator does: the
      // History surface reads one line per activation and an activation nobody
      // clicked is the one most worth explaining.
      activationReason: input.activated
        ? REPOSITORY_CATALOG_SEED_ACTIVATION_REASON
        : null,
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
