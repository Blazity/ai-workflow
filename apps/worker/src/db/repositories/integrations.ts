import { sql } from "drizzle-orm";
import type { IntegrationFailureReason, IntegrationSource } from "@shared/contracts";

import { integrationConnectionVersions, integrationConnections } from "../schema/integrations.js";
import { type Db, getDb } from "../client.js";

/**
 * Reads and writes of the integration connection state.
 *
 * Every write here is ONE statement. Production runs neon-http, which cannot
 * open an interactive transaction, while the pglite driver used by tests can:
 * a `db.transaction` would pass every test in this repository and 500 in
 * production. Where a write touches two tables it is a data-modifying CTE, the
 * shape `upsertRepositoryProfile` already uses.
 */

/** One stored version, as the database holds it: secrets still encrypted. */
export interface StoredIntegrationVersion {
  readonly version: number;
  /** Non-secret field values, by field key. */
  readonly config: Readonly<Record<string, string>>;
  /** Secret field ciphertexts, by field key. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly testStatus: "passed" | "failed";
  readonly testReason: IntegrationFailureReason | null;
  readonly testMessage: string | null;
  readonly testedAt: string | null;
  readonly createdAt: string;
}

/** The last time this deployment asked the provider, and about which values. */
export interface StoredIntegrationTest {
  readonly status: "passed" | "failed";
  readonly reason: IntegrationFailureReason | null;
  readonly message: string | null;
  readonly at: string;
  /** The verification fingerprint the values carried when the test ran. */
  readonly fingerprint: string;
}

/** The stored half: the row, plus the two versions a status can depend on. */
export interface StoredIntegrationConnection {
  readonly enabled: boolean;
  readonly source: IntegrationSource;
  readonly latestVersion: number;
  readonly activeVersion: number | null;
  readonly active: StoredIntegrationVersion | null;
  /** The newest version when it never became active, so the card can say why. */
  readonly latest: StoredIntegrationVersion | null;
  readonly lastTest: StoredIntegrationTest | null;
}

interface ConnectionRow {
  integration_id: string;
  enabled: boolean;
  source: IntegrationSource;
  latest_version: number;
  active_version: number | null;
  last_test_status: "passed" | "failed" | null;
  last_test_reason: IntegrationFailureReason | null;
  last_test_message: string | null;
  last_test_at: string | Date | null;
  last_test_fingerprint: string | null;
}

interface VersionRow {
  integration_id: string;
  version: number;
  config: Record<string, string> | null;
  secrets: Record<string, string> | null;
  test_status: "passed" | "failed";
  test_reason: IntegrationFailureReason | null;
  test_message: string | null;
  tested_at: string | Date | null;
  created_at: string | Date;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toVersion(row: VersionRow): StoredIntegrationVersion {
  return {
    version: Number(row.version),
    config: row.config ?? {},
    secrets: row.secrets ?? {},
    testStatus: row.test_status,
    testReason: row.test_reason,
    testMessage: row.test_message,
    testedAt: iso(row.tested_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Every stored connection, by integration id.
 *
 * Two reads rather than a join, because the second is often empty: a deployment
 * that only ever disabled something has rows in the first table and none in the
 * second. Only the two versions a status can depend on are fetched, so the
 * history stays out of a list read.
 */
export async function readIntegrationConnections(
  db: Db,
): Promise<Map<string, StoredIntegrationConnection>> {
  const connections = rowsOf<ConnectionRow>(
    await db.execute(sql`
      SELECT integration_id, enabled, source, latest_version, active_version,
             last_test_status, last_test_reason, last_test_message,
             last_test_at, last_test_fingerprint
      FROM ${integrationConnections}
    `),
  );
  if (connections.length === 0) return new Map();

  const versions = rowsOf<VersionRow>(
    await db.execute(sql`
      SELECT v.integration_id, v.version, v.config, v.secrets, v.test_status,
             v.test_reason, v.test_message, v.tested_at, v.created_at
      FROM ${integrationConnectionVersions} AS v
      JOIN ${integrationConnections} AS c ON c.integration_id = v.integration_id
      WHERE v.version IN (c.active_version, c.latest_version)
    `),
  );
  const byIntegration = new Map<string, VersionRow[]>();
  for (const row of versions) {
    const list = byIntegration.get(row.integration_id) ?? [];
    list.push(row);
    byIntegration.set(row.integration_id, list);
  }

  const result = new Map<string, StoredIntegrationConnection>();
  for (const row of connections) {
    const mine = byIntegration.get(row.integration_id) ?? [];
    const activeVersion = row.active_version === null ? null : Number(row.active_version);
    const latestVersion = Number(row.latest_version);
    const active = mine.find((v) => Number(v.version) === activeVersion) ?? null;
    const latestRow = mine.find((v) => Number(v.version) === latestVersion) ?? null;
    result.set(row.integration_id, {
      enabled: row.enabled,
      source: row.source,
      latestVersion,
      activeVersion,
      active: active ? toVersion(active) : null,
      // Only when it is NOT the active one: a card shows it to explain a save
      // that did not take, and the active version is never that.
      latest: latestRow && latestVersion !== activeVersion ? toVersion(latestRow) : null,
      lastTest:
        row.last_test_status && row.last_test_at
          ? {
              status: row.last_test_status,
              reason: row.last_test_reason,
              message: row.last_test_message,
              at: iso(row.last_test_at) ?? new Date(0).toISOString(),
              fingerprint: row.last_test_fingerprint ?? "",
            }
          : null,
    });
  }
  return result;
}

export interface SaveIntegrationVersionInput {
  readonly integrationId: string;
  /** The `latestVersion` the caller last read. A mismatch writes nothing. */
  readonly expectedVersion: number;
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly test: {
    readonly status: "passed" | "failed";
    readonly reason: IntegrationFailureReason | null;
    readonly message: string | null;
    /** Covers secrets too; see `integrationVerificationFingerprint`. */
    readonly fingerprint: string;
  };
  readonly actorId: string | null;
}

export type SaveIntegrationVersionResult =
  | { readonly conflict: true; readonly currentVersion: number }
  | { readonly conflict: false; readonly version: number; readonly activated: boolean };

/**
 * The one statement a save is.
 *
 * Exported apart from its execution so a test can read the SQL this builds. The
 * predicate that makes the concurrency token safe is only observable with two
 * connections committing against each other, which no driver in this repository
 * can arrange: pglite has one connection and serialises. Reading the statement
 * is the guard that remains, and it is worth having, because dropping the
 * predicate is a silent lost update rather than an error.
 */
/**
 * Mint the next version of an integration's stored values.
 *
 * Always mints, activates only when the test passed (or the caller said to save
 * anyway). A failed save has to be durable: an admin who closes the tab while
 * the test is running comes back to the answer, and the previous working
 * connection has to still be the one in use while they read it.
 *
 * The expected version is re-stated as a qual on the UPDATE, not just compared
 * in the snapshot, so a save that lands between the read and the write matches
 * no row and writes nothing instead of overwriting the winner.
 */
export function saveIntegrationVersionStatement(input: SaveIntegrationVersionInput) {
  const activates = input.test.status === "passed";
  return sql`
    WITH existing AS (
      SELECT integration_id, latest_version, active_version, source, enabled
      FROM ${integrationConnections}
      WHERE integration_id = ${input.integrationId}
    ), resolved AS (
      SELECT
        COALESCE(existing.latest_version, 0) AS latest_version,
        existing.integration_id IS NULL AS creating,
        COALESCE(existing.latest_version, 0) = ${input.expectedVersion} AS allowed
      FROM (SELECT 1) AS anchor
      LEFT JOIN existing ON true
    ), inserted AS (
      INSERT INTO ${integrationConnections} (
        integration_id, latest_version, active_version, source,
        last_test_status, last_test_reason, last_test_message,
        last_test_at, last_test_fingerprint, updated_by, updated_at
      )
      SELECT
        ${input.integrationId}, 1, ${activates ? sql`1` : sql`NULL::integer`},
        'environment',
        ${activates ? sql`${input.test.status}` : sql`NULL::text`},
        ${activates && input.test.reason ? sql`${input.test.reason}` : sql`NULL::text`},
        ${activates && input.test.message ? sql`${input.test.message}` : sql`NULL::text`},
        ${activates ? sql`now()` : sql`NULL::timestamptz`},
        ${activates ? sql`${input.test.fingerprint}` : sql`NULL::text`},
        ${input.actorId}, now()
      FROM resolved
      WHERE resolved.creating AND resolved.allowed
      -- Reachable only when another save created the row between the read above
      -- and this insert. That writer already holds version 1, so this one is the
      -- loser of the race and must write nothing: the predicate re-states the
      -- token the caller carried, which no longer matches.
      ON CONFLICT (integration_id) DO NOTHING
      RETURNING integration_id, latest_version
    ), updated AS (
      UPDATE ${integrationConnections} SET
        latest_version = ${integrationConnections}.latest_version + 1,
        active_version = ${
          activates
            ? sql`${integrationConnections}.latest_version + 1`
            : sql`${integrationConnections}.active_version`
        },
        last_test_status = ${activates ? sql`${input.test.status}` : sql`${integrationConnections}.last_test_status`},
        last_test_reason = ${activates && input.test.reason ? sql`${input.test.reason}` : sql`${integrationConnections}.last_test_reason`},
        last_test_message = ${activates && input.test.message ? sql`${input.test.message}` : sql`${integrationConnections}.last_test_message`},
        last_test_at = ${activates ? sql`now()` : sql`${integrationConnections}.last_test_at`},
        last_test_fingerprint = ${activates ? sql`${input.test.fingerprint}` : sql`${integrationConnections}.last_test_fingerprint`},
        updated_by = ${input.actorId},
        updated_at = now()
      FROM resolved
      WHERE ${integrationConnections}.integration_id = ${input.integrationId}
        AND ${integrationConnections}.latest_version = ${input.expectedVersion}
        AND resolved.allowed
      RETURNING ${integrationConnections}.integration_id, ${integrationConnections}.latest_version
    ), target AS (
      SELECT integration_id, latest_version FROM inserted
      UNION ALL
      SELECT integration_id, latest_version FROM updated
    ), minted AS (
      INSERT INTO ${integrationConnectionVersions} (
        integration_id, version, config, secrets, test_status, test_reason,
        test_message, tested_at, actor_id
      )
      SELECT
        target.integration_id, target.latest_version,
        ${JSON.stringify(input.config)}::jsonb, ${JSON.stringify(input.secrets)}::jsonb,
        ${input.test.status}, ${input.test.reason}, ${input.test.message}, now(),
        ${input.actorId}
      FROM target
      RETURNING version
    )
    SELECT
      COALESCE((SELECT version FROM minted), 0) AS version,
      EXISTS (SELECT 1 FROM minted) AS minted,
      resolved.latest_version AS current_version
    FROM resolved
  `;
}

export async function saveIntegrationVersion(
  db: Db,
  input: SaveIntegrationVersionInput,
): Promise<SaveIntegrationVersionResult> {
  const result = await db.execute(saveIntegrationVersionStatement(input));
  const row = rowsOf<{ version: number; minted: boolean; current_version: number | null }>(
    result,
  )[0];
  if (!row) throw new Error("integration version save returned no outcome");
  // What the write DID, not what the snapshot planned: a token that moved
  // between the two selects matches no row here and mints nothing.
  if (!row.minted) {
    // Read again, in a statement of its own. The refused statement's own
    // snapshot was taken before the winner committed, so the number inside it
    // is the one this call started from, and a client that retried on it would
    // be refused forever. A second read is cheap on a path that already failed.
    return { conflict: true, currentVersion: await readLatestVersion(db, input.integrationId) };
  }
  return {
    conflict: false,
    version: Number(row.version),
    activated: input.test.status === "passed",
  };
}

/**
 * Turn an integration on or off.
 *
 * Mints no version and never touches the stored values: re-enabling has to find
 * exactly the configuration that was there, and a run in flight must not see its
 * connection reconfigured because somebody flipped a switch.
 */
async function readLatestVersion(db: Db, integrationId: string): Promise<number> {
  const rows = rowsOf<{ latest_version: number }>(
    await db.execute(sql`
      SELECT latest_version FROM ${integrationConnections}
      WHERE integration_id = ${integrationId}
    `),
  );
  return Number(rows[0]?.latest_version ?? 0);
}

export async function setIntegrationEnabled(
  db: Db,
  input: { integrationId: string; enabled: boolean; actorId: string | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${integrationConnections} (integration_id, enabled, updated_by, updated_at)
    VALUES (${input.integrationId}, ${input.enabled}, ${input.actorId}, now())
    ON CONFLICT (integration_id) DO UPDATE SET
      enabled = ${input.enabled},
      updated_by = ${input.actorId},
      updated_at = now()
  `);
}

/** Switch which source is live. The values of both sources are left alone, so
 *  switching back is another one-action switch rather than a re-entry. */
export async function setIntegrationSource(
  db: Db,
  input: { integrationId: string; source: IntegrationSource; actorId: string | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${integrationConnections} (integration_id, source, updated_by, updated_at)
    VALUES (${input.integrationId}, ${input.source}, ${input.actorId}, now())
    ON CONFLICT (integration_id) DO UPDATE SET
      source = ${input.source},
      updated_by = ${input.actorId},
      updated_at = now()
  `);
}

/** Record what the provider said about the configuration in use right now. */
export async function recordIntegrationTest(
  db: Db,
  input: {
    integrationId: string;
    status: "passed" | "failed";
    reason: IntegrationFailureReason | null;
    message: string | null;
    fingerprint: string;
    actorId: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${integrationConnections} (
      integration_id, last_test_status, last_test_reason, last_test_message,
      last_test_at, last_test_fingerprint, updated_by, updated_at
    )
    VALUES (
      ${input.integrationId}, ${input.status}, ${input.reason}, ${input.message},
      now(), ${input.fingerprint}, ${input.actorId}, now()
    )
    ON CONFLICT (integration_id) DO UPDATE SET
      last_test_status = ${input.status},
      last_test_reason = ${input.reason},
      last_test_message = ${input.message},
      last_test_at = now(),
      last_test_fingerprint = ${input.fingerprint},
      updated_by = ${input.actorId},
      updated_at = now()
  `);
}

/**
 * Disconnect: erase every stored value and every stored secret from every
 * version, and hand the connection back to the environment.
 *
 * The version rows survive with their actor, their time and their test verdict,
 * because the question "who connected this, and when" outlives the credential.
 * One statement, so a disconnect can never leave half the history holding
 * ciphertext.
 */
export async function disconnectIntegration(
  db: Db,
  input: { integrationId: string; actorId: string | null },
): Promise<void> {
  await db.execute(sql`
    WITH redacted AS (
      UPDATE ${integrationConnectionVersions} SET
        config = '{}'::jsonb,
        secrets = '{}'::jsonb,
        redacted_at = now()
      WHERE integration_id = ${input.integrationId}
        AND redacted_at IS NULL
      RETURNING version
    )
    UPDATE ${integrationConnections} SET
      source = 'environment',
      active_version = NULL,
      last_test_status = NULL,
      last_test_reason = NULL,
      last_test_message = NULL,
      last_test_at = NULL,
      last_test_fingerprint = NULL,
      updated_by = ${input.actorId},
      updated_at = now()
    WHERE integration_id = ${input.integrationId}
  `);
}

/** The audit an admin reads: who saved what, when, and what the provider said.
 *  Never the values. */
export async function readIntegrationAudit(
  db: Db,
  integrationId: string,
): Promise<
  {
    version: number;
    testStatus: "passed" | "failed";
    testMessage: string | null;
    actorId: string | null;
    createdAt: string;
    redactedAt: string | null;
  }[]
> {
  const rows = rowsOf<VersionRow & { redacted_at: string | Date | null; actor_id: string | null }>(
    await db.execute(sql`
      SELECT version, test_status, test_message, actor_id,
             created_at, redacted_at
      FROM ${integrationConnectionVersions}
      WHERE integration_id = ${integrationId}
      ORDER BY version DESC
    `),
  );
  return rows.map((row) => ({
    version: Number(row.version),
    testStatus: row.test_status,
    testMessage: row.test_message,
    actorId: row.actor_id,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    redactedAt: iso(row.redacted_at),
  }));
}

/**
 * The connected half: the same operations against this deployment's own
 * connection.
 *
 * The `db`-taking forms above are what a test with its own database calls. These
 * are what a service calls, because a service does not hold a database handle in
 * this worker: drizzle, the client and the table schemas are db-tier details,
 * and the fence gate says so.
 */
export function readConnectedIntegrationConnections() {
  return readIntegrationConnections(getDb());
}

export function saveConnectedIntegrationVersion(input: SaveIntegrationVersionInput) {
  return saveIntegrationVersion(getDb(), input);
}

export function setConnectedIntegrationEnabled(input: {
  integrationId: string;
  enabled: boolean;
  actorId: string | null;
}) {
  return setIntegrationEnabled(getDb(), input);
}

export function setConnectedIntegrationSource(input: {
  integrationId: string;
  source: IntegrationSource;
  actorId: string | null;
}) {
  return setIntegrationSource(getDb(), input);
}

export function recordConnectedIntegrationTest(input: {
  integrationId: string;
  status: "passed" | "failed";
  reason: IntegrationFailureReason | null;
  message: string | null;
  fingerprint: string;
  actorId: string | null;
}) {
  return recordIntegrationTest(getDb(), input);
}

export function disconnectConnectedIntegration(input: {
  integrationId: string;
  actorId: string | null;
}) {
  return disconnectIntegration(getDb(), input);
}

