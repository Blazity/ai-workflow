/**
 * The block data one request works from.
 *
 * A block contract depends on the deployment (which agent, LLM, VCS and
 * messaging providers are configured, and which model runs by default), so the
 * pure definition rules cannot derive one for themselves: they take a resolver
 * and the per-type params schema map as parameters. This is where a request
 * binds both, once, and hands them down.
 *
 * Once per request matters. A request that validated a graph, then asked which
 * values it offers, then rendered the editor's block table used to read the
 * environment separately for each, so a provider coming online between two
 * reads could make one answer disagree with the next about the same definition.
 */
import type {
  VcsProviderKind,
  WorkflowBlockContract,
  WorkflowBlockContractResolver,
  WorkflowBlockType,
} from "@shared/contracts";
import { workflowBlockRegistryContextFromEnv } from "../../engine/definition/block-contract-environment.js";
import {
  buildWorkflowBlockRegistry,
  createWorkflowBlockContractResolver,
} from "../../engine/definition/block-contract-resolver.js";
import {
  BLOCK_PARAMS_SCHEMAS,
  type BlockParamsSchemas,
} from "../../engine/definition/block-params-schemas.js";

export interface RequestBlockContracts {
  /** One block's contract, from its type and its own authored params. */
  resolveContract: WorkflowBlockContractResolver;
  /** Every block type's parameter schema, composed in `engine/definition`. */
  blockParamsSchemas: BlockParamsSchemas;
  /**
   * Which VCS providers this deployment has credentials for. The definition's
   * repository pin belongs to no block, so its check cannot go through the
   * resolver and takes this list instead. Stage 4 moves that check into the
   * worker's own deployment validation.
   */
  configuredVcsProviders: readonly VcsProviderKind[];
  /**
   * The per-type table the editor renders, resolved from the same environment
   * read. Built on first read only: a validation request never needs it, and
   * resolving forty contracts for one is work nobody asked for.
   */
  blockRegistry(): Record<WorkflowBlockType, WorkflowBlockContract>;
}

export function currentBlockContracts(): RequestBlockContracts {
  const context = workflowBlockRegistryContextFromEnv();
  let registry: Record<WorkflowBlockType, WorkflowBlockContract> | null = null;
  return {
    resolveContract: createWorkflowBlockContractResolver(context),
    blockParamsSchemas: BLOCK_PARAMS_SCHEMAS,
    configuredVcsProviders: context.vcsProviders,
    blockRegistry: () => (registry ??= buildWorkflowBlockRegistry(context)),
  };
}
