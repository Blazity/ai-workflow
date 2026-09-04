import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, isNull, or, sql } from "drizzle-orm";

import type { Db } from "../src/db/client.js";
import {
  oauthClientResource,
  oauthConsent,
  oauthResource,
} from "../src/db/schema.js";
import { MCP_SCOPES } from "../src/mcp/contracts.js";
import { canonicalMcpResource } from "../src/mcp/oauth.js";

const OFFLINE_ACCESS_SCOPE = "offline_access";
const LOCK_TIMEOUT = "5s";
const AIW_331_HANDOFF =
  "AIW-331 handoff: rerun this command immediately before the package switch; " +
  "start with enforcePerClientResources=false, configure the canonical resource " +
  "as the DCR default, then reconcile and postflight. Keep enforcement false for " +
  "all of AIW-331; AIW-332 may enable it only after the Better Auth 1.6 drain, " +
  "the rollout/rollback window, and a zero-missing postflight.";

export interface PrepareMcpOauthResourcesOptions {
  apply: boolean;
  confirmProduction: boolean;
  confirmSingleAudienceHistory: boolean;
  targetEnvironment: string;
}

export interface PrepareMcpOauthResourcesDeployment {
  databaseUrl: string;
  betterAuthUrl: string;
  canonicalResource: string;
  endpointHost: string;
  targetEnvironment: string;
}

export interface PreparationCounts {
  clients: number;
  resources: number;
  clientLinks: number;
  refreshTokens: number;
  accessTokens: number;
  consents: number;
  preservedUnboundRefreshTokens: number;
  preservedUnboundAccessTokens: number;
}

export interface PreparationMutations {
  resources: number;
  clientLinks: number;
  consents: number;
}

export interface PrepareMcpOauthResourcesResult {
  mode: "dry-run" | "apply";
  targetEnvironment: string;
  endpointHost: string;
  canonicalResource: string;
  counts: PreparationCounts;
  planned: PreparationMutations;
  applied: PreparationMutations;
  singleAudienceHistoryConfirmed: boolean;
  consentHistoryConfirmationRequired: boolean;
  handoff: string;
}

export interface PrepareMcpOauthResourcesDependencies {
  afterWrites?: (db: Db) => Promise<void>;
  acquireLocks?: (db: Db) => Promise<void>;
}

export interface PrepareMcpOauthResourcesCliDependencies {
  environment?: NodeJS.ProcessEnv;
  openDatabase?: (databaseUrl: string) => Promise<{
    db: Db;
    close: () => Promise<void>;
  }>;
  write?: (text: string) => void;
}

interface DatabaseState {
  counts: PreparationCounts;
  blockers: string[];
  canonicalResourceExists: boolean;
  missingClientIds: string[];
  consentsToBackfill: number;
}

export function parsePrepareMcpOauthResourcesArguments(
  argv: readonly string[],
): PrepareMcpOauthResourcesOptions {
  let apply = false;
  let confirmProduction = false;
  let confirmSingleAudienceHistory = false;
  let targetEnvironment: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      if (apply) throw new Error("Duplicate flag: --apply");
      apply = true;
      continue;
    }
    if (arg === "--confirm-production") {
      if (confirmProduction) {
        throw new Error("Duplicate flag: --confirm-production");
      }
      confirmProduction = true;
      continue;
    }
    if (arg === "--confirm-single-audience-history") {
      if (confirmSingleAudienceHistory) {
        throw new Error("Duplicate flag: --confirm-single-audience-history");
      }
      confirmSingleAudienceHistory = true;
      continue;
    }
    if (arg === "--target-environment") {
      if (targetEnvironment !== undefined) {
        throw new Error("Duplicate flag: --target-environment");
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --target-environment");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new Error("Invalid value for --target-environment");
      }
      targetEnvironment = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }

  if (!targetEnvironment) {
    throw new Error("Missing required flag: --target-environment");
  }
  if (apply && targetEnvironment === "production" && !confirmProduction) {
    throw new Error(
      "Refusing --apply for production without --confirm-production.",
    );
  }

  return {
    apply,
    confirmProduction,
    confirmSingleAudienceHistory,
    targetEnvironment,
  };
}

export function normalizeDatabaseHostname(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }
  if (!parsed.hostname) {
    throw new Error("DATABASE_URL must contain a hostname.");
  }
  return parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
}

export function resolvePrepareMcpOauthResourcesDeployment(
  options: PrepareMcpOauthResourcesOptions,
  environment: NodeJS.ProcessEnv,
): PrepareMcpOauthResourcesDeployment {
  const productionRuntime =
    environment.NODE_ENV === "production" ||
    environment.VERCEL_ENV === "production";
  if (
    options.apply &&
    (options.targetEnvironment === "production" || productionRuntime) &&
    !options.confirmProduction
  ) {
    throw new Error(
      "Refusing --apply in production without --confirm-production.",
    );
  }
  const databaseUrl = environment.DATABASE_URL;
  const betterAuthUrl = environment.BETTER_AUTH_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  if (!betterAuthUrl) throw new Error("BETTER_AUTH_URL is required.");
  let parsedBetterAuthUrl: URL;
  try {
    parsedBetterAuthUrl = new URL(betterAuthUrl);
  } catch {
    throw new Error("BETTER_AUTH_URL must be a valid HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(parsedBetterAuthUrl.protocol) ||
    !parsedBetterAuthUrl.hostname ||
    parsedBetterAuthUrl.username ||
    parsedBetterAuthUrl.password
  ) {
    throw new Error(
      "BETTER_AUTH_URL must be an HTTP(S) URL without credentials.",
    );
  }

  return {
    databaseUrl,
    betterAuthUrl,
    canonicalResource: canonicalMcpResource(betterAuthUrl),
    endpointHost: normalizeDatabaseHostname(databaseUrl),
    targetEnvironment: options.targetEnvironment,
  };
}

async function rows<T extends Record<string, unknown>>(
  db: Db,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as {
    rows?: T[];
  } | T[];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rows)) return result.rows;
  throw new Error("Database driver returned an unsupported query result.");
}

async function assertExpandedSchema(db: Db): Promise<void> {
  const expectedTables = ["oauth_client_resource", "oauth_resource"];
  const expectedColumns = [
    ["oauth_access_token", "resources"],
    ["oauth_consent", "resources"],
    ["oauth_refresh_token", "resources"],
  ] as const;
  const tables = await rows<{ table_name: string }>(db, sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('oauth_client_resource', 'oauth_resource')
  `);
  const columns = await rows<{ table_name: string; column_name: string }>(db, sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('oauth_access_token', 'resources'),
        ('oauth_consent', 'resources'),
        ('oauth_refresh_token', 'resources')
      )
  `);
  const foundTables = new Set(tables.map((row) => row.table_name));
  const foundColumns = new Set(
    columns.map((row) => `${row.table_name}.${row.column_name}`),
  );
  const missing = [
    ...expectedTables
      .filter((table) => !foundTables.has(table))
      .map((table) => `table public.${table}`),
    ...expectedColumns
      .filter(([table, column]) => !foundColumns.has(`${table}.${column}`))
      .map(([table, column]) => `column public.${table}.${column}`),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Better Auth expand migration 0058 is incomplete; missing ${missing.join(", ")}.`,
    );
  }
}

async function assertEnvironmentMarker(
  db: Db,
  deployment: PrepareMcpOauthResourcesDeployment,
): Promise<void> {
  const markers = await rows<{
    id: number;
    env: string;
    endpoint_host: string;
  }>(db, sql`
    SELECT id, env, endpoint_host
    FROM env_marker
    ORDER BY id
  `);
  if (markers.length !== 1 || markers[0]?.id !== 1) {
    throw new Error("env_marker must contain exactly the id=1 deployment marker.");
  }
  const marker = markers[0];
  if (marker.env !== deployment.targetEnvironment) {
    throw new Error(
      `env_marker environment mismatch: expected '${deployment.targetEnvironment}', found '${marker.env}'.`,
    );
  }
  const markerHost = marker.endpoint_host
    .toLowerCase()
    .replace(/-pooler(?=\.)/, "");
  if (markerHost !== deployment.endpointHost) {
    throw new Error(
      `env_marker endpoint mismatch: expected '${deployment.endpointHost}', found '${markerHost}'.`,
    );
  }
}

function blocker(label: string, value: number): string | null {
  return value > 0 ? `${label}: ${value}` : null;
}

async function inspectDatabaseState(
  db: Db,
  deployment: PrepareMcpOauthResourcesDeployment,
): Promise<DatabaseState> {
  await assertExpandedSchema(db);
  await assertEnvironmentMarker(db, deployment);

  const canonical = deployment.canonicalResource;
  const allowedConsentScopes = [...MCP_SCOPES, OFFLINE_ACCESS_SCOPE];
  const allowedConsentScopeList = sql.join(
    allowedConsentScopes.map((scope) => sql`${scope}`),
    sql`, `,
  );
  const resourceRows = await rows<{
    identifier: string;
    access_token_ttl: number | null;
    refresh_token_ttl: number | null;
    signing_algorithm: string | null;
    signing_key_id: string | null;
    allowed_scopes: string[] | null;
    custom_claims_is_null: boolean;
    dpop_bound_access_tokens_required: boolean | null;
    disabled: boolean | null;
    policy_version: number | null;
  }>(db, sql`
    SELECT
      identifier,
      access_token_ttl,
      refresh_token_ttl,
      signing_algorithm,
      signing_key_id,
      allowed_scopes,
      custom_claims IS NULL AS custom_claims_is_null,
      dpop_bound_access_tokens_required,
      disabled,
      policy_version
    FROM oauth_resource
  `);
  const canonicalResource = resourceRows.find(
    (resource) => resource.identifier === canonical,
  );
  const noncanonicalResources = resourceRows.filter(
    (resource) => resource.identifier !== canonical,
  ).length;
  const incompatibleCanonicalResource =
    canonicalResource &&
    (canonicalResource.access_token_ttl !== null ||
      canonicalResource.refresh_token_ttl !== null ||
      canonicalResource.signing_algorithm !== null ||
      canonicalResource.signing_key_id !== null ||
      canonicalResource.allowed_scopes !== null ||
      canonicalResource.custom_claims_is_null !== true ||
      canonicalResource.dpop_bound_access_tokens_required !== false ||
      canonicalResource.disabled !== false ||
      canonicalResource.policy_version !== 1)
      ? 1
      : 0;

  const missingClientRows = await rows<{ client_id: string }>(db, sql`
    SELECT client.client_id
    FROM oauth_client AS client
    LEFT JOIN oauth_client_resource AS link
      ON link.client_id = client.client_id
     AND link.resource_id = ${canonical}
    WHERE link.client_id IS NULL
    ORDER BY client.client_id
  `);
  const [stats] = await rows<{
    clients: number;
    client_links: number;
    noncanonical_links: number;
    orphan_links: number;
    refresh_tokens: number;
    unbound_refresh_tokens: number;
    incompatible_refresh_tokens: number;
    active_refresh_tokens_without_offline_access: number;
    access_tokens: number;
    unbound_access_tokens: number;
    incompatible_access_tokens: number;
    consents: number;
    orphan_consents: number;
    unsafe_consent_scopes: number;
    incompatible_consent_resources: number;
    consents_to_backfill: number;
  }>(db, sql`
    WITH link_stats AS (
      SELECT
        count(*)::int AS total,
        (count(*) FILTER (WHERE link.resource_id <> ${canonical}))::int
          AS noncanonical,
        (count(*) FILTER (
          WHERE client.client_id IS NULL OR resource.identifier IS NULL
        ))::int AS orphaned
      FROM oauth_client_resource AS link
      LEFT JOIN oauth_client AS client ON client.client_id = link.client_id
      LEFT JOIN oauth_resource AS resource
        ON resource.identifier = link.resource_id
    ), refresh_stats AS (
      SELECT
        count(*)::int AS total,
        (count(*) FILTER (WHERE resources IS NULL))::int AS unbound,
        (count(*) FILTER (
          WHERE resources IS NOT NULL
            AND resources IS DISTINCT FROM ARRAY[${canonical}]::text[]
        ))::int AS incompatible,
        (count(*) FILTER (
          WHERE revoked IS NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND NOT COALESCE('offline_access' = ANY(scopes), false)
        ))::int AS active_without_offline_access
      FROM oauth_refresh_token
    ), access_stats AS (
      SELECT
        count(*)::int AS total,
        (count(*) FILTER (WHERE resources IS NULL))::int AS unbound,
        (count(*) FILTER (
          WHERE resources IS NOT NULL
            AND resources IS DISTINCT FROM ARRAY[${canonical}]::text[]
        ))::int AS incompatible
      FROM oauth_access_token
    ), consent_stats AS (
      SELECT
        count(*)::int AS total,
        (count(*) FILTER (WHERE client.client_id IS NULL))::int AS orphaned,
        (count(*) FILTER (WHERE EXISTS (
          SELECT 1
          FROM unnest(consent.scopes) AS scope(value)
          WHERE scope.value IS NULL
             OR scope.value NOT IN (${allowedConsentScopeList})
        )))::int AS unsafe_scopes,
        (count(*) FILTER (
          WHERE consent.resources IS NOT NULL
            AND cardinality(consent.resources) > 0
            AND consent.resources IS DISTINCT FROM ARRAY[${canonical}]::text[]
        ))::int AS incompatible_resources,
        (count(*) FILTER (
          WHERE client.client_id IS NOT NULL
            AND (
              consent.resources IS NULL OR cardinality(consent.resources) = 0
            )
            AND NOT EXISTS (
              SELECT 1
              FROM unnest(consent.scopes) AS scope(value)
              WHERE scope.value IS NULL
                 OR scope.value NOT IN (${allowedConsentScopeList})
            )
        ))::int AS to_backfill
      FROM oauth_consent AS consent
      LEFT JOIN oauth_client AS client ON client.client_id = consent.client_id
    )
    SELECT
      (SELECT count(*)::int FROM oauth_client) AS clients,
      link_stats.total AS client_links,
      link_stats.noncanonical AS noncanonical_links,
      link_stats.orphaned AS orphan_links,
      refresh_stats.total AS refresh_tokens,
      refresh_stats.unbound AS unbound_refresh_tokens,
      refresh_stats.incompatible AS incompatible_refresh_tokens,
      refresh_stats.active_without_offline_access
        AS active_refresh_tokens_without_offline_access,
      access_stats.total AS access_tokens,
      access_stats.unbound AS unbound_access_tokens,
      access_stats.incompatible AS incompatible_access_tokens,
      consent_stats.total AS consents,
      consent_stats.orphaned AS orphan_consents,
      consent_stats.unsafe_scopes AS unsafe_consent_scopes,
      consent_stats.incompatible_resources AS incompatible_consent_resources,
      consent_stats.to_backfill AS consents_to_backfill
    FROM link_stats, refresh_stats, access_stats, consent_stats
  `);
  if (!stats) throw new Error("OAuth resource preflight returned no statistics.");

  const clients = Number(stats.clients);
  const links = Number(stats.client_links);
  const refreshTokens = Number(stats.refresh_tokens);
  const accessTokens = Number(stats.access_tokens);
  const consents = Number(stats.consents);
  const noncanonicalLinks = Number(stats.noncanonical_links);
  const orphanLinks = Number(stats.orphan_links);
  const incompatibleRefreshTokens = Number(stats.incompatible_refresh_tokens);
  const activeRefreshTokensWithoutOfflineAccess = Number(
    stats.active_refresh_tokens_without_offline_access,
  );
  const incompatibleAccessTokens = Number(stats.incompatible_access_tokens);
  const orphanConsents = Number(stats.orphan_consents);
  const unsafeConsentScopes = Number(stats.unsafe_consent_scopes);
  const incompatibleConsentResources = Number(
    stats.incompatible_consent_resources,
  );
  const consentsToBackfill = Number(stats.consents_to_backfill);

  const blockers = [
    blocker("noncanonical oauth_resource rows", noncanonicalResources),
    blocker("incompatible canonical oauth_resource policy", incompatibleCanonicalResource),
    blocker("orphan oauth_client_resource rows", orphanLinks),
    blocker("noncanonical oauth_client_resource rows", noncanonicalLinks),
    blocker("incompatible oauth_refresh_token resources", incompatibleRefreshTokens),
    blocker(
      "active oauth_refresh_token rows without offline_access",
      activeRefreshTokensWithoutOfflineAccess,
    ),
    blocker("incompatible oauth_access_token resources", incompatibleAccessTokens),
    blocker("orphan oauth_consent rows", orphanConsents),
    blocker("oauth_consent rows with unsupported scopes", unsafeConsentScopes),
    blocker(
      "oauth_consent rows with incompatible resources",
      incompatibleConsentResources,
    ),
  ].filter((value): value is string => value !== null);

  return {
    counts: {
      clients,
      resources: resourceRows.length,
      clientLinks: links,
      refreshTokens,
      accessTokens,
      consents,
      preservedUnboundRefreshTokens: Number(stats.unbound_refresh_tokens),
      preservedUnboundAccessTokens: Number(stats.unbound_access_tokens),
    },
    blockers,
    canonicalResourceExists: canonicalResource !== undefined,
    missingClientIds: missingClientRows.map((row) => row.client_id),
    consentsToBackfill,
  };
}

async function setSafeLocalSearchPath(db: Db): Promise<void> {
  await db.execute(sql.raw("SET LOCAL search_path = pg_catalog, public"));
}

async function inspectInReadTransaction(
  db: Db,
  deployment: PrepareMcpOauthResourcesDeployment,
): Promise<DatabaseState> {
  return db.transaction(
    async (tx) => {
      const transactionDb = tx as unknown as Db;
      await setSafeLocalSearchPath(transactionDb);
      return inspectDatabaseState(transactionDb, deployment);
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
}

function assertNoBlockers(state: DatabaseState): void {
  if (state.blockers.length > 0) {
    throw new Error(`OAuth resource preflight failed: ${state.blockers.join("; ")}.`);
  }
}

function plannedMutations(state: DatabaseState): PreparationMutations {
  return {
    resources: state.canonicalResourceExists ? 0 : 1,
    clientLinks: state.missingClientIds.length,
    consents: state.consentsToBackfill,
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

export async function acquireMcpOauthResourceLocks(db: Db): Promise<void> {
  for (const table of [
    "oauth_client",
    "oauth_resource",
    "oauth_client_resource",
    "oauth_refresh_token",
    "oauth_access_token",
    "oauth_consent",
    "env_marker",
  ]) {
    await db.execute(
      sql.raw(
        `LOCK TABLE \"public\".\"${table}\" IN SHARE ROW EXCLUSIVE MODE`,
      ),
    );
  }
}

function unchangedRowCounts(
  before: PreparationCounts,
  after: PreparationCounts,
): boolean {
  return (
    before.clients === after.clients &&
    before.refreshTokens === after.refreshTokens &&
    before.accessTokens === after.accessTokens &&
    before.consents === after.consents
  );
}

export async function prepareMcpOauthResources(
  db: Db,
  deployment: PrepareMcpOauthResourcesDeployment,
  options: PrepareMcpOauthResourcesOptions,
  dependencies: PrepareMcpOauthResourcesDependencies = {},
): Promise<PrepareMcpOauthResourcesResult> {
  if (deployment.targetEnvironment !== options.targetEnvironment) {
    throw new Error("Target environment differs between options and deployment.");
  }
  if (
    options.apply &&
    deployment.targetEnvironment === "production" &&
    !options.confirmProduction
  ) {
    throw new Error(
      "Refusing --apply for production without --confirm-production.",
    );
  }
  if (!options.apply) {
    const state = await inspectInReadTransaction(db, deployment);
    assertNoBlockers(state);
    return {
      mode: "dry-run",
      targetEnvironment: deployment.targetEnvironment,
      endpointHost: deployment.endpointHost,
      canonicalResource: deployment.canonicalResource,
      counts: state.counts,
      planned: plannedMutations(state),
      applied: { resources: 0, clientLinks: 0, consents: 0 },
      singleAudienceHistoryConfirmed:
        options.confirmSingleAudienceHistory,
      consentHistoryConfirmationRequired:
        state.consentsToBackfill > 0 &&
        !options.confirmSingleAudienceHistory,
      handoff: AIW_331_HANDOFF,
    };
  }

  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as Db;
    await setSafeLocalSearchPath(transactionDb);
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
    await assertExpandedSchema(transactionDb);
    await (dependencies.acquireLocks ?? acquireMcpOauthResourceLocks)(
      transactionDb,
    );

    const before = await inspectDatabaseState(transactionDb, deployment);
    assertNoBlockers(before);
    const planned = plannedMutations(before);
    if (planned.consents > 0 && !options.confirmSingleAudienceHistory) {
      throw new Error(
        "Consent backfill requires --confirm-single-audience-history because current configuration cannot prove historical audiences.",
      );
    }

    if (!before.canonicalResourceExists) {
      await tx
        .insert(oauthResource)
        .values({
          id: stableId("mcp-resource", deployment.canonicalResource),
          identifier: deployment.canonicalResource,
          name: deployment.canonicalResource,
          allowedScopes: null,
          dpopBoundAccessTokensRequired: false,
          disabled: false,
          policyVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: oauthResource.identifier });
    }

    if (before.missingClientIds.length > 0) {
      await tx
        .insert(oauthClientResource)
        .values(
          before.missingClientIds.map((clientId) => ({
            id: stableId(
              "mcp-client-resource",
              deployment.canonicalResource,
              clientId,
            ),
            clientId,
            resourceId: deployment.canonicalResource,
            createdAt: new Date(),
          })),
        )
        .onConflictDoNothing({
          target: [oauthClientResource.clientId, oauthClientResource.resourceId],
        });
    }

    const updatedConsents = await tx
      .update(oauthConsent)
      .set({ resources: [deployment.canonicalResource] })
      .where(
        and(
          or(
            isNull(oauthConsent.resources),
            sql`cardinality(${oauthConsent.resources}) = 0`,
          ),
          sql`not exists (
            select 1
            from unnest(${oauthConsent.scopes}) as scope(value)
            where scope.value is null
               or scope.value not in (${sql.join(
                 [...MCP_SCOPES, OFFLINE_ACCESS_SCOPE].map(
                   (scope) => sql`${scope}`,
                 ),
                 sql`, `,
               )})
          )`,
          sql`exists (
            select 1
            from ${oauthClientResource} as link
            where link.client_id = ${oauthConsent.clientId}
              and link.resource_id = ${deployment.canonicalResource}
          )`,
        ),
      )
      .returning({ id: oauthConsent.id });
    const consents = updatedConsents.length;

    await dependencies.afterWrites?.(transactionDb);

    const after = await inspectDatabaseState(transactionDb, deployment);
    assertNoBlockers(after);
    const resources = after.counts.resources - before.counts.resources;
    const clientLinks = after.counts.clientLinks - before.counts.clientLinks;
    if (!unchangedRowCounts(before.counts, after.counts)) {
      throw new Error("OAuth resource postcondition failed: protected row counts changed.");
    }
    if (
      after.counts.resources !== 1 ||
      after.counts.clientLinks !== after.counts.clients ||
      after.missingClientIds.length !== 0 ||
      after.consentsToBackfill !== 0
    ) {
      throw new Error(
        "OAuth resource postcondition failed: canonical resource, links, or consents are incomplete.",
      );
    }
    if (
      resources !== planned.resources ||
      clientLinks !== planned.clientLinks ||
      consents !== planned.consents
    ) {
      throw new Error(
        "OAuth resource postcondition failed: applied mutation counts differ from the locked plan.",
      );
    }

    return {
      mode: "apply",
      targetEnvironment: deployment.targetEnvironment,
      endpointHost: deployment.endpointHost,
      canonicalResource: deployment.canonicalResource,
      counts: after.counts,
      planned,
      applied: { resources, clientLinks, consents },
      singleAudienceHistoryConfirmed:
        options.confirmSingleAudienceHistory,
      consentHistoryConfirmationRequired: false,
      handoff: AIW_331_HANDOFF,
    };
  });
}

export function formatPrepareMcpOauthResourcesResult(
  result: PrepareMcpOauthResourcesResult,
): string {
  return `${[
    `mode: ${result.mode}`,
    `target environment: ${result.targetEnvironment}`,
    `endpoint host: ${result.endpointHost}`,
    `canonical resource: ${result.canonicalResource}`,
    `rows: clients=${result.counts.clients} resources=${result.counts.resources} links=${result.counts.clientLinks} refresh_tokens=${result.counts.refreshTokens} access_tokens=${result.counts.accessTokens} consents=${result.counts.consents}`,
    `preserved unbound grants: refresh_tokens=${result.counts.preservedUnboundRefreshTokens} access_tokens=${result.counts.preservedUnboundAccessTokens}`,
    `planned mutations: resources=${result.planned.resources} links=${result.planned.clientLinks} consents=${result.planned.consents}`,
    `applied mutations: resources=${result.applied.resources} links=${result.applied.clientLinks} consents=${result.applied.consents}`,
    `single-audience history confirmed: ${result.singleAudienceHistoryConfirmed ? "yes" : "no"}`,
    `consent history confirmation required: ${result.consentHistoryConfirmationRequired ? "yes (--confirm-single-audience-history)" : "no"}`,
    result.handoff,
  ].join("\n")}\n`;
}

async function openNeonDatabase(databaseUrl: string): Promise<{
  db: Db;
  close: () => Promise<void>;
}> {
  const [{ Pool }, { drizzle }, schema] = await Promise.all([
    import("@neondatabase/serverless"),
    import("drizzle-orm/neon-serverless"),
    import("../src/db/schema.js"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}

export async function runPrepareMcpOauthResourcesCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: PrepareMcpOauthResourcesCliDependencies = {},
): Promise<void> {
  const options = parsePrepareMcpOauthResourcesArguments(argv);
  const deployment = resolvePrepareMcpOauthResourcesDeployment(
    options,
    dependencies.environment ?? process.env,
  );
  const connection = await (dependencies.openDatabase ?? openNeonDatabase)(
    deployment.databaseUrl,
  );
  try {
    const result = await prepareMcpOauthResources(
      connection.db,
      deployment,
      options,
    );
    (dependencies.write ?? ((text: string) => process.stdout.write(text)))(
      formatPrepareMcpOauthResourcesResult(result),
    );
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runPrepareMcpOauthResourcesCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
