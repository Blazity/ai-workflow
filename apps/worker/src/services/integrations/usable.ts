/**
 * Reaching a usable integration's own code, with the context it receives.
 *
 * Every capability runtime reaches its provider through this (the tracker,
 * version control, memory, messaging), and so do the step that creates an
 * integration's per-run state, the sandbox steps that ask every tracing
 * provider what a harness needs, the route behind a contributed page and the
 * webhook route. Each runs server side, which is where a connection may be
 * read at all.
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
import type { IntegrationState } from "@shared/contracts";

/** One integration this deployment can actually use right now. */
export interface UsableIntegration {
  readonly manifest: IntegrationManifest;
  readonly runtime: ErasedIntegrationRuntime;
  readonly ctx: IntegrationContext<IntegrationManifest>;
  /**
   * This connection's secrets taken out of what its adapter hands back, for
   * core and never for the integration: a refusal's words (`text`) and a
   * thrown error (`error`, a copy that keeps its name). `ctx` already does
   * this for its own log and its own requests; this is the same redaction,
   * with the same secrets, for what reaches core through a capability port.
   */
  readonly redaction: IntegrationRedaction;
}

export interface IntegrationRedaction {
  text(text: string): string;
  error(error: unknown): Error;
}

/**
 * How long the contexts a resolution builds live.
 *
 * Absent, which is right for a caller that HOLDS what it resolved and makes
 * calls through it for as long as it holds it (a step, a poll pass, a resume):
 * the contexts never abort on their own, and every request is still bounded by
 * its own per-attempt timer. Pass a signal when the caller has a total deadline
 * for everything it does with them (a webhook request, a page read) or owns a
 * budget it may have to end early (memory). What it must never be is a timer
 * started at resolution by a caller that then holds the result: nothing bounds
 * the resolution with it, and once it fires every request through the context
 * fails at once, looking exactly like the provider timing out.
 */
type ContextLifetime = { readonly lifetime?: AbortSignal };

/**
 * Every connected, enabled integration whose connection values can be read,
 * each with the context its own code receives; empty when this deployment's
 * integration settings could not be read at all.
 *
 * `filter` narrows the manifests before any connection is opened, so a
 * deployment with five integrations does not decrypt five connections to find
 * the one that traces.
 */
export async function usableIntegrations(input: ContextLifetime & {
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
 *
 * `states` is the resolver's own reading of the candidates, handed back rather
 * than re-derived: a caller that has to tell a person WHY an integration it
 * asked for is missing from `usable` (disabled, never connected) would
 * otherwise decide that a second time, which is the one thing `resolve.ts`
 * exists to prevent. It carries no secret and no ciphertext.
 */
export async function resolveUsableIntegrations(input: ContextLifetime & {
  readonly filter?: (manifest: IntegrationManifest) => boolean;
}): Promise<
  | {
      readonly readable: true;
      readonly usable: UsableIntegration[];
      readonly states: ReadonlyMap<string, IntegrationState>;
    }
  | { readonly readable: false; readonly reason: string }
> {
  const { integrationManifests } = await import("@integrations/registry");
  const { integrationRuntime } = await import("@integrations/registry/worker");
  // Imported from where each one is defined rather than through `runtime.ts`,
  // which re-exports this file: the boundaries gate reads that round trip as a
  // cycle, and it would be one.
  const { readIntegrationStates, secretsKeyMaterial } = await import("./authoring.js");
  const { readConnectionValues, redactIntegrationText, secretValuesOf } = await import(
    "./connection-values.js"
  );
  const { environmentReaderFrom } = await import("./resolve.js");
  const { buildIntegrationContext, redactedError } = await import("./context.js");
  const { readConnectedIntegrationConnections } = await import(
    "../../db/repositories/integrations.js"
  );
  const { logger } = await import("../../infra/logger.js");

  const candidates = integrationManifests.filter((manifest) => input.filter?.(manifest) ?? true);
  if (candidates.length === 0) return { readable: true, usable: [], states: new Map() };

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
    const secrets = secretValuesOf(manifest, values.values);
    usable.push({
      manifest,
      runtime,
      ctx: buildIntegrationContext({
        manifest,
        values: values.values,
        secrets,
        // One per context rather than one shared never-aborting signal, so
        // whatever a request joins onto it goes away with the context.
        lifetime: input.lifetime ?? new AbortController().signal,
      }),
      redaction: {
        text: (text) => redactIntegrationText(text, secrets),
        error: (error) => redactedError(error, (text) => redactIntegrationText(text, secrets)),
      },
    });
  }
  return { readable: true, usable, states };
}
