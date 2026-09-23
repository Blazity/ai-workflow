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
 * integration that provides `agent_tracing`. Each use makes exactly one step
 * call, whatever the build ships: a block asks for its own integration and a
 * sandbox asks for every tracing provider at once, including for none. What a
 * run's step sequence depends on is its graph, never the set of integrations
 * compiled in, or shipping an integration would strand every suspended run
 * (see `steps/integration-run-state-step.ts`).
 */
import { integrationsProviding } from "@integrations/registry";
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
  const cached = ctx.integrationRunStates?.[integrationId];
  if (cached) return cached;
  return createMissing(ctx, [integrationId]).pending.get(integrationId)!;
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
  const ids = integrationsProviding("agent_tracing").map((manifest) => manifest.id);
  const pending = new Map<string, Promise<IntegrationRunStateOutcome>>();
  const missing: string[] = [];
  for (const id of ids) {
    const cached = ctx.integrationRunStates?.[id];
    if (cached) pending.set(id, cached);
    else missing.push(id);
  }
  // One call per sandbox, always: with the ids this sandbox still needs, and
  // with none when it needs none. The empty call is the price of a deployment
  // being able to gain its first tracing integration without stranding every
  // run suspended past a sandbox.
  const created = createMissing(ctx, missing);
  for (const [id, promise] of created.pending) pending.set(id, promise);
  // Awaited even when it asked for nothing, so the call sits at the same place
  // in this run's step sequence on a deployment that traces and one that does
  // not, and gaining the first tracing provider moves nothing.
  await created.call;
  const states: Record<string, IntegrationRunState | null> = {};
  for (const id of ids) states[id] = stateOf(await pending.get(id)!);
  return {
    runId: ctx.runId,
    subjectKey: runSubjectKey(ctx),
    states,
    ...(invocation ? { invocation } : {}),
    // Compared by the tracers themselves before each sandbox, because the
    // connection can move between the state's creation and this sandbox.
    ...(ctx.integrationPins ? { integrationPins: ctx.integrationPins } : {}),
  };
}

/**
 * One step call for these ids, and the per-integration promises it answers.
 *
 * The promise is cached before it settles, not after: two blocks starting in
 * the same tick would otherwise both miss a cache written after the await and
 * ask the provider twice, which for the provider this port was designed from
 * is two buckets for one run.
 */
function createMissing(
  ctx: EngineCtx,
  integrationIds: readonly string[],
): {
  readonly call: Promise<Record<string, IntegrationRunStateOutcome>>;
  readonly pending: Map<string, Promise<IntegrationRunStateOutcome>>;
} {
  const call = callStep(ctx, integrationIds);
  const pending = new Map<string, Promise<IntegrationRunStateOutcome>>();
  for (const integrationId of integrationIds) {
    const answer = call.then(
      (outcomes) => outcomes[integrationId] ?? { status: "none" as const },
    );
    remember(ctx, integrationId, answer);
    pending.set(integrationId, answer);
  }
  return { call, pending };
}

async function callStep(
  ctx: EngineCtx,
  integrationIds: readonly string[],
): Promise<Record<string, IntegrationRunStateOutcome>> {
  const { createIntegrationRunStatesStep } = await import(
    "../steps/integration-run-state-step.js"
  );
  return createIntegrationRunStatesStep({
    integrationIds: [...integrationIds],
    runId: ctx.runId,
    subjectKey: runSubjectKey(ctx),
    ...(ctx.integrationPins ? { integrationPins: ctx.integrationPins } : {}),
  });
}

function remember(
  ctx: EngineCtx,
  integrationId: string,
  pending: Promise<IntegrationRunStateOutcome>,
): void {
  ctx.integrationRunStates = { ...ctx.integrationRunStates, [integrationId]: pending };
  // Two answers are about this moment rather than about the run: settings that
  // could not be read, and an integration an admin turned off. Neither is
  // carried through the rest of the run, so the next use asks again and a
  // connection restored mid-run is used.
  void pending.then(
    (outcome) => {
      if (outcome.status === "unreadable" || outcome.status === "unavailable") {
        forget(ctx, integrationId, pending);
      }
    },
    () => forget(ctx, integrationId, pending),
  );
}

function forget(
  ctx: EngineCtx,
  integrationId: string,
  pending: Promise<IntegrationRunStateOutcome>,
): void {
  // Only this attempt: a later use may already have started its own.
  if (ctx.integrationRunStates?.[integrationId] !== pending) return;
  const { [integrationId]: _dropped, ...rest } = ctx.integrationRunStates;
  ctx.integrationRunStates = rest;
}
