/**
 * Every secret this deployment's integrations hold, for the redaction pass
 * that runs over anything core is about to publish.
 *
 * Core used to name each provider's credential by hand, one line per
 * environment variable. An integration's credential does not appear in that
 * list and cannot: the variable names belong to the integration, and a stored
 * connection has no variable at all. So the redaction set asks the same
 * resolver everything else asks, and a new integration is covered the day it
 * ships rather than the day somebody remembers.
 *
 * It exists because a credential can reach core's output the long way round: a
 * tracing provider's key lives inside the sandbox (ADR-010, decision 7), an
 * agent can echo its own environment, and what an agent wrote is what a person
 * reads in a run log and what a tool hands back over MCP.
 */
import type { IntegrationManifest } from "@integrations/sdk";

/**
 * The plaintext secrets of every usable integration, in no particular order
 * and with duplicates removed. Empty when nothing is connected, when the
 * secrets key is absent, or when a connection cannot be read: redaction is a
 * safety net over values we hold, never a reason to fail a caller.
 */
export async function integrationSecretValues(): Promise<string[]> {
  const { integrationManifests } = await import("@integrations/registry");
  const { readIntegrationStatesFrom, secretsKeyMaterial } = await import("./authoring.js");
  const { readConnectionValues, secretValuesOf } = await import("./connection-values.js");
  const { environmentReaderFrom } = await import("./resolve.js");
  const { readConnectedIntegrationConnections } = await import(
    "../../db/repositories/integrations.js"
  );

  const hasSecret = (manifest: IntegrationManifest) =>
    manifest.connection.fields.some((field) => field.secret);
  const candidates = integrationManifests.filter(hasSecret);
  if (candidates.length === 0) return [];

  const environment = environmentReaderFrom();
  const secretsKey = secretsKeyMaterial();
  // A redaction set is a safety net over values we hold. Failing the caller
  // because the net could not be read would turn an unreachable database into
  // a refusal on a path that is about to fail on its own reads anyway.
  // One read: the states and the values they gate come from the same rows.
  let states: ReturnType<typeof readIntegrationStatesFrom>;
  let stored: Awaited<ReturnType<typeof readConnectedIntegrationConnections>>;
  try {
    stored = await readConnectedIntegrationConnections();
    states = readIntegrationStatesFrom(stored);
  } catch (error) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "integration_secrets_unreadable",
    );
    return [];
  }

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
    if (!resolved.ok) continue;
    for (const secret of secretValuesOf(manifest, resolved.values)) values.add(secret);
  }
  return [...values];
}
