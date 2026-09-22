/**
 * The secrets this deployment knows, for every redaction and scan core runs.
 *
 * ONE SOURCE. `knownSecretValues()` is the environment's secret-named values
 * (`environmentSecretValues`, the one rule for which variable holds a secret)
 * plus the secret fields of every connected integration. The second half is
 * the reason this module exists: a connection an admin stored in the dashboard
 * is decrypted from `integration_connections` and never reaches the
 * environment, so a set built from `process.env` alone printed a pasted token
 * into run logs, replays and ticket comments in the clear. Every redaction set
 * in core is this one; the per-site lists it replaced are gone.
 *
 * Workflow scope cannot call it (no database, and a step result holding every
 * secret would put them all in the run's event log). It redacts with the
 * environment half before a value crosses into a step, and the step that
 * writes or publishes the value applies this whole set.
 *
 * FAILURE POLICY, one for every caller: when the integration settings cannot
 * be read, both functions below throw `IntegrationSecretsUnreadableError`, and
 * no caller catches it to carry on with the environment half. Every caller is
 * about to write core's own tables or publish outside the process. A smaller
 * set there is a stored secret written in the clear, silently; a throw costs
 * one step attempt (retried by the Workflow runtime or reported by the
 * caller's own error path) on a database that is failing that write anyway.
 * A connection whose values cannot be opened (no secrets key, a key that does
 * not match the one it was sealed with) is a different case and is skipped:
 * this process cannot hand that secret to a sandbox or a provider either, so
 * there is nothing of it to leak from here.
 */
import type { IntegrationManifest } from "@integrations/sdk";
import type { Db } from "../../db/types.js";
import { environmentSecretValues } from "../../run-observability/configured-secrets.js";

export interface SecretSourceOptions {
  /** The database the connections are read from: the deployment's own by
   *  default. A caller that already holds a handle (a read model built on one,
   *  a test on pglite) reads the same rows through the same derivation. */
  readonly db?: Db;
}

/** The integration settings could not be read, so the set of secrets this
 *  deployment knows is incomplete and must not be used as if it were whole.
 *
 *  The message is fixed and the database's own words ride in `cause`: callers
 *  put this message where people read it (a ticket, a run's failure), and a
 *  driver's error text there reads like a leak and helps nobody act. The
 *  source logs the cause once, where it throws. */
export class IntegrationSecretsUnreadableError extends Error {
  constructor(cause: unknown) {
    super(INTEGRATION_SECRETS_UNREADABLE, { cause });
    this.name = "IntegrationSecretsUnreadableError";
  }
}

export const INTEGRATION_SECRETS_UNREADABLE =
  "The integration settings could not be read, so the secrets they hold could not be redacted.";

/**
 * Every secret this deployment knows: the environment's and every connected
 * integration's, deduplicated. Throws `IntegrationSecretsUnreadableError`
 * when the integration half cannot be read (see the failure policy above).
 */
export async function knownSecretValues(options: SecretSourceOptions = {}): Promise<string[]> {
  return [
    ...new Set([...environmentSecretValues(), ...(await integrationSecretValues(options))]),
  ];
}

/** How long a failing read waits before its next attempt. Short: every caller
 *  is on a path somebody is waiting on (an MCP call, a step, a page), and this
 *  exists to ride out a database blink, not an outage. */
const READ_RETRY_DELAYS_MS = [150, 450] as const;

/**
 * The plaintext secrets every integration `include` accepts (all of them by
 * default) holds or has held here, deduplicated. Two halves, whatever an
 * integration's connection state:
 *
 * - The values its secret fields have in the environment. A value this process
 *   holds is one it can print, connected through it or not.
 * - Every stored version that still holds secrets, not only the active one
 *   (`readRetainedIntegrationSecrets`): a key rotated mid-run is still in the
 *   sandboxes that run started, and stays in this set until a disconnect
 *   redacts it. Disabled is included for the same reason: switching an
 *   integration off does not make a key that is still in a sandbox safe to
 *   print.
 *
 * One read of the connection tables, retried briefly (`READ_RETRY_DELAYS_MS`)
 * so a blink of the database does not fail a caller that would otherwise
 * succeed; a read that still fails throws `IntegrationSecretsUnreadableError`.
 *
 * A caller that needs a narrower set than `knownSecretValues` passes a filter
 * rather than building its own list: the clarification snapshot scan writes
 * its patterns INTO the sandbox, so it asks for exactly the integrations whose
 * secrets are in a sandbox by design (`agent_tracing`, ADR-010 decision 7) and
 * never hands a sandbox a credential it did not already hold.
 */
export async function integrationSecretValues(
  options: SecretSourceOptions & {
    readonly include?: (manifest: IntegrationManifest) => boolean;
  } = {},
): Promise<string[]> {
  const { integrationManifests } = await import("@integrations/registry");
  const { secretsKeyMaterial } = await import("./authoring.js");
  const { readConnectionValues, secretValuesOf } = await import("./connection-values.js");
  const { environmentReaderFrom } = await import("./resolve.js");

  const include = options.include ?? (() => true);
  const candidates = integrationManifests.filter(
    (manifest) => include(manifest) && manifest.connection.fields.some((field) => field.secret),
  );
  if (candidates.length === 0) return [];

  const retained = await readRetainedSecrets(options.db);
  const environment = environmentReaderFrom();
  const secretsKey = secretsKeyMaterial();
  const values = new Set<string>();
  const unopenable: string[] = [];
  for (const manifest of candidates) {
    const fromEnvironment = readConnectionValues({
      manifest,
      source: "environment",
      environment,
      active: null,
      secretsKey,
    });
    if (fromEnvironment.ok) {
      for (const secret of secretValuesOf(manifest, fromEnvironment.values)) values.add(secret);
    }
    const versions = retained.get(manifest.id) ?? [];
    for (const [index, version] of versions.entries()) {
      const opened = readConnectionValues({
        manifest,
        source: "stored",
        environment,
        active: version,
        secretsKey,
      });
      if (!opened.ok) {
        // Only the newest is worth a line: an older version sealed under a key
        // this deployment has since replaced will never open again, and saying
        // so on every call is noise, not news.
        if (index === 0) unopenable.push(manifest.id);
        continue;
      }
      for (const secret of secretValuesOf(manifest, opened.values)) values.add(secret);
    }
  }
  if (unopenable.length > 0) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn({ integrations: unopenable }, "integration_secrets_unopenable");
  }
  return [...values];
}

async function readRetainedSecrets(
  db: Db | undefined,
): Promise<Map<string, import("../../db/repositories/integrations.js").StoredIntegrationVersion[]>> {
  const { readConnectedRetainedIntegrationSecrets, readRetainedIntegrationSecrets } = await import(
    "../../db/repositories/integrations.js"
  );
  let lastError: unknown;
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      return db ? await readRetainedIntegrationSecrets(db) : await readConnectedRetainedIntegrationSecrets();
    } catch (error) {
      lastError = error;
    }
  }
  const { logger } = await import("../../infra/logger.js");
  logger.warn(
    { err: lastError instanceof Error ? lastError.message : String(lastError) },
    "integration_secrets_unreadable",
  );
  throw new IntegrationSecretsUnreadableError(lastError);
}
