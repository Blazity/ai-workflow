/**
 * The step that creates per-run integration state, for every integration a
 * single use needs, in one call.
 *
 * Why it is a step at all: some providers cannot be asked twice for the same
 * thing. The one this port was designed from answers a second request for a
 * bucket called `AWT-42` by creating `AWT-42.1`, so a run that asked once per
 * use would scatter itself over a new bucket every time. Recording the answer
 * is what makes "once" true across an invocation boundary: a run that suspends
 * for a person and resumes days later replays this step from its event log
 * rather than calling the provider again.
 *
 * One step for every integration, told which ones by its argument, because the
 * Workflow DevKit identifies a step by its module path and its function name:
 * a step per integration would carry an integration's id in its identity, and
 * moving or renaming that integration would strand every run suspended past it.
 *
 * THE INVARIANT THIS SHAPE EXISTS FOR: the number and order of step calls a run
 * makes must depend only on the graph, never on which integrations the build
 * contains. A list of ids is an argument; a list of ids would be a list of step
 * calls if every integration had its own. Shipping a second tracing provider,
 * or dropping one, would then change the step sequence of every run already
 * suspended past its first sandbox, and each of them would die replaying it.
 * Adding an integration must never be a drain event, so the caller asks once
 * per use, with as many ids as that use needs and with none when it needs none.
 *
 * Inside the call each integration is resolved on its own: its own connection
 * read, its own 60 second bound, its own recorded outcome. A provider that
 * throws is recorded against itself alone and never eats another's time.
 *
 * No retries: creating the state is a side effect at the provider, and a retry
 * after an ambiguous failure is exactly how a second bucket appears.
 */
import type { IntegrationRunState } from "@integrations/sdk";
import type { IntegrationConnectionPin, IntegrationUnavailableReason } from "@shared/contracts";

/** Bounded well under the invocation ceiling; this is one call to one provider. */
const RUN_STATE_TIMEOUT_MS = 60_000;

export interface IntegrationRunStatesInput {
  /** Every integration this use needs the state of. May be empty. */
  readonly integrationIds: readonly string[];
  readonly runId: string;
  /** What the run is about, from `runSubjectKey` and nowhere else. */
  readonly subjectKey: string;
  /**
   * What the run recorded about its integrations at its start. A state is
   * created on the connection the run pinned or not at all: one made on a
   * connection an admin has since reconfigured would be the run's for the rest
   * of it, on an engine the run never started with. Absent on a call recorded
   * before this field existed, which then compares nothing, as it did.
   */
  readonly integrationPins?: readonly IntegrationConnectionPin[];
}

/**
 * What the run records about one integration's state. The five answers are
 * kept apart because each means something different for the rest of the run:
 *
 * - `ready`: the provider made the state; every later use reads it.
 * - `none`: this build's integration declares no run state. A fact of the
 *   build, the same on every replay of it, and nothing was asked of anyone.
 * - `unavailable`: the integration declares run state and is not usable on
 *   this deployment right now, or its connection moved since the run pinned
 *   it. A fact of the moment, with the cause an admin can act on, so it is not
 *   remembered and whatever reports it names that cause rather than blaming
 *   the provider for creating nothing.
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
  | {
      readonly status: "unavailable";
      readonly reason: IntegrationUnavailableReason;
      readonly message: string;
    }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "unreadable"; readonly reason: string };

export async function createIntegrationRunStatesStep(
  input: IntegrationRunStatesInput,
): Promise<Record<string, IntegrationRunStateOutcome>> {
  "use step";
  // The call happens whatever the build ships, so an empty list is ordinary
  // rather than a mistake: it is what a deployment with no tracing integration
  // asks for before every sandbox.
  if (input.integrationIds.length === 0) return {};

  const { integrationManifest } = await import("@integrations/registry");
  const { checkIntegrationPin, resolveUsableIntegrations } = await import(
    "../../services/integrations/runtime.js"
  );
  const { recordedPinFor } = await import("../support/recorded-pins.js");
  const { logger } = await import("../../infra/logger.js");
  const { isRunControlError } = await import("../helpers/run-control-error.js");

  const created = await Promise.all(
    input.integrationIds.map(async (integrationId) => {
      const manifest = integrationManifest(integrationId);
      // A declaration is a fact about the build, so an integration that
      // declares no state costs the run no connection read at all.
      if (manifest?.runState !== true) {
        return [integrationId, { status: "none" } as IntegrationRunStateOutcome] as const;
      }

      const resolved = await resolveUsableIntegrations({
        // Its own bound, so a provider that hangs spends its own minute and
        // nobody else's.
        lifetime: AbortSignal.timeout(RUN_STATE_TIMEOUT_MS),
        filter: (candidate) => candidate.id === integrationId,
      });
      if (!resolved.readable) {
        logger.warn(
          { integration: integrationId, reason: resolved.reason },
          "integration_run_state_settings_unreadable",
        );
        return [
          integrationId,
          { status: "unreadable", reason: resolved.reason } as IntegrationRunStateOutcome,
        ] as const;
      }

      const [usable] = resolved.usable;
      if (!usable) {
        // Not "nothing was created": an admin disabled it, disconnected it or
        // its values stopped being readable, and that is what the run says.
        const state = resolved.states.get(integrationId);
        const disabled = state?.enabled === false;
        const reason: IntegrationUnavailableReason = disabled ? "disabled" : "disconnected";
        return [
          integrationId,
          {
            status: "unavailable",
            reason,
            message: `${manifest.name} is ${disabled ? "disabled" : "not connected"} on this deployment.`,
          } as IntegrationRunStateOutcome,
        ] as const;
      }
      // The integration itself is what is used, whichever capability or block
      // led here, so a provider the run holds no pin for is used as it is now
      // (`recorded-pins.ts`).
      const recorded = recordedPinFor(input.integrationPins, integrationId, "every_provider");
      const current = resolved.states.get(integrationId);
      if (recorded.kind === "pinned" && current) {
        const check = checkIntegrationPin(recorded.pin, current);
        if (!check.ok) {
          return [
            integrationId,
            {
              status: "unavailable",
              reason: check.reason,
              message: `${manifest.name} was ${check.reason} after this run started, so nothing was asked of it for this run.`,
            } as IntegrationRunStateOutcome,
          ] as const;
        }
      }
      if (typeof usable.runtime.beginRun !== "function") {
        // Conformance refuses this, so it means a build assembled from
        // mismatched commits rather than a mistake anyone can see in a diff.
        logger.warn({ integration: integrationId }, "integration_run_state_not_implemented");
        return [
          integrationId,
          {
            status: "failed",
            reason: "The integration declares run state but cannot create it.",
          } as IntegrationRunStateOutcome,
        ] as const;
      }

      try {
        const begin = usable.runtime.beginRun as (
          start: { runId: string; subjectKey: string },
          context: typeof usable.ctx,
        ) => Promise<IntegrationRunState | null>;
        const state = await begin(
          { runId: input.runId, subjectKey: input.subjectKey },
          usable.ctx,
        );
        if (state === null) {
          return [
            integrationId,
            {
              status: "failed",
              reason: "The integration created no state for this run.",
            } as IntegrationRunStateOutcome,
          ] as const;
        }
        return [integrationId, { status: "ready", state } as IntegrationRunStateOutcome] as const;
      } catch (error) {
        if (isRunControlError(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          {
            integration: integrationId,
            err: reason,
            runId: input.runId,
            subjectKey: input.subjectKey,
          },
          "integration_run_state_failed",
        );
        return [
          integrationId,
          { status: "failed", reason } as IntegrationRunStateOutcome,
        ] as const;
      }
    }),
  );
  return Object.fromEntries(created);
}
createIntegrationRunStatesStep.maxRetries = 0;
