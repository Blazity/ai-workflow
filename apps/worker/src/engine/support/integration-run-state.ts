/**
 * The run's integration state, asked for once per integration and shared by
 * everything in the run that uses that integration.
 *
 * This runs in workflow scope, so it holds no I/O of its own: the creation is
 * a step, and this is the cache that keeps the workflow from calling it twice.
 * On a replay the cache is empty again and each step returns what it recorded,
 * so both halves of "once per run" are the Workflow DevKit's rather than ours.
 *
 * A use is a block of the integration, or an agent sandbox traced by an
 * integration that provides `agent_tracing`. Each is a use of that one
 * integration only: running one integration's block never creates another's
 * state, whichever of them declares it.
 */
import { integrationManifest, integrationsProviding } from "@integrations/registry";
import type { IntegrationRunState } from "@integrations/sdk";
import type { EngineCtx } from "../blocks/support/types.js";
import type { IntegrationRunStateOutcome } from "../steps/integration-run-state-step.js";
import type { AgentTracingRun } from "./integration-tracing.js";

/**
 * What the run is about, as an integration names it: the ticket key for a
 * ticket run (`AWT-42`), and the identifier core gave the run's ticket-shaped
 * snapshot otherwise. The one place any integration code is told the run's
 * name, so a block and a tracer in the same run can never name it differently.
 */
export function runSubjectKey(ctx: Pick<EngineCtx, "ticket">): string {
  return ctx.ticket.identifier;
}

/** This integration's state for the run, created by the run's first use of it. */
export async function integrationRunState(
  ctx: EngineCtx,
  integrationId: string,
): Promise<IntegrationRunStateOutcome> {
  // A declaration is a fact about the build, the same on every replay of it,
  // so an integration that declares no state costs the run no step at all.
  if (integrationManifest(integrationId)?.runState !== true) return { status: "none" };
  const cached = ctx.integrationRunStates?.[integrationId];
  if (cached) return cached;

  const { createIntegrationRunStateStep } = await import(
    "../steps/integration-run-state-step.js"
  );
  const outcome = await createIntegrationRunStateStep({
    integrationId,
    runId: ctx.runId,
    subjectKey: runSubjectKey(ctx),
  });
  // Settings that could not be read are a moment, not an answer: the next use
  // asks again rather than carrying the refusal through the rest of the run.
  if (outcome.status !== "unreadable") {
    ctx.integrationRunStates = { ...ctx.integrationRunStates, [integrationId]: outcome };
  }
  return outcome;
}

/** The state an integration's own code is handed: the value, or nothing. */
export function stateOf(outcome: IntegrationRunStateOutcome): IntegrationRunState | null {
  return outcome.status === "ready" ? outcome.state : null;
}

/**
 * Everything a tracing provider is told about the sandbox core is about to
 * configure, with the state of every provider that declares one. Resolved here,
 * before the step that configures the sandbox, because creating state is a
 * step of its own and a step cannot start another.
 */
export async function agentTracingRun(
  ctx: EngineCtx,
  invocation?: { readonly nodeId: string; readonly attempt: number },
): Promise<AgentTracingRun> {
  const states: Record<string, IntegrationRunState | null> = {};
  for (const manifest of integrationsProviding("agent_tracing")) {
    if (manifest.runState !== true) continue;
    states[manifest.id] = stateOf(await integrationRunState(ctx, manifest.id));
  }
  return {
    runId: ctx.runId,
    subjectKey: runSubjectKey(ctx),
    states,
    ...(invocation ? { invocation } : {}),
  };
}
