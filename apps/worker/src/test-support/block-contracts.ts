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
  WorkflowDefinition,
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import {
  createWorkflowBlockContractResolver,
  type WorkflowBlockRegistryContext,
} from "../engine/definition/block-contract-resolver.js";
import {
  BLOCK_PARAMS_SCHEMAS,
  type BlockParamsSchemas,
} from "../engine/definition/block-params-schemas.js";
import {
  createWorkflowValueAnalyzer,
  type WorkflowValueAnalyzer,
} from "@shared/workflow-graph";
import { JSON_SCHEMA_SUPPORT } from "../engine/definition/json-schema-support.js";
import { validateWorkflowDefinitionIssuesForDeployment } from "../engine/definition/deployment-validation.js";

export function testBlockContractResolver(
  context: WorkflowBlockRegistryContext,
): WorkflowBlockContractResolver {
  return createWorkflowBlockContractResolver(context);
}

/**
 * The block data a candidate validation takes, ready to spread:
 * `validateWorkflowDefinitionCandidate(candidate, ...testBlockData(ctx))`. The
 * params schema map is the real one, because a test that validated against a
 * fabricated map would prove nothing about what deploys.
 */
export function testBlockData(
  context: WorkflowBlockRegistryContext,
): readonly [
  WorkflowBlockContractResolver,
  BlockParamsSchemas,
  readonly VcsProviderKind[],
  WorkflowValueAnalyzer,
] {
  const resolveContract = testBlockContractResolver(context);
  return [
    resolveContract,
    BLOCK_PARAMS_SCHEMAS,
    context.vcsProviders,
    createWorkflowValueAnalyzer(resolveContract, JSON_SCHEMA_SUPPORT),
  ];
}

/**
 * Deployment issues for one graph.
 *
 * `validateWorkflowDefinitionIssuesForDeployment` takes the request's
 * available-values pass, because a request reads that pass again afterwards. A
 * test has one graph and no request, so it makes the pass here and spreads the
 * block data as before: `testDeploymentIssues(def, ...testBlockData(ctx))`.
 */
export function testDeploymentIssues(
  definition: WorkflowDefinition,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: BlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
  analyzeValues: WorkflowValueAnalyzer,
  options: { checkEnvironmentAvailability?: boolean } = {},
): WorkflowDefinitionValidationIssue[] {
  return validateWorkflowDefinitionIssuesForDeployment(
    definition,
    resolveContract,
    blockParamsSchemas,
    configuredVcsProviders,
    analyzeValues(definition),
    options,
  );
}
