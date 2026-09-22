/**
 * The deployment half of integration health: what this build ships, what the
 * resolver says about each one, and how to call its own probes.
 *
 * Everything provider-specific stays behind the registry and the manifest. The
 * decisions (what a section shows, what a probe's answer means) are in
 * integration-health.ts, which is pure; this file only reads the database, the
 * environment and the runtimes.
 */
import { integrationManifests } from "@integrations/registry";
import { integrationRuntime } from "@integrations/registry/worker";
import type { IntegrationHealthResult, IntegrationManifest } from "@integrations/sdk";

import type { StoredIntegrationConnection } from "../integrations/index.js";
import {
  type ConnectionValue,
  buildIntegrationContext,
  environmentReaderFrom,
  readConnectionValues,
  resolveIntegrationState,
  secretsKeyMaterial,
  secretValuesOf,
} from "../integrations/index.js";
import type { IntegrationHealthEntry } from "./integration-health.js";

/**
 * One entry per integration this build ships, in registry order.
 *
 * The stored rows come in rather than being read here: this is the same
 * "non-empty registry means a database" trap the block contracts had, and the
 * caller is the one that knows whether this scan is running against a
 * connection. The registry shortcut below stays as a shortcut, not as the
 * reason a test without a database passes.
 */
export function integrationHealthEntries(
  stored: Map<string, StoredIntegrationConnection>,
): IntegrationHealthEntry[] {
  if (integrationManifests.length === 0) return [];
  const material = secretsKeyMaterial();
  const environment = environmentReaderFrom();

  return integrationManifests.map((manifest) => {
    const row = stored.get(manifest.id) ?? null;
    const state = resolveIntegrationState({
      manifest,
      environment,
      stored: row,
      secretsKey: material.present
        ? { present: true, keyId: material.keyId }
        : { present: false },
    });
    // Values are read only for a connection the resolver already called
    // usable, so a deployment that connected nothing decrypts nothing.
    const values = state.usable
      ? readConnectionValues({
          manifest,
          source: state.source,
          environment,
          active: row?.active ?? null,
          secretsKey: material,
        })
      : null;
    if (!values?.ok) return { manifest, state };
    const secrets = secretValuesOf(manifest, values.values);
    return {
      manifest,
      state,
      secrets,
      probe: (checkId, signal) => runProbe(manifest, values.values, secrets, checkId, signal),
    };
  });
}

function runProbe(
  manifest: IntegrationManifest,
  values: Readonly<Record<string, ConnectionValue>>,
  secrets: readonly string[],
  checkId: string,
  signal: AbortSignal,
): Promise<IntegrationHealthResult> {
  const probe = integrationRuntime(manifest.id)?.health[checkId];
  if (!probe) {
    // Declaring a check without a probe does not compile, so this is a build
    // that shipped a manifest without its runtime. It is one failing check.
    throw new Error("This build ships no probe for that check.");
  }
  const context = buildIntegrationContext({ manifest, values, secrets, signal });
  return (probe as (ctx: unknown) => Promise<IntegrationHealthResult>)(context);
}
