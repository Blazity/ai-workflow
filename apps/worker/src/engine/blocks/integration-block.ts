/**
 * The executor every integration block runs through.
 *
 * `BLOCK_EXECUTORS` is generated from core's own block directories and is keyed
 * by block type, so it can hold neither a per-integration entry nor a name core
 * is not allowed to write. The dispatch in `agent-workflow.ts` therefore asks
 * the generated table first and this one second, and this one is a single
 * function for every integration block there will ever be.
 */
import { integrationBlock } from "@integrations/registry";
import type { IntegrationBlockManifest } from "@integrations/sdk";
import {
  BLOCK_TYPE_SPECS,
  describeSubjectDefault,
  integrationUnavailableFailureCode,
  subjectDefaultText,
} from "@shared/contracts";
import type { BlockOutput, IntegrationConnectionPin } from "@shared/contracts";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "./support/types.js";
import { isRunControlError } from "../helpers/run-control-error.js";

/**
 * Whether this executor, rather than core's generated table, owns the block.
 *
 * Every type core does not own, not only the ones an integration in this build
 * contributes. A definition deployed while an integration existed keeps its
 * nodes after the build stops shipping it, and asking the registry here would
 * answer "no" for exactly that case: the dispatch would fall through to the
 * engine's exhaustiveness default and throw "has no executor registered", which
 * names no integration and tells the person nothing.
 */
export function isIntegrationBlockType(type: string): boolean {
  return !Object.prototype.hasOwnProperty.call(BLOCK_TYPE_SPECS, type);
}

export const executeIntegrationBlock: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
  execution,
): Promise<BlockExecutionResult> => {
  const entry = integrationBlock(block.type);
  if (!entry) {
    // A node whose integration this build no longer ships. Publish refuses the
    // same graph with the same sentence; a run deployed against the old build
    // arrives here instead, and gets it rather than an internal error.
    return executionError(
      `No integration in this build provides the block "${block.type}". Connect the integration that added it, or remove the node.`,
      { category: "configuration" },
    );
  }

  const { runIntegrationBlockStep } = await import("../steps/integration-block-step.js");
  const { integrationRunState, runSubjectKey, stateOf } = await import(
    "../support/integration-run-state.js"
  );
  const inputs = withSubjectDefaults(entry.block, resolvedInputs, ctx.ticket);
  if (!inputs.ok) {
    return executionError(inputs.message, { category: "configuration", message: inputs.message });
  }
  const pin = pinFor(ctx.integrationPins, entry.integrationId);
  const llm = ctx.integrationLlmDefaults;
  if (!llm) {
    // Set beside the run's harness defaults when the context is built, so this
    // is the engine failing to hand the block what it promised rather than
    // anything an admin can fix.
    return executionError(
      `${block.type} could not run: this run resolved no model for an integration block.`,
      { category: "engine" },
    );
  }
  // Created at the run's first use of this integration, whether that use is
  // this block or a sandbox it traces, and never for any other integration.
  const runState = await integrationRunState(ctx, entry.integrationId);
  if (runState.status === "unreadable") {
    // Nothing was asked of the integration, so it is not the one to blame, and
    // nothing was remembered, so a retry of the run asks again.
    const message = `${entry.block.ui.label} could not start: this run could not read the deployment's integration settings (${runState.reason}). Nothing was asked of the integration; retry the run.`;
    return executionError(message, { category: "engine", message });
  }
  if (runState.status === "unavailable") {
    // The integration moved under the run, and the cause is what an admin acts
    // on. Never "the provider created no state": nobody asked it for one.
    const message = `${entry.block.ui.label} could not start: ${runState.message}`;
    return executionError(message, {
      category: "configuration",
      message,
      failureCode: integrationUnavailableFailureCode(runState.reason),
    });
  }
  try {
    const result = await runIntegrationBlockStep({
      integrationId: entry.integrationId,
      blockType: block.type,
      pin,
      configuration: block.params,
      inputs: inputs.values,
      run: {
        runId: ctx.runId,
        nodeId: block.id,
        attempt: execution?.attempt ?? 1,
        subjectKey: runSubjectKey(ctx),
        state: stateOf(runState),
      },
      llm,
    });
    if (result.kind === "next") {
      return {
        kind: "next",
        output: result.output as BlockOutput,
        ...(result.port === undefined ? {} : { port: result.port }),
      };
    }
    if (result.kind === "unavailable") {
      // `configuration` rather than `provider`: no retry and no provider can
      // change this, and the person who can is an admin editing a connection.
      // The code rides along because `configuration` is far too coarse to act
      // on, and the sentence beside it is copy we will keep rewriting.
      return executionError(result.message, {
        category: "configuration",
        message: result.message,
        failureCode: integrationUnavailableFailureCode(result.reason),
      });
    }
    if (result.kind === "failed") {
      return executionError(result.detail ?? result.message, {
        category: "provider",
        message: result.message,
      });
    }
    return executionError(result.message, { category: "provider" });
  } catch (error) {
    if (isRunControlError(error)) throw error;
    return executionError(error instanceof Error ? error.message : String(error), {
      category: "provider",
    });
  }
};

/**
 * The block's inputs with every unbound one that names a default filled from
 * the run's subject, or the reason it cannot be.
 *
 * Bound means present in `resolvedInputs`, even when the binding resolved to
 * nothing: an author who bound a value chose that value, and a default quietly
 * standing in for it would screen, or send, something they did not pick. An
 * unbound input is refused here, rather than filled, in the two cases where
 * the text would not be what the author was promised: the subject holds none
 * of the named fields, and the subject's text is a snapshot core composed for
 * a run with no ticket. The second is the one that matters for a screen:
 * screening our own sentence finds nothing every time, and a verdict of "ok"
 * on text nobody sent is worse than no screen at all, because the graph's
 * author believes it looked.
 */
function withSubjectDefaults(
  block: IntegrationBlockManifest,
  resolvedInputs: Readonly<Record<string, unknown>>,
  ticket:
    | (Parameters<typeof subjectDefaultText>[1] & { subjectTextIsPlaceholder?: true })
    | null
    | undefined,
): { ok: true; values: Record<string, unknown> } | { ok: false; message: string } {
  const values: Record<string, unknown> = { ...resolvedInputs };
  for (const [name, input] of Object.entries(block.inputs ?? {})) {
    const fields = input.defaultFromSubject;
    if (!fields || fields.length === 0) continue;
    if (Object.prototype.hasOwnProperty.call(resolvedInputs, name)) continue;
    if (ticket?.subjectTextIsPlaceholder) {
      return {
        ok: false,
        message: `${block.ui.label} reads "${name}" from ${describeSubjectDefault(fields)} when nothing is bound, and this run carries no text a person wrote: it has no ticket, so core composed the description it would have read. Bind "${name}" to the text it should use.`,
      };
    }
    const text = ticket ? subjectDefaultText(fields, ticket) : "";
    if (text.length === 0) {
      return {
        ok: false,
        message: `${block.ui.label} reads "${name}" from ${describeSubjectDefault(fields)} when nothing is bound, and this run's subject has none of them. Bind "${name}" to the text it should use.`,
      };
    }
    values[name] = text;
  }
  return { ok: true, values };
}

function pinFor(
  pins: readonly IntegrationConnectionPin[] | undefined,
  integrationId: string,
): IntegrationConnectionPin | null {
  return pins?.find((pin) => pin.integrationId === integrationId) ?? null;
}
