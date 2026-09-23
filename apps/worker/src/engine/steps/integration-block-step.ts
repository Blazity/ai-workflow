/**
 * The one step that runs any integration's block.
 *
 * Core owns exactly one step for every integration block there will ever be.
 * That is what keeps integration packages free of `"use step"`: a step's
 * identity is its module path plus its function name, so a directive inside an
 * integration would strand every suspended run the day that integration moved
 * or was renamed. Here, moving an integration changes nothing a run is
 * suspended in.
 *
 * It sets no retries, the way core's own side-effecting steps do. A block that
 * posted a comment and then threw must not post it twice; retrying a transient
 * failure is the integration's own business through `ctx.http`.
 *
 * Everything this step reads about the deployment is read INSIDE the step, so
 * the Workflow DevKit records the answer and a replay reproduces it rather than
 * asking a database that has moved on.
 */
import type {
  IntegrationBlockExecutor,
  IntegrationBlockManifest,
  IntegrationManifest,
} from "@integrations/sdk";
import type { IntegrationRunState } from "@integrations/sdk";
import type { IntegrationConnectionPin, IntegrationUnavailableReason } from "@shared/contracts";

/** Comfortably under the 300 s a plain function is killed at. */
const INTEGRATION_BLOCK_TIMEOUT_MS = 240_000;

export interface IntegrationBlockStepInput {
  readonly integrationId: string;
  readonly blockType: string;
  /** What the run recorded at its start. Absent for a run that started before
   *  integrations existed, which then runs with no pin to compare. */
  readonly pin: IntegrationConnectionPin | null;
  readonly configuration: Record<string, unknown>;
  readonly inputs: Record<string, unknown>;
  readonly run: {
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
    /** What the run is about, from `runSubjectKey` and nowhere else. */
    readonly subjectKey: string;
    /**
     * This integration's per-run state, created at the run's first use of it
     * (see `integration-run-state-step.ts`). Null when the integration
     * declares none, and when creating it failed: a block that cannot work
     * without the handle refuses rather than reporting a result nothing
     * produced, which is what makes the injection check fail closed.
     */
    readonly state: IntegrationRunState | null;
  };
  /**
   * The run's preferred provider and model for `ctx.llm`, and its model for
   * each provider. Which one a block gets is `integrationLlmTarget`'s answer
   * over this deployment's keys, asked here, where the keys are read.
   * `models` is absent on a call recorded before it existed, which then falls
   * back only to its own preference.
   */
  readonly llm: {
    readonly provider: "claude" | "codex";
    readonly model: string;
    readonly models?: { readonly claude: string; readonly codex: string };
  };
}

export type IntegrationBlockStepResult =
  | { readonly kind: "next"; readonly output: Record<string, unknown>; readonly port?: string }
  /** The block reported an expected failure. `message` is what a person reads. */
  | { readonly kind: "failed"; readonly message: string; readonly detail?: string }
  /** The integration moved under the run. One of S2's three reasons. */
  | {
      readonly kind: "unavailable";
      readonly reason: IntegrationUnavailableReason;
      readonly message: string;
    }
  /**
   * This deployment's integration settings could not be read, so nothing was
   * asked of the integration. Kept apart from `error` because the two send a
   * person to different places: this one is ours and a retry is the fix, and
   * reporting it as the block's own failure blamed the provider for a
   * database that did not answer.
   */
  | { readonly kind: "unreadable"; readonly reason: string }
  /**
   * The block needs a model and this deployment has no key a direct model
   * call accepts. Ours to configure, not the integration's failure.
   */
  | { readonly kind: "llm_unconfigured"; readonly message: string }
  /** The block threw, or core could not reach its connection values. */
  | { readonly kind: "error"; readonly message: string };

export async function runIntegrationBlockStep(
  input: IntegrationBlockStepInput,
): Promise<IntegrationBlockStepResult> {
  "use step";
  const { integrationManifest, integrationManifests } = await import("@integrations/registry");
  const { integrationRuntime } = await import("@integrations/registry/worker");
  const { resolveUsableIntegrations } = await import("../../services/integrations/runtime.js");
  const { deploymentIntegrations } = await import("../definition/integration-availability.js");
  const { checkRunIntegrationUse } = await import("../definition/integration-run.js");
  const { integrationCapabilityAccess, integrationLlm } = await import(
    "../support/integration-capabilities.js"
  );
  const { isRunControlError } = await import("../helpers/run-control-error.js");

  const manifest = integrationManifest(input.integrationId);
  const runtime = integrationRuntime(input.integrationId);
  const block = manifest?.blocks.find((candidate) => candidate.type === input.blockType);
  if (!manifest || !runtime || !block) {
    return {
      kind: "unavailable",
      reason: "disconnected",
      message: `This deployment no longer ships the integration "${input.integrationId}", so the run stopped at its next use of it.`,
    };
  }

  // The live state, every time. Disabling is the kill switch an admin reaches
  // for, so it is read at the use rather than trusted from the run's start.
  // One read for the states and the values behind them, through the one
  // reader, which keeps "could not read" apart from "not connected". The
  // context it builds lives as long as the block may run: the block is
  // single-shot work with a real deadline, which is exactly what a lifetime is
  // for (a block runs inside one invocation, and an invocation is killed rather
  // than failed when it runs out of time, so the bound sits below the plain
  // function's 300 s and a block that hangs reports a failure a person can
  // read).
  const resolved = await resolveUsableIntegrations({
    lifetime: AbortSignal.timeout(INTEGRATION_BLOCK_TIMEOUT_MS),
    filter: (candidate) => candidate.id === input.integrationId,
  });
  if (!resolved.readable) {
    // The database's own words stay in the log; what a person reads says what
    // happened and what to do (`settingsUnreadable` in integration-block.ts).
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { integration: input.integrationId, block: input.blockType, reason: resolved.reason },
      "integration_block_settings_unreadable",
    );
    return { kind: "unreadable", reason: resolved.reason };
  }
  const states = resolved.states;
  const integrations = deploymentIntegrations({ manifests: integrationManifests, states });
  const state = states.get(input.integrationId);
  if (!state) {
    return {
      kind: "unavailable",
      reason: "disconnected",
      message: `${manifest.name} is no longer connected, so the run stopped at its next use of it.`,
    };
  }
  // A run that started before integrations existed carries no pin. It is then
  // compared against the connection in force, which can never report
  // `reconfigured` and still reports disabled and disconnected: the two an
  // admin acted on, and the two that must stop it.
  const failure = checkRunIntegrationUse(input.pin ?? state.pin, integrations);
  if (failure) {
    return { kind: "unavailable", reason: failure.reason, message: failure.message };
  }

  const usable = resolved.usable.find((candidate) => candidate.manifest.id === input.integrationId);
  if (!usable) {
    const unreadable = resolved.connectionFailures.get(input.integrationId);
    return {
      kind: "unavailable",
      reason: "disconnected",
      message: unreadable
        ? `${manifest.name} could not be read: ${unreadable.message}.`
        : `${manifest.name} is no longer connected, so the run stopped at its next use of it.`,
    };
  }

  const parsed = block.paramsSchema.safeParse(input.configuration);
  if (!parsed.success) {
    return {
      kind: "error",
      message: `${block.ui.label} was configured in a way this build cannot read: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }

  // Long or multi-phase work stays in core and is reached through a
  // capability, which is why one bound covers every integration block.
  // Providers echo credentials in error bodies, and that body is what a person
  // reads on the run and in the ticket comment, so the block's outcome and
  // what it throws are redacted with this connection's secrets.
  const redact = usable.redaction.text;
  const context = usable.ctx;
  const executor = runtime.blocks[input.blockType];
  if (!executor) {
    return {
      kind: "error",
      message: `${manifest.name} declares the block "${input.blockType}" and ships no code for it.`,
    };
  }

  let llmTarget: { provider: "claude" | "codex"; model: string } | null = null;
  if (block.requires?.llm === true) {
    const { integrationLlmTarget, integrationLlmUnavailable } = await import(
      "../definition/integration-llm.js"
    );
    const { directLlmCredentials } = await import("../definition/block-contract-environment.js");
    const preferred = { provider: input.llm.provider, model: input.llm.model };
    llmTarget = integrationLlmTarget(
      preferred,
      input.llm.models ?? { claude: preferred.model, codex: preferred.model },
      directLlmCredentials(),
    );
    if (!llmTarget) {
      return { kind: "llm_unconfigured", message: integrationLlmUnavailable(block.ui.label) };
    }
  }

  const invoke = executor as unknown as IntegrationBlockExecutor<
    IntegrationManifest,
    IntegrationBlockManifest
  >;
  try {
    const outcome = await invoke(
      { params: parsed.data, inputs: input.inputs as never },
      {
        ...context,
        run: input.run,
        capabilities: await integrationCapabilityAccess(block.requires?.capabilities ?? []),
        ...(llmTarget ? { llm: integrationLlm(llmTarget) } : {}),
      } as never,
    );
    if (outcome.kind === "next") {
      // One port, so the block's choice of branch is its `status` output. See
      // ADR-010 on why the graph cannot read a manifest's ports yet.
      return { kind: "next", output: outcome.output as Record<string, unknown> };
    }
    if (outcome.kind === "failed") {
      return {
        kind: "failed",
        message: redact(outcome.message),
        ...(outcome.detail === undefined ? {} : { detail: redact(outcome.detail) }),
      };
    }
    // An outcome the contract does not describe. Reported rather than treated
    // as a success, because continuing on a value core cannot read is how a
    // green run comes to carry nothing downstream.
    return {
      kind: "error",
      message: `${block.ui.label} returned an outcome this build does not understand.`,
    };
  } catch (error) {
    // A cancelled run and an exhausted budget are core's own signals, and
    // ADR-010 requires them to be re-raised rather than dressed up as a
    // provider failure: an executor that catches everything must not be able
    // to turn a cancellation into an ordinary outcome.
    if (isRunControlError(error)) throw error;
    return { kind: "error", message: redact(describeBlockFailure(error, block.ui.label)) };
  }
}
runIntegrationBlockStep.maxRetries = 0;

/**
 * What a person reads when a block throws.
 *
 * A bare abort says "The operation was aborted due to timeout" and names
 * neither the block, nor how long it had, nor that a bound exists at all, which
 * leaves the author of the workflow with nothing to change.
 */
function describeBlockFailure(error: unknown, label: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut =
    (error instanceof Error && error.name === "TimeoutError") ||
    message.toLowerCase().includes("aborted due to timeout");
  return timedOut
    ? `${label} did not finish within ${Math.round(INTEGRATION_BLOCK_TIMEOUT_MS / 1000)} seconds and was stopped.`
    : `${label} failed: ${message}`;
}
