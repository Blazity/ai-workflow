import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IntegrationFailureReason, IntegrationSource } from "@shared/contracts";

/**
 * What an admin decided about one integration, and nothing else.
 *
 * No row is the answer for a deployment that configured everything through
 * environment variables, which is every deployment on the day this lands: the
 * defaults here ARE that deployment's state, so it needs no migration and its
 * admin needs to do nothing. A row appears the first time somebody disables an
 * integration or stores a value for it.
 *
 * The integration id is the primary key and is deliberately not a foreign key to
 * anything: which integrations exist is decided by the build, not by the
 * database, so a row whose integration this build no longer ships is ignored
 * rather than orphaned.
 *
 * Two counters, because they answer different questions.
 * `latestVersion` is what a save's `expectedVersion` is compared against and
 * what the next mint increments; it moves even when a save fails its test, which
 * is how a second tab learns it is stale. `activeVersion` is the version whose
 * values are actually used when `stored` is the source; it moves only when a
 * test passes. A failed save therefore leaves the working connection alone and
 * still gets remembered, which is what lets an admin close the tab mid-test and
 * read the result later.
 */
export const integrationConnections = pgTable(
  "integration_connections",
  {
    integrationId: text("integration_id").primaryKey(),
    /** Read live at every use, never pinned by a run: it is the kill switch. */
    enabled: boolean("enabled").notNull().default(true),
    source: text("source").$type<IntegrationSource>().notNull().default("environment"),
    latestVersion: integer("latest_version").notNull().default(0),
    activeVersion: integer("active_version"),
    /**
     * The last time this deployment asked the provider, whichever source was
     * active. Fingerprinted, so a verdict about values that have since changed
     * goes stale instead of blaming the new ones: an admin who fixed a variable
     * and redeployed must not keep reading the old refusal.
     *
     * The fingerprint covers secrets as salted digests and never leaves the
     * worker, which is why it is here and not in any response type.
     */
    lastTestStatus: text("last_test_status").$type<"passed" | "failed">(),
    lastTestReason: text("last_test_reason").$type<IntegrationFailureReason>(),
    lastTestMessage: text("last_test_message"),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestFingerprint: text("last_test_fingerprint"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("integration_connections_source_check", sql`${t.source} in ('environment', 'stored')`),
    check(
      "integration_connections_last_test_status_check",
      sql`${t.lastTestStatus} is null or ${t.lastTestStatus} in ('passed', 'failed')`,
    ),
    /** An active version is always one that was minted. */
    check(
      "integration_connections_active_version_check",
      sql`${t.activeVersion} is null or (${t.activeVersion} >= 1 and ${t.activeVersion} <= ${t.latestVersion})`,
    ),
  ],
);

/**
 * Every set of values an admin saved, append-only, with who saved it and what
 * the provider said about it.
 *
 * `config` holds the non-secret fields by key; `secrets` holds one
 * `v1:<keyId>:<scope>:<iv>:<tag>:<ciphertext>` envelope per secret field (see
 * `infra/secrets-crypto.ts`). Two columns rather than one, so a read that only
 * needs to fill a form never touches a ciphertext, and so disconnecting can
 * empty every secret in the history with one assignment while the audit of who
 * saved what and when survives it.
 *
 * `testStatus` is this version's own verdict and is what decided whether it
 * became active. It is audit: the status a card shows comes from the resolver,
 * which reads the active version's verdict and the connection's last test.
 */
export const integrationConnectionVersions = pgTable(
  "integration_connection_versions",
  {
    id: serial("id").primaryKey(),
    integrationId: text("integration_id").notNull(),
    version: integer("version").notNull(),
    config: jsonb("config")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    secrets: jsonb("secrets")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * One non-reversible marker per secret field, written in the same statement
     * as the ciphertext beside it.
     *
     * It exists because the ciphertext cannot answer "is this the same secret as
     * before": AES-GCM uses a random initialisation vector, so re-saving the
     * identical token produces different bytes every time. A fingerprint built
     * from those bytes would move on every save and stop every run in flight
     * with `reconfigured` although the account never changed.
     *
     * Written at save time, where the plaintext is. The resolver holds only the
     * key id and never decrypts, so this is the only way it can compare.
     */
    secretDigests: jsonb("secret_digests")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    testStatus: text("test_status").$type<"passed" | "failed">().notNull(),
    testReason: text("test_reason").$type<IntegrationFailureReason>(),
    testMessage: text("test_message"),
    testedAt: timestamp("tested_at", { withTimezone: true }),
    /** Set when Disconnect erased this version's values; the row stays as audit. */
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    /** The dashboard user id. A name is not stored: it would be a copy that
     *  goes stale, and the screen already resolves ids against its user list. */
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Two admins saving at the same moment get distinct versions or a refusal,
     *  never one version written twice. */
    uniqueIndex("integration_connection_versions_unique").on(t.integrationId, t.version),
    check(
      "integration_connection_versions_test_status_check",
      sql`${t.testStatus} in ('passed', 'failed')`,
    ),
  ],
);
