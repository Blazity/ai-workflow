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
  /**
   * The integration's runtime as core calls it: every capability adapter a
   * factory here builds, `beginRun` and each page reader throw with this
   * connection's secrets already taken out (see `redactingRuntime`). An
   * adapter's own client (Octokit, a provider SDK, a `fetch` of its own) does
   * not go through `ctx.http`, and nobody calling a port should have to
   * remember that.
   */
  readonly runtime: ErasedIntegrationRuntime;
  readonly ctx: IntegrationContext<IntegrationManifest>;
  /**
   * This connection's secrets taken out of what its adapter hands back, for
   * core and never for the integration: a refusal's words (`text`), and a
   * thrown error (`error`, the copy `redactedError` makes, which keeps its
   * class, name, code and status). What `runtime` throws already went through
   * `error`; `text` is for what a port RETURNS in words of the provider's.
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
  const { readIntegrationStatesFrom, secretsKeyMaterial } = await import("./authoring.js");
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
  //
  // Read once: the states and the values they gate come from the same rows,
  // so a save landing between two reads cannot pair one version's state with
  // another version's values.
  let states: ReturnType<typeof readIntegrationStatesFrom>;
  let stored: Awaited<ReturnType<typeof readConnectedIntegrationConnections>>;
  try {
    stored = await readConnectedIntegrationConnections();
    states = readIntegrationStatesFrom(stored);
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
    const redaction: IntegrationRedaction = {
      text: (text) => redactIntegrationText(text, secrets),
      error: (error) => redactedError(error, (text) => redactIntegrationText(text, secrets)),
    };
    usable.push({
      manifest,
      runtime: redactingRuntime(runtime, redaction),
      ctx: buildIntegrationContext({
        manifest,
        values: values.values,
        secrets,
        // One per context rather than one shared never-aborting signal, so
        // whatever a request joins onto it goes away with the context.
        lifetime: input.lifetime ?? new AbortController().signal,
      }),
      redaction,
    });
  }
  return { readable: true, usable, states };
}

/**
 * The one place what an integration throws is redacted on its way into core.
 *
 * `ctx.http` redacts the errors of the requests that go through it, and that
 * covers only those: Octokit, GitLab's own `fetch` and anything else an
 * adapter builds reach core with whatever the provider or Node put in the
 * message (a token quoted in an invalid header, an echoing error body). Every
 * caller of a port catching and redacting on its own is the pattern that was
 * already forgotten once, so the runtime core's callers hold does it for them.
 *
 * What is wrapped: each capability factory, the adapter it returns (every
 * method, sync or async, and a nested adapter such as memory's `store`),
 * `beginRun` and each page reader. What is not: the integration's code runs
 * against the original objects, so nothing it does to itself changes.
 */
function redactingRuntime(
  runtime: ErasedIntegrationRuntime,
  redaction: IntegrationRedaction,
): ErasedIntegrationRuntime {
  const wrapped = new WeakMap<object, unknown>();
  return {
    ...runtime,
    capabilities: Object.fromEntries(
      Object.entries(runtime.capabilities).map(([id, factory]) => [
        id,
        (...args: never[]) => redactingAdapter(redacting(factory, undefined, redaction)(...args)),
      ]),
    ),
    ...(runtime.beginRun ? { beginRun: redacting(runtime.beginRun, runtime, redaction) } : {}),
    ...(runtime.api
      ? {
          api: Object.fromEntries(
            Object.entries(runtime.api).map(([page, reader]) => [
              page,
              redacting(reader, runtime.api, redaction),
            ]),
          ),
        }
      : {}),
  };

  /** A view of an adapter whose methods throw redacted, and nothing else changed. */
  function redactingAdapter<T>(adapter: T): T {
    if (!isAdapter(adapter)) return adapter;
    const known = wrapped.get(adapter);
    if (known) return known as T;
    const members = new Map<PropertyKey, unknown>();
    const view = new Proxy(adapter, {
      get(target, property) {
        const value: unknown = redacting(() => Reflect.get(target, property, target), undefined, redaction)();
        if (typeof value === "function") {
          if (!members.has(property)) {
            members.set(
              property,
              redacting(value as (...args: unknown[]) => unknown, target, redaction),
            );
          }
          return members.get(property);
        }
        return isAdapter(value) ? redactingAdapter(value) : value;
      },
    });
    wrapped.set(adapter, view);
    return view;
  }
}

/**
 * `fn` called on `self`, with what it throws (or its promise rejects with)
 * passed through `redaction.error` first. A value it returns is its own.
 */
function redacting<A extends unknown[], R>(
  fn: (...args: A) => R,
  self: unknown,
  redaction: IntegrationRedaction,
): (...args: A) => R {
  return (...args: A): R => {
    let result: R;
    try {
      result = fn.apply(self, args);
    } catch (error) {
      throw redaction.error(error);
    }
    if (isThenable(result)) {
      return Promise.resolve(result).catch((error: unknown) => {
        throw redaction.error(error);
      }) as R;
    }
    return result;
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * What a port hands core that has behaviour: a class instance (every
 * adapter), or a plain object holding at least one function (memory's
 * `store`). Plain data (a string, an array, a record of values) is handed over
 * as it is, because a proxy is not what a caller that clones or serialises it
 * expects.
 */
function isAdapter(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isThenable(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return true;
  return Object.values(value).some((member) => typeof member === "function");
}
