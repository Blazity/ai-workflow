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
import { BLOCK_TYPE_SPECS, integrationUnavailableFailureCode } from "@shared/contracts";
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
  try {
    const result = await runIntegrationBlockStep({
      integrationId: entry.integrationId,
      blockType: block.type,
      pin,
      configuration: block.params,
      inputs: resolvedInputs,
      run: {
        runId: ctx.runId,
        nodeId: block.id,
        attempt: execution?.attempt ?? 1,
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

function pinFor(
  pins: readonly IntegrationConnectionPin[] | undefined,
  integrationId: string,
): IntegrationConnectionPin | null {
  return pins?.find((pin) => pin.integrationId === integrationId) ?? null;
}
