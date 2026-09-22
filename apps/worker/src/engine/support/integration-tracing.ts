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
 */
import type { IntegrationRunState } from "@integrations/sdk";
import type { AgentTracingPlan } from "../../sandbox/agents/types.js";

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
}

export async function agentTracingPlans(input: {
  readonly harness: string;
  readonly run: AgentTracingRun;
}): Promise<AgentTracingPlan[]> {
  const { usableIntegrations } = await import("../../services/integrations/runtime.js");
  const { logger } = await import("../../infra/logger.js");
  const { run, harness } = input;
  const where = {
    runId: run.runId,
    harness,
    ...(run.invocation ? { nodeId: run.invocation.nodeId, attempt: run.invocation.attempt } : {}),
  };

  const integrations = await usableIntegrations({
    lifetime: AbortSignal.timeout(TRACING_RESOLVE_TIMEOUT_MS),
    filter: (manifest) => manifest.capabilities.includes("agent_tracing"),
  });

  const plans: AgentTracingPlan[] = [];
  const declined: string[] = [];
  const failed: string[] = [];
  for (const { manifest, runtime, ctx } of integrations) {
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
  if (plans.length === 0) {
    // One line per sandbox that is not traced, and why: nothing traces on this
    // deployment, or each provider that could declined or failed. Without it an
    // untraced run and a traced one look the same in the log.
    logger.info(
      {
        ...where,
        reason: integrations.length === 0 ? "no_tracing_integration" : "every_provider_declined",
        ...(declined.length > 0 ? { declined } : {}),
        ...(failed.length > 0 ? { failed } : {}),
      },
      "agent_tracing_off",
    );
  }
  return plans;
}
