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
 *  deployment knows is incomplete and must not be used as if it were whole. */
export class IntegrationSecretsUnreadableError extends Error {
  constructor(cause: unknown) {
    super(
      `The integration settings could not be read, so the secrets they hold could not be redacted (${
        cause instanceof Error ? cause.message : String(cause)
      }).`,
      { cause },
    );
    this.name = "IntegrationSecretsUnreadableError";
  }
}

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

/**
 * The plaintext secrets of every connected integration `include` accepts
 * (all of them by default), deduplicated.
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
  const { readIntegrationStates, readIntegrationStatesOn, secretsKeyMaterial } = await import(
    "./authoring.js"
  );
  const { readConnectionValues, secretValuesOf } = await import("./connection-values.js");
  const { environmentReaderFrom } = await import("./resolve.js");
  const { readConnectedIntegrationConnections, readIntegrationConnections } = await import(
    "../../db/repositories/integrations.js"
  );

  const include = options.include ?? (() => true);
  const candidates = integrationManifests.filter(
    (manifest) => include(manifest) && manifest.connection.fields.some((field) => field.secret),
  );
  if (candidates.length === 0) return [];

  let states: Awaited<ReturnType<typeof readIntegrationStates>>;
  let stored: Awaited<ReturnType<typeof readConnectedIntegrationConnections>>;
  try {
    const db = options.db;
    states = db ? await readIntegrationStatesOn(db) : await readIntegrationStates();
    stored = db
      ? await readIntegrationConnections(db)
      : await readConnectedIntegrationConnections();
  } catch (error) {
    throw new IntegrationSecretsUnreadableError(error);
  }

  const environment = environmentReaderFrom();
  const secretsKey = secretsKeyMaterial();
  const values = new Set<string>();
  for (const manifest of candidates) {
    // Disabled is deliberately included: an admin turning an integration off
    // does not make a key that is still in a sandbox safe to print.
    const state = states.get(manifest.id);
    if (!state || state.connection !== "connected") continue;
    const resolved = readConnectionValues({
      manifest,
      source: state.source,
      environment,
      active: stored.get(manifest.id)?.active ?? null,
      secretsKey,
    });
    if (!resolved.ok) {
      const { logger } = await import("../../infra/logger.js");
      logger.warn(
        { integration: manifest.id, source: state.source },
        "integration_secrets_unopenable",
      );
      continue;
    }
    for (const secret of secretValuesOf(manifest, resolved.values)) values.add(secret);
  }
  return [...values];
}
