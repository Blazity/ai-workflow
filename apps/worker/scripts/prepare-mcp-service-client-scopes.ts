import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";

import type { Db } from "../src/db/client.js";
import { MCP_SCOPES } from "../src/mcp/contracts.js";

const EXPECTED_SOURCE_RUNTIME_VERSION = "1.6.30";
const DEFAULT_ORGANIZATION_SLUG = "ai-workflow";
const LOCK_TIMEOUT = "5s";
const AIW_331_HANDOFF =
  "AIW-331 handoff: rerun this command immediately before the package switch. " +
  "Proceed only with zero blockers and zero pending service clients; after the " +
  "switch this apply command intentionally refuses to run.";

export interface PrepareMcpServiceClientScopesOptions {
  apply: boolean;
  confirmLegacyRuntime16: boolean;
  confirmProduction: boolean;
  organizationSlug: string;
  targetEnvironment: string;
}

export interface PrepareMcpServiceClientScopesDeployment {
  databaseUrl: string;
  endpointHost: string;
  organizationSlug: string;
  sourceRuntimeVersion: string;
  targetEnvironment: string;
}

export interface ServiceClientScopeBlockers {
  applicationTypeSet: number;
  clientDiscoveryIdSet: number;
  disabledOrUnset: number;
  emptyScope: number;
  invalidAuthMethod: number;
  invalidGrantTypes: number;
  invalidLegacyType: number;
  mismatchedPrefill: number;
  missingScopes: number;
  missingSecret: number;
  nonClientCredentialsPrefill: number;
  nullPrefill: number;
  nullScope: number;
  offlineAccessScope: number;
  publicOrUnset: number;
  unknownScope: number;
  userOwned: number;
  whitespaceScope: number;
  wrongOrganization: number;
}

export interface ServiceClientScopeCounts {
  oauthClients: number;
  serviceCandidates: number;
  eligibleServiceCandidates: number;
  pendingServiceCandidates: number;
  compliantServiceCandidates: number;
  ignoredNonServiceClients: number;
  blockedRows: number;
}

export interface PrepareMcpServiceClientScopesResult {
  mode: "dry-run" | "apply";
  targetEnvironment: string;
  endpointHost: string;
  organizationSlug: string;
  sourceRuntimeVersion: string;
  counts: ServiceClientScopeCounts;
  blockers: ServiceClientScopeBlockers;
  planned: { serviceClients: number };
  applied: { serviceClients: number };
  handoff: string;
}

export interface PrepareMcpServiceClientScopesDependencies {
  afterWrites?: (db: Db) => Promise<void>;
  acquireLocks?: (db: Db) => Promise<void>;
}

export interface PrepareMcpServiceClientScopesCliDependencies {
  environment?: NodeJS.ProcessEnv;
  openDatabase?: (databaseUrl: string) => Promise<{
    db: Db;
    close: () => Promise<void>;
  }>;
  sourceRuntimeVersion?: string;
  write?: (text: string) => void;
}

interface DatabaseState {
  counts: ServiceClientScopeCounts;
  blockers: ServiceClientScopeBlockers;
  protectedFingerprint: string;
}

function readSourceRuntimeVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, unknown> };
  const version = packageJson.dependencies?.["@better-auth/oauth-provider"];
  return typeof version === "string" ? version : "missing";
}

function isProductionEnvironment(value: string | undefined): boolean {
  return value?.toLowerCase() === "production";
}

export function parsePrepareMcpServiceClientScopesArguments(
  argv: readonly string[],
): PrepareMcpServiceClientScopesOptions {
  let apply = false;
  let confirmLegacyRuntime16 = false;
  let confirmProduction = false;
  let organizationSlug: string | undefined;
  let targetEnvironment: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      if (apply) throw new Error("Duplicate flag: --apply");
      apply = true;
      continue;
    }
    if (arg === "--confirm-legacy-runtime-1-6") {
      if (confirmLegacyRuntime16) {
        throw new Error("Duplicate flag: --confirm-legacy-runtime-1-6");
      }
      confirmLegacyRuntime16 = true;
      continue;
    }
    if (arg === "--confirm-production") {
      if (confirmProduction) {
        throw new Error("Duplicate flag: --confirm-production");
      }
      confirmProduction = true;
      continue;
    }
    if (arg === "--target-environment" || arg === "--organization-slug") {
      const current =
        arg === "--target-environment" ? targetEnvironment : organizationSlug;
      if (current !== undefined) throw new Error(`Duplicate flag: ${arg}`);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new Error(`Invalid value for ${arg}`);
      }
      if (arg === "--target-environment") targetEnvironment = value;
      else organizationSlug = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }

  if (!targetEnvironment) {
    throw new Error("Missing required flag: --target-environment");
  }
  if (!organizationSlug) {
    throw new Error("Missing required flag: --organization-slug");
  }
  if (apply && !confirmLegacyRuntime16) {
    throw new Error(
      "Refusing --apply without --confirm-legacy-runtime-1-6.",
    );
  }
  if (
    apply &&
    isProductionEnvironment(targetEnvironment) &&
    !confirmProduction
  ) {
    throw new Error(
      "Refusing --apply for production without --confirm-production.",
    );
  }

  return {
    apply,
    confirmLegacyRuntime16,
    confirmProduction,
    organizationSlug,
    targetEnvironment,
  };
}

export function normalizeServiceClientDatabaseHostname(
  databaseUrl: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }
  if (!parsed.hostname) throw new Error("DATABASE_URL must contain a hostname.");
  return parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
}

export function resolvePrepareMcpServiceClientScopesDeployment(
  options: PrepareMcpServiceClientScopesOptions,
  environment: NodeJS.ProcessEnv,
  sourceRuntimeVersion = readSourceRuntimeVersion(),
): PrepareMcpServiceClientScopesDeployment {
  const productionRuntime =
    isProductionEnvironment(environment.NODE_ENV) ||
    isProductionEnvironment(environment.VERCEL_ENV);
  if (
    options.apply &&
    (isProductionEnvironment(options.targetEnvironment) || productionRuntime) &&
    !options.confirmProduction
  ) {
    throw new Error(
      "Refusing --apply in production without --confirm-production.",
    );
  }
  const runtimeOrganizationSlug =
    environment.DASHBOARD_ORG_SLUG ?? DEFAULT_ORGANIZATION_SLUG;
  if (options.organizationSlug !== runtimeOrganizationSlug) {
    throw new Error(
      `Organization slug mismatch: requested '${options.organizationSlug}', runtime expects '${runtimeOrganizationSlug}'.`,
    );
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  if (options.apply && sourceRuntimeVersion !== EXPECTED_SOURCE_RUNTIME_VERSION) {
    throw new Error(
      `Refusing --apply: @better-auth/oauth-provider must be exactly ${EXPECTED_SOURCE_RUNTIME_VERSION}; found ${sourceRuntimeVersion}.`,
    );
  }

  return {
    databaseUrl,
    endpointHost: normalizeServiceClientDatabaseHostname(databaseUrl),
    organizationSlug: options.organizationSlug,
    sourceRuntimeVersion,
    targetEnvironment: options.targetEnvironment,
  };
}

async function rows<T extends Record<string, unknown>>(
  db: Db,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rows)) return result.rows;
  throw new Error("Database driver returned an unsupported query result.");
}

async function assertExpandedSchema(db: Db): Promise<void> {
  const found = await rows<{ column_name: string }>(db, sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'oauth_client'
      AND column_name IN (
        'client_credentials_scopes',
        'client_discovery_id',
        'application_type'
      )
  `);
  const foundColumns = new Set(found.map((row) => row.column_name));
  const missing = [
    "client_credentials_scopes",
    "client_discovery_id",
    "application_type",
  ].filter((column) => !foundColumns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Better Auth expand migration 0058 is incomplete; missing ${missing
        .map((column) => `column public.oauth_client.${column}`)
        .join(", ")}.`,
    );
  }
}

async function assertEnvironmentMarker(
  db: Db,
  deployment: PrepareMcpServiceClientScopesDeployment,
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
  if (markers.length !== 1 || Number(markers[0]?.id) !== 1) {
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

async function resolveOrganizationId(
  db: Db,
  organizationSlug: string,
): Promise<string> {
  const organizations = await rows<{ id: string }>(db, sql`
    SELECT id
    FROM organization
    WHERE slug = ${organizationSlug}
  `);
  if (organizations.length !== 1) {
    throw new Error(
      `Organization slug resolution failed: expected exactly one '${organizationSlug}' row, found ${organizations.length}.`,
    );
  }
  return organizations[0].id;
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

async function inspectDatabaseState(
  db: Db,
  deployment: PrepareMcpServiceClientScopesDeployment,
): Promise<DatabaseState> {
  await assertExpandedSchema(db);
  await assertEnvironmentMarker(db, deployment);
  const organizationId = await resolveOrganizationId(
    db,
    deployment.organizationSlug,
  );
  const allowedScopes = sql.join(
    MCP_SCOPES.map((scope) => sql`${scope}`),
    sql`, `,
  );
  const isCandidate = sql`COALESCE('client_credentials' = ANY(client.grant_types), false)`;
  const exactGrantTypes = sql`client.grant_types = ARRAY['client_credentials']::text[]`;
  const validScopes = sql`
    client.scopes IS NOT NULL
    AND cardinality(client.scopes) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(client.scopes) AS requested_scope(value)
      WHERE requested_scope.value IS NULL
         OR requested_scope.value = ''
         OR requested_scope.value <> btrim(requested_scope.value)
         OR requested_scope.value = 'offline_access'
         OR requested_scope.value NOT IN (${allowedScopes})
    )
  `;
  // redirect_uris is deliberately not an eligibility signal: Better Auth 1.6
  // required one even for managed, client_credentials-only clients.
  const eligible = sql`
    ${isCandidate}
    AND ${exactGrantTypes}
    AND client.disabled IS FALSE
    AND client.public IS FALSE
    AND client.user_id IS NULL
    AND client.client_secret IS NOT NULL
    AND btrim(client.client_secret) <> ''
    AND client.token_endpoint_auth_method IN (
      'client_secret_basic', 'client_secret_post'
    )
    AND client.reference_id = ${organizationId}
    AND (client.type IS NULL OR client.type = 'web')
    AND client.client_discovery_id IS NULL
    AND client.application_type IS NULL
    AND ${validScopes}
  `;

  const [stats] = await rows<Record<string, unknown>>(db, sql`
    SELECT
      count(*)::int AS oauth_clients,
      (count(*) FILTER (WHERE ${isCandidate}))::int AS service_candidates,
      (count(*) FILTER (WHERE ${eligible}))::int AS eligible_service_candidates,
      (count(*) FILTER (
        WHERE ${eligible}
          AND client.client_credentials_scopes IS NOT NULL
          AND cardinality(client.client_credentials_scopes) = 0
      ))::int AS pending_service_candidates,
      (count(*) FILTER (
        WHERE ${eligible}
          AND client.client_credentials_scopes = client.scopes
      ))::int AS compliant_service_candidates,
      (count(*) FILTER (
        WHERE NOT ${isCandidate}
          AND (
            client.client_credentials_scopes IS NULL
            OR cardinality(client.client_credentials_scopes) = 0
          )
      ))::int AS ignored_non_service_clients,
      (count(*) FILTER (
        WHERE (
          ${isCandidate}
          AND (
            (${eligible}) IS NOT TRUE
            OR client.client_credentials_scopes IS NULL
            OR (
              cardinality(client.client_credentials_scopes) > 0
              AND client.client_credentials_scopes IS DISTINCT FROM client.scopes
            )
          )
        ) OR (
          NOT ${isCandidate}
          AND cardinality(client.client_credentials_scopes) > 0
        )
      ))::int AS blocked_rows,
      (count(*) FILTER (
        WHERE ${isCandidate} AND NOT (${exactGrantTypes})
      ))::int AS invalid_grant_types,
      (count(*) FILTER (
        WHERE ${isCandidate} AND client.disabled IS NOT FALSE
      ))::int AS disabled_or_unset,
      (count(*) FILTER (
        WHERE ${isCandidate} AND client.public IS NOT FALSE
      ))::int AS public_or_unset,
      (count(*) FILTER (
        WHERE ${isCandidate} AND client.user_id IS NOT NULL
      ))::int AS user_owned,
      (count(*) FILTER (
        WHERE ${isCandidate}
          AND (
            client.client_secret IS NULL
            OR btrim(client.client_secret) = ''
          )
      ))::int AS missing_secret,
      (count(*) FILTER (
        WHERE ${isCandidate}
          AND (
            client.token_endpoint_auth_method NOT IN (
              'client_secret_basic', 'client_secret_post'
            )
            OR client.token_endpoint_auth_method IS NULL
          )
      ))::int AS invalid_auth_method,
      (count(*) FILTER (
        WHERE ${isCandidate}
          AND client.reference_id IS DISTINCT FROM ${organizationId}
      ))::int AS wrong_organization,
      (count(*) FILTER (
        WHERE ${isCandidate}
          AND client.type IS NOT NULL
          AND client.type <> 'web'
      ))::int AS invalid_legacy_type,
      (count(*) FILTER (
        WHERE ${isCandidate} AND client.client_discovery_id IS NOT NULL
      ))::int AS client_discovery_id_set,
      (count(*) FILTER (
        WHERE ${isCandidate} AND client.application_type IS NOT NULL
      ))::int AS application_type_set,
      (count(*) FILTER (
        WHERE ${isCandidate}
          AND (client.scopes IS NULL OR cardinality(client.scopes) = 0)
      ))::int AS missing_scopes,
      (count(*) FILTER (
        WHERE ${isCandidate} AND EXISTS (
          SELECT 1 FROM unnest(client.scopes) AS scope(value)
          WHERE scope.value IS NULL
        )
      ))::int AS null_scope,
      (count(*) FILTER (
        WHERE ${isCandidate} AND EXISTS (
          SELECT 1 FROM unnest(client.scopes) AS scope(value)
          WHERE scope.value = ''
        )
      ))::int AS empty_scope,
      (count(*) FILTER (
        WHERE ${isCandidate} AND EXISTS (
          SELECT 1 FROM unnest(client.scopes) AS scope(value)
          WHERE scope.value IS NOT NULL AND scope.value <> btrim(scope.value)
        )
      ))::int AS whitespace_scope,
      (count(*) FILTER (
        WHERE ${isCandidate} AND EXISTS (
          SELECT 1 FROM unnest(client.scopes) AS scope(value)
          WHERE scope.value = 'offline_access'
        )
      ))::int AS offline_access_scope,
      (count(*) FILTER (
        WHERE ${isCandidate} AND EXISTS (
          SELECT 1 FROM unnest(client.scopes) AS scope(value)
          WHERE scope.value IS NOT NULL
            AND scope.value <> ''
            AND scope.value = btrim(scope.value)
            AND scope.value <> 'offline_access'
            AND scope.value NOT IN (${allowedScopes})
        )
      ))::int AS unknown_scope,
      (count(*) FILTER (
        WHERE ${eligible} AND client.client_credentials_scopes IS NULL
      ))::int AS null_prefill,
      (count(*) FILTER (
        WHERE ${eligible}
          AND cardinality(client.client_credentials_scopes) > 0
          AND client.client_credentials_scopes IS DISTINCT FROM client.scopes
      ))::int AS mismatched_prefill,
      (count(*) FILTER (
        WHERE NOT ${isCandidate}
          AND cardinality(client.client_credentials_scopes) > 0
      ))::int AS non_client_credentials_prefill,
      md5(COALESCE(string_agg(
        (to_jsonb(client) - 'client_credentials_scopes')::text,
        E'\n' ORDER BY client.id
      ), '')) AS protected_fingerprint
    FROM oauth_client AS client
  `);
  if (!stats) {
    throw new Error("Service client scope preflight returned no statistics.");
  }

  return {
    counts: {
      oauthClients: numberValue(stats.oauth_clients),
      serviceCandidates: numberValue(stats.service_candidates),
      eligibleServiceCandidates: numberValue(stats.eligible_service_candidates),
      pendingServiceCandidates: numberValue(stats.pending_service_candidates),
      compliantServiceCandidates: numberValue(stats.compliant_service_candidates),
      ignoredNonServiceClients: numberValue(stats.ignored_non_service_clients),
      blockedRows: numberValue(stats.blocked_rows),
    },
    blockers: {
      applicationTypeSet: numberValue(stats.application_type_set),
      clientDiscoveryIdSet: numberValue(stats.client_discovery_id_set),
      disabledOrUnset: numberValue(stats.disabled_or_unset),
      emptyScope: numberValue(stats.empty_scope),
      invalidAuthMethod: numberValue(stats.invalid_auth_method),
      invalidGrantTypes: numberValue(stats.invalid_grant_types),
      invalidLegacyType: numberValue(stats.invalid_legacy_type),
      mismatchedPrefill: numberValue(stats.mismatched_prefill),
      missingScopes: numberValue(stats.missing_scopes),
      missingSecret: numberValue(stats.missing_secret),
      nonClientCredentialsPrefill: numberValue(
        stats.non_client_credentials_prefill,
      ),
      nullPrefill: numberValue(stats.null_prefill),
      nullScope: numberValue(stats.null_scope),
      offlineAccessScope: numberValue(stats.offline_access_scope),
      publicOrUnset: numberValue(stats.public_or_unset),
      unknownScope: numberValue(stats.unknown_scope),
      userOwned: numberValue(stats.user_owned),
      whitespaceScope: numberValue(stats.whitespace_scope),
      wrongOrganization: numberValue(stats.wrong_organization),
    },
    protectedFingerprint: String(stats.protected_fingerprint),
  };
}

function activeBlockers(blockers: ServiceClientScopeBlockers): string[] {
  return Object.entries(blockers)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${category}=${count}`);
}

function assertNoBlockers(state: DatabaseState): void {
  const blockers = activeBlockers(state.blockers);
  if (state.counts.blockedRows > 0 || blockers.length > 0) {
    throw new Error(
      `Service client scope preflight failed (blockedRows=${state.counts.blockedRows}): ${blockers.join(", ")}.`,
    );
  }
}

async function setSafeLocalSearchPath(db: Db): Promise<void> {
  await db.execute(sql.raw("SET LOCAL search_path = pg_catalog, public"));
}

async function inspectInReadTransaction(
  db: Db,
  deployment: PrepareMcpServiceClientScopesDeployment,
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

export async function acquireMcpServiceClientScopeLocks(db: Db): Promise<void> {
  for (const table of ["oauth_client", "organization", "env_marker"]) {
    await db.execute(
      sql.raw(
        `LOCK TABLE "public"."${table}" IN SHARE ROW EXCLUSIVE MODE`,
      ),
    );
  }
}

function assertSourceRuntimeForApply(
  deployment: PrepareMcpServiceClientScopesDeployment,
): void {
  const packageRuntimeVersion = readSourceRuntimeVersion();
  if (
    deployment.sourceRuntimeVersion !== EXPECTED_SOURCE_RUNTIME_VERSION ||
    packageRuntimeVersion !== EXPECTED_SOURCE_RUNTIME_VERSION
  ) {
    throw new Error(
      `Refusing --apply: @better-auth/oauth-provider must be exactly ${EXPECTED_SOURCE_RUNTIME_VERSION}; deployment found ${deployment.sourceRuntimeVersion}, package found ${packageRuntimeVersion}.`,
    );
  }
}

async function updatePendingServiceClients(
  db: Db,
  organizationId: string,
): Promise<number> {
  const allowedScopes = sql.join(
    MCP_SCOPES.map((scope) => sql`${scope}`),
    sql`, `,
  );
  const [result] = await rows<{ updated: number }>(db, sql`
    WITH updated AS (
      UPDATE oauth_client AS client
      -- Preserve the verified source array exactly, including order and
      -- duplicates. Do not normalize authoring scopes here.
      SET client_credentials_scopes = client.scopes
      WHERE client.grant_types = ARRAY['client_credentials']::text[]
        AND client.disabled IS FALSE
        AND client.public IS FALSE
        AND client.user_id IS NULL
        AND client.client_secret IS NOT NULL
        AND btrim(client.client_secret) <> ''
        AND client.token_endpoint_auth_method IN (
          'client_secret_basic', 'client_secret_post'
        )
        AND client.reference_id = ${organizationId}
        AND (client.type IS NULL OR client.type = 'web')
        AND client.client_discovery_id IS NULL
        AND client.application_type IS NULL
        AND client.scopes IS NOT NULL
        AND cardinality(client.scopes) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(client.scopes) AS requested_scope(value)
          WHERE requested_scope.value IS NULL
             OR requested_scope.value = ''
             OR requested_scope.value <> btrim(requested_scope.value)
             OR requested_scope.value = 'offline_access'
             OR requested_scope.value NOT IN (${allowedScopes})
        )
        AND client.client_credentials_scopes IS NOT NULL
        AND cardinality(client.client_credentials_scopes) = 0
      RETURNING 1
    )
    SELECT count(*)::int AS updated FROM updated
  `);
  return Number(result?.updated ?? 0);
}

export async function prepareMcpServiceClientScopes(
  db: Db,
  deployment: PrepareMcpServiceClientScopesDeployment,
  options: PrepareMcpServiceClientScopesOptions,
  dependencies: PrepareMcpServiceClientScopesDependencies = {},
): Promise<PrepareMcpServiceClientScopesResult> {
  if (deployment.targetEnvironment !== options.targetEnvironment) {
    throw new Error("Target environment differs between options and deployment.");
  }
  if (deployment.organizationSlug !== options.organizationSlug) {
    throw new Error("Organization slug differs between options and deployment.");
  }
  if (options.apply && !options.confirmLegacyRuntime16) {
    throw new Error(
      "Refusing --apply without --confirm-legacy-runtime-1-6.",
    );
  }
  if (
    options.apply &&
    isProductionEnvironment(deployment.targetEnvironment) &&
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
      organizationSlug: deployment.organizationSlug,
      sourceRuntimeVersion: deployment.sourceRuntimeVersion,
      counts: state.counts,
      blockers: state.blockers,
      planned: { serviceClients: state.counts.pendingServiceCandidates },
      applied: { serviceClients: 0 },
      handoff: AIW_331_HANDOFF,
    };
  }

  assertSourceRuntimeForApply(deployment);
  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as Db;
    await setSafeLocalSearchPath(transactionDb);
    await transactionDb.execute(
      sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`),
    );
    await assertExpandedSchema(transactionDb);
    await (dependencies.acquireLocks ?? acquireMcpServiceClientScopeLocks)(
      transactionDb,
    );

    const before = await inspectDatabaseState(transactionDb, deployment);
    assertNoBlockers(before);
    const organizationId = await resolveOrganizationId(
      transactionDb,
      deployment.organizationSlug,
    );
    const planned = before.counts.pendingServiceCandidates;
    const updated = await updatePendingServiceClients(
      transactionDb,
      organizationId,
    );

    await dependencies.afterWrites?.(transactionDb);

    const after = await inspectDatabaseState(transactionDb, deployment);
    assertNoBlockers(after);
    if (
      after.counts.oauthClients !== before.counts.oauthClients ||
      after.protectedFingerprint !== before.protectedFingerprint
    ) {
      throw new Error(
        "Service client scope postcondition failed: protected oauth_client data changed.",
      );
    }
    if (
      after.counts.serviceCandidates !== before.counts.serviceCandidates ||
      after.counts.eligibleServiceCandidates !==
        before.counts.eligibleServiceCandidates ||
      after.counts.pendingServiceCandidates !== 0 ||
      after.counts.compliantServiceCandidates !==
        after.counts.eligibleServiceCandidates
    ) {
      throw new Error(
        "Service client scope postcondition failed: service-client reconciliation is incomplete.",
      );
    }
    if (updated !== planned) {
      throw new Error(
        "Service client scope postcondition failed: applied count differs from the locked plan.",
      );
    }

    return {
      mode: "apply",
      targetEnvironment: deployment.targetEnvironment,
      endpointHost: deployment.endpointHost,
      organizationSlug: deployment.organizationSlug,
      sourceRuntimeVersion: deployment.sourceRuntimeVersion,
      counts: after.counts,
      blockers: after.blockers,
      planned: { serviceClients: planned },
      applied: { serviceClients: updated },
      handoff: AIW_331_HANDOFF,
    };
  });
}

export function formatPrepareMcpServiceClientScopesResult(
  result: PrepareMcpServiceClientScopesResult,
): string {
  const blockerCounts = Object.entries(result.blockers)
    .map(([category, count]) => `${category}=${count}`)
    .join(" ");
  return `${[
    `mode: ${result.mode}`,
    `target environment: ${result.targetEnvironment}`,
    `endpoint host: ${result.endpointHost}`,
    `organization slug: ${result.organizationSlug}`,
    `source runtime: @better-auth/oauth-provider@${result.sourceRuntimeVersion}`,
    `rows: oauth_clients=${result.counts.oauthClients} service_candidates=${result.counts.serviceCandidates} eligible=${result.counts.eligibleServiceCandidates} pending=${result.counts.pendingServiceCandidates} compliant=${result.counts.compliantServiceCandidates} ignored_non_service=${result.counts.ignoredNonServiceClients} blocked=${result.counts.blockedRows}`,
    `blocker categories: ${blockerCounts}`,
    `planned mutations: service_clients=${result.planned.serviceClients}`,
    `applied mutations: service_clients=${result.applied.serviceClients}`,
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

export async function runPrepareMcpServiceClientScopesCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: PrepareMcpServiceClientScopesCliDependencies = {},
): Promise<void> {
  const options = parsePrepareMcpServiceClientScopesArguments(argv);
  const deployment = resolvePrepareMcpServiceClientScopesDeployment(
    options,
    dependencies.environment ?? process.env,
    dependencies.sourceRuntimeVersion,
  );
  const connection = await (dependencies.openDatabase ?? openNeonDatabase)(
    deployment.databaseUrl,
  );
  try {
    const result = await prepareMcpServiceClientScopes(
      connection.db,
      deployment,
      options,
    );
    (dependencies.write ?? ((text: string) => process.stdout.write(text)))(
      formatPrepareMcpServiceClientScopesResult(result),
    );
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runPrepareMcpServiceClientScopesCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
