/**
 * The test adapter for block data.
 *
 * Production binds a block contract resolver to the environment
 * (`engine/definition/block-contract-resolver.ts`); a test binds one to a
 * deployment it declares, so what a definition is allowed to do is a fixture
 * rather than whatever the machine running the suite happens to have
 * configured.
 */
import type {
  VcsProviderKind,
  WorkflowBlockContractResolver,
} from "@shared/contracts";
import {
  createWorkflowBlockContractResolver,
  type WorkflowBlockRegistryContext,
} from "../engine/definition/block-contract-resolver.js";
import {
  BLOCK_PARAMS_SCHEMAS,
  type BlockParamsSchemas,
} from "../engine/definition/block-params-schemas.js";

export function testBlockContractResolver(
  context: WorkflowBlockRegistryContext,
): WorkflowBlockContractResolver {
  return createWorkflowBlockContractResolver(context);
}

/**
 * The block data every deployment-validation entry takes, ready to spread:
 * `validateWorkflowDefinitionIssuesForDeployment(def, ...testBlockData(ctx))`.
 * The params schema map is the real one, because a test that validated against
 * a fabricated map would prove nothing about what deploys.
 */
export function testBlockData(
  context: WorkflowBlockRegistryContext,
): readonly [
  WorkflowBlockContractResolver,
  BlockParamsSchemas,
  readonly VcsProviderKind[],
] {
  return [
    testBlockContractResolver(context),
    BLOCK_PARAMS_SCHEMAS,
    context.vcsProviders,
  ];
}
