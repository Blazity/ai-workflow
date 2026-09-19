/**
 * The step that creates one integration's per-run state, at the run's first
 * use of that integration.
 *
 * Why it is a step at all: some providers cannot be asked twice for the same
 * thing. The one this port was designed from answers a second request for a
 * bucket called `AWT-42` by creating `AWT-42.1`, so a run that asked once per
 * use would scatter itself over a new bucket every time. Recording the answer
 * is what makes "once" true across an invocation boundary: a run that suspends
 * for a person and resumes days later replays this step from its event log
 * rather than calling the provider again.
 *
 * One step for every integration, told which one by its argument, because the
 * Workflow DevKit identifies a step by its module path and its function name:
 * a step per integration would carry an integration's id in its identity, and
 * moving or renaming that integration would strand every run suspended past it.
 *
 * One integration per call, so using one integration never creates another's
 * state, a provider that throws is recorded against itself alone, and each
 * provider gets its own time bound rather than a share of one.
 *
 * No retries: creating the state is a side effect at the provider, and a retry
 * after an ambiguous failure is exactly how a second bucket appears.
 */
import type { IntegrationRunState } from "@integrations/sdk";

/** Bounded well under the invocation ceiling; this is one call to one provider. */
const RUN_STATE_TIMEOUT_MS = 60_000;

export interface IntegrationRunStateInput {
  readonly integrationId: string;
  readonly runId: string;
  /** What the run is about, from `runSubjectKey` and nowhere else. */
  readonly subjectKey: string;
}

/**
 * What the run records about one integration's state. The four answers are
 * kept apart because each means something different for the rest of the run:
 *
 * - `ready`: the provider made the state; every later use reads it.
 * - `none`: the integration declares no run state, or is not usable on this
 *   deployment right now. Nothing was asked of any provider.
 * - `failed`: the provider was asked and did not produce a state. Recorded for
 *   the run, because asking again could create a second one.
 * - `unreadable`: this deployment's own integration settings could not be
 *   read, so no provider was asked. Not remembered past this use: the next use
 *   asks again, and a block that needed the state says the settings could not
 *   be read rather than blaming the provider.
 */
export type IntegrationRunStateOutcome =
  | { readonly status: "ready"; readonly state: IntegrationRunState }
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "unreadable"; readonly reason: string };

export async function createIntegrationRunStateStep(
  input: IntegrationRunStateInput,
): Promise<IntegrationRunStateOutcome> {
  "use step";
  const { resolveUsableIntegrations } = await import("../../services/integrations/runtime.js");
  const { logger } = await import("../../infra/logger.js");
  const { isRunControlError } = await import("../helpers/run-control-error.js");

  const resolved = await resolveUsableIntegrations({
    signal: AbortSignal.timeout(RUN_STATE_TIMEOUT_MS),
    filter: (manifest) => manifest.id === input.integrationId,
  });
  if (!resolved.readable) return { status: "unreadable", reason: resolved.reason };

  const [usable] = resolved.usable;
  if (!usable || usable.manifest.runState !== true) return { status: "none" };
  if (typeof usable.runtime.beginRun !== "function") {
    // Conformance refuses this, so it means a build assembled from mismatched
    // commits rather than a mistake anyone can see in a diff.
    logger.warn({ integration: input.integrationId }, "integration_run_state_not_implemented");
    return { status: "failed", reason: "The integration declares run state but cannot create it." };
  }

  try {
    const begin = usable.runtime.beginRun as (
      start: { runId: string; subjectKey: string },
      context: typeof usable.ctx,
    ) => Promise<IntegrationRunState | null>;
    const state = await begin({ runId: input.runId, subjectKey: input.subjectKey }, usable.ctx);
    if (state === null) {
      return { status: "failed", reason: "The integration created no state for this run." };
    }
    return { status: "ready", state };
  } catch (error) {
    if (isRunControlError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      { integration: input.integrationId, err: reason, runId: input.runId, subjectKey: input.subjectKey },
      "integration_run_state_failed",
    );
    return { status: "failed", reason };
  }
}
createIntegrationRunStateStep.maxRetries = 0;
