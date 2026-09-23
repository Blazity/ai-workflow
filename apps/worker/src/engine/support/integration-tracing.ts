/**
 * What every connected tracing integration wants done to one agent sandbox.
 *
 * Called inside the steps that provision or restore a sandbox, because it
 * resolves connections and a connection carries secrets: the answer holds a
 * provider's key, so it is built where the sandbox is configured and never
 * passed through a step's recorded inputs.
 *
 * The run's states arrive from the caller, in `AgentTracingRun`, rather than
 * being read here: they are created once per integration per run by a step of
 * their own, and re-deriving them would be the second bucket this design
 * exists to prevent.
 *
 * TRACING FOLLOWS ITS PIN, AND NEVER GATES A RUN. A run records the connection
 * of every tracer it reaches at its start (`integrationsUsedBy` counts agent
 * sandboxes and workspaces as reaching `agent_tracing`), and each sandbox
 * compares it here, as every other capability compares its own (plan decision
 * 9): a tracer reconfigured since the run started is not asked to trace this
 * sandbox, because its state for the run was made on the old connection and
 * the rest of the run would land on the new one. What that costs the run is
 * its tracing and nothing else. Tracing enriches a run rather than serving
 * it, the way memory does (plan decision 12 names memory as the exception
 * that goes on without its provider), and a disabled or disconnected tracer
 * has always meant an untraced run rather than a failed one; a reconfigured
 * one stopping the run while a disabled one does not would be backwards. So
 * the run goes on, and the log line for the sandbox names the tracer and why.
 */
import type { IntegrationRunState } from "@integrations/sdk";
import type { IntegrationConnectionPin } from "@shared/contracts";
import type { AgentTracingPlan } from "../../sandbox/agents/types.js";
import { recordedPinFor } from "./recorded-pins.js";

/** Bounded per sandbox; a provider assembling a setup does no I/O. */
const TRACING_RESOLVE_TIMEOUT_MS = 30_000;

/**
 * What a sandbox-configuring step is handed about the run, for its tracers.
 * Built in workflow scope by `agentTracingRun` and passed as one argument, so
 * adding to it later changes no step's positional arguments.
 */
export interface AgentTracingRun {
  readonly runId: string;
  /** From `runSubjectKey`, the one name integrations are given for the run. */
  readonly subjectKey: string;
  /** Each tracing provider that declares run state: its state, or null. */
  readonly states: Readonly<Record<string, IntegrationRunState | null>>;
  /** The node and attempt this sandbox serves, when it serves one. */
  readonly invocation?: { readonly nodeId: string; readonly attempt: number };
  /**
   * What the run recorded about its integrations at its start. Absent on a
   * run that recorded none, and on a sandbox configured from a step input
   * recorded before this field existed: nothing is compared then, as before.
   */
  readonly integrationPins?: readonly IntegrationConnectionPin[];
}

export async function agentTracingPlans(input: {
  readonly harness: string;
  readonly run: AgentTracingRun;
}): Promise<AgentTracingPlan[]> {
  const { checkIntegrationPin, resolveUsableIntegrations } = await import(
    "../../services/integrations/runtime.js"
  );
  const { logger } = await import("../../infra/logger.js");
  const { run, harness } = input;
  const where = {
    runId: run.runId,
    harness,
    ...(run.invocation ? { nodeId: run.invocation.nodeId, attempt: run.invocation.attempt } : {}),
  };

  const resolved = await resolveUsableIntegrations({
    lifetime: AbortSignal.timeout(TRACING_RESOLVE_TIMEOUT_MS),
    filter: (manifest) => manifest.capabilities.includes("agent_tracing"),
  });
  if (!resolved.readable) {
    // Not "no tracing integration": nobody could look. The sandbox goes on
    // untraced, as it would for any tracer that cannot be reached, and the
    // line says the settings were the reason rather than the deployment.
    logger.warn({ ...where, reason: "settings_unreadable" }, "agent_tracing_off");
    return [];
  }
  const integrations = resolved.usable;

  const plans: AgentTracingPlan[] = [];
  const declined: string[] = [];
  const failed: string[] = [];
  const moved: Array<{ integration: string; reason: string }> = [];
  for (const { manifest, runtime, ctx } of integrations) {
    const recorded = recordedPinFor(run.integrationPins, manifest.id, "every_provider");
    const state = resolved.states.get(manifest.id);
    if (recorded.kind === "pinned" && state) {
      const check = checkIntegrationPin(recorded.pin, state);
      if (!check.ok) {
        moved.push({ integration: manifest.id, reason: check.reason });
        continue;
      }
    }
    const factory = runtime.capabilities.agent_tracing;
    if (typeof factory !== "function") continue;
    try {
      const adapter = (factory as (context: typeof ctx) => {
        setup: (invocation: {
          harness: string;
          run: { runId: string; subjectKey: string };
          state: IntegrationRunState | null;
          invocation?: { nodeId: string; attempt: number };
        }) => AgentTracingPlan["setup"] | null;
      })(ctx);
      const setup = adapter.setup({
        harness,
        run: { runId: run.runId, subjectKey: run.subjectKey },
        state: run.states[manifest.id] ?? null,
        ...(run.invocation ? { invocation: run.invocation } : {}),
      });
      // A provider that cannot trace this sandbox says so by returning
      // nothing, and the run goes on untraced.
      if (setup) plans.push({ integrationId: manifest.id, setup });
      else declined.push(manifest.id);
    } catch (error) {
      // An integration is code core did not write, and a run is not failed
      // because one of them threw while describing a tracer.
      failed.push(manifest.id);
      logger.warn(
        { ...where, integration: manifest.id, err: error instanceof Error ? error.message : String(error) },
        "agent_tracing_setup_failed",
      );
    }
  }
  if (moved.length > 0) {
    // Said whether or not another tracer still traces this sandbox: a tracer
    // that stopped because an admin changed its connection is a thing somebody
    // did, and the only trace of it is this line.
    logger.warn({ ...where, moved }, "agent_tracing_pin_moved");
  }
  if (plans.length === 0) {
    // One line per sandbox that is not traced, and why: nothing traces on this
    // deployment, or each provider that could declined, failed or moved.
    // Without it an untraced run and a traced one look the same in the log.
    logger.info(
      {
        ...where,
        reason: integrations.length === 0 ? "no_tracing_integration" : "every_provider_declined",
        ...(declined.length > 0 ? { declined } : {}),
        ...(failed.length > 0 ? { failed } : {}),
        ...(moved.length > 0 ? { moved: moved.map((entry) => entry.integration) } : {}),
      },
      "agent_tracing_off",
    );
  }
  return plans;
}
