/**
 * Reaching a usable integration's own code, with the context it receives.
 *
 * Three callers need this and none of them is running a block: the step that
 * creates an integration's per-run state, the sandbox steps that ask every
 * tracing provider what a harness needs, and the route behind a contributed
 * page. Each runs server side, which is where a connection may be read at all.
 *
 * It resolves nothing of its own: the state comes from `resolve.ts`, the one
 * place a status is decided, and the context from `context.ts`. A second
 * derivation of either is exactly what ADR-010 says not to build, which is also
 * why this lives here rather than in the engine that calls it.
 */
import type {
  ErasedIntegrationRuntime,
  IntegrationContext,
  IntegrationManifest,
} from "@integrations/sdk";

/** One integration this deployment can actually use right now. */
export interface UsableIntegration {
  readonly manifest: IntegrationManifest;
  readonly runtime: ErasedIntegrationRuntime;
  readonly ctx: IntegrationContext<IntegrationManifest>;
}

/**
 * Every connected, enabled integration whose connection values can be read,
 * each with the context its own code receives; empty when this deployment's
 * integration settings could not be read at all.
 *
 * `filter` narrows the manifests before any connection is opened, so a
 * deployment with five integrations does not decrypt five connections to find
 * the one that traces.
 */
export async function usableIntegrations(input: {
  readonly signal: AbortSignal;
  readonly filter?: (manifest: IntegrationManifest) => boolean;
}): Promise<UsableIntegration[]> {
  const resolved = await resolveUsableIntegrations(input);
  return resolved.readable ? resolved.usable : [];
}

/**
 * The same answer, keeping "could not read our own settings" apart from
 * "nothing is usable". A caller that records its answer for the rest of a run
 * needs the difference: a database that did not answer for a moment is not an
 * integration that is off, and remembering it as one would refuse every later
 * use in the run while blaming the provider.
 */
export async function resolveUsableIntegrations(input: {
  readonly signal: AbortSignal;
  readonly filter?: (manifest: IntegrationManifest) => boolean;
}): Promise<
  | { readonly readable: true; readonly usable: UsableIntegration[] }
  | { readonly readable: false; readonly reason: string }
> {
  const { integrationManifests } = await import("@integrations/registry");
  const { integrationRuntime } = await import("@integrations/registry/worker");
  // Imported from where each one is defined rather than through `runtime.ts`,
  // which re-exports this file: the boundaries gate reads that round trip as a
  // cycle, and it would be one.
  const { readIntegrationStates, secretsKeyMaterial } = await import("./authoring.js");
  const { readConnectionValues, secretValuesOf } = await import("./connection-values.js");
  const { environmentReaderFrom } = await import("./resolve.js");
  const { buildIntegrationContext } = await import("./context.js");
  const { readConnectedIntegrationConnections } = await import(
    "../../db/repositories/integrations.js"
  );
  const { logger } = await import("../../infra/logger.js");

  const candidates = integrationManifests.filter((manifest) => input.filter?.(manifest) ?? true);
  if (candidates.length === 0) return { readable: true, usable: [] };

  // A database this caller cannot reach is not a failure of the caller's work:
  // every caller here is doing something alongside it (tracing a run, naming a
  // bucket, drawing a page). It is reported as unreadable rather than as
  // "nothing usable", and each caller decides what that means where it is.
  let states: Awaited<ReturnType<typeof readIntegrationStates>>;
  let stored: Awaited<ReturnType<typeof readConnectedIntegrationConnections>>;
  try {
    states = await readIntegrationStates();
    stored = await readConnectedIntegrationConnections();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ err: reason }, "integration_states_unreadable");
    return { readable: false, reason };
  }
  const secretsKey = secretsKeyMaterial();
  const environment = environmentReaderFrom();

  const usable: UsableIntegration[] = [];
  for (const manifest of candidates) {
    const state = states.get(manifest.id);
    if (!state?.usable) continue;
    const runtime = integrationRuntime(manifest.id);
    if (!runtime) continue;
    const values = readConnectionValues({
      manifest,
      source: state.source,
      environment,
      active: stored.get(manifest.id)?.active ?? null,
      secretsKey,
    });
    if (!values.ok) {
      // The card already says why, and this caller is doing something the run
      // can go on without, so it is a line in the log rather than a failure.
      logger.warn(
        { integration: manifest.id, reason: values.failure.reason },
        "integration_connection_unreadable",
      );
      continue;
    }
    usable.push({
      manifest,
      runtime,
      ctx: buildIntegrationContext({
        manifest,
        values: values.values,
        secrets: secretValuesOf(manifest, values.values),
        signal: input.signal,
      }),
    });
  }
  return { readable: true, usable };
}
