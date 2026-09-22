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
  HarnessProfileManifest,
  HarnessProfileReference,
  IntegrationState,
  VcsProviderKind,
  WorkflowBlockContract,
  WorkflowBlockContractResolver,
  WorkflowBlockType,
  WorkflowDefinition,
} from "@shared/contracts";
import { isHarnessProfileReference } from "@shared/contracts";
import { resolveBuiltinHarnessProfile } from "@shared/harness";
import { integrationManifests } from "@integrations/registry";
import {
  builtinCapabilitiesOfDeployment,
  workflowBlockRegistryContext,
} from "../../engine/definition/block-contract-environment.js";
import {
  deploymentIntegrations,
  NO_INTEGRATIONS,
  type DeploymentIntegrations,
} from "../../engine/definition/integration-availability.js";
import { readIntegrationStates } from "../integrations/index.js";
import type { Db } from "../../db/types.js";
import {
  dashboardOrganizationId,
} from "../../engine/definition/harness-profile-runtime.js";
import type {
  ResolvedHarnessProfileForDeployment,
  ResolvedHarnessProfilesForDeployment,
} from "../../engine/definition/deployment-validation.js";
import { resolveVerifiedHarnessProfileVersion } from "../../harness-profiles/resolved-version.js";
import {
  buildWorkflowBlockRegistry,
  createWorkflowBlockContractResolver,
} from "../../engine/definition/block-contract-resolver.js";
import {
  blockParamsSchemasFor,
  type BlockParamsSchemas,
} from "../../engine/definition/block-params-schemas.js";
import {
  createWorkflowValueAnalyzer,
  type WorkflowValueAnalyzer,
} from "@shared/workflow-graph";
import { JSON_SCHEMA_SUPPORT } from "../../engine/definition/json-schema-support.js";

export interface RequestBlockContracts {
  /** One block's contract, from its type and its own authored params. */
  resolveContract: WorkflowBlockContractResolver;
  /**
   * The available-values analysis of one definition: the graph walk, the
   * per-node contracts and the offered value catalog.
   *
   * It memoizes nothing. A request stays at one pass by keeping the
   * `WorkflowValueAnalysis` it got and handing it to the next reader (draft
   * validation, the data catalog, prompt authoring), which is also why a graph
   * edited mid request is never answered from an earlier pass.
   */
  analyzeValues: WorkflowValueAnalyzer;
  /** Every block type's parameter schema, composed in `engine/definition`. */
  blockParamsSchemas: BlockParamsSchemas;
  /**
   * Which VCS providers this deployment has credentials for. The definition's
   * repository pin belongs to no block, so its check cannot go through the
   * resolver and takes this list instead. Stage 4 moves that check into the
   * worker's own deployment validation.
   */
  configuredVcsProviders: readonly VcsProviderKind[];
  /** Exact profile parameters for the nodes a database-bound validation reads. */
  resolveHarnessProfiles?(
    definition: WorkflowDefinition,
  ): Promise<ResolvedHarnessProfilesForDeployment>;
  /**
   * The per-type table the editor renders, resolved from the same environment
   * read. Built on first read only: a validation request never needs it, and
   * resolving forty contracts for one is work nobody asked for.
   */
  blockRegistry(): Record<WorkflowBlockType, WorkflowBlockContract>;
}

/**
 * What this deployment's integrations are in a state to do, read once.
 *
 * Read here rather than anywhere a contract is resolved: the resolver stays
 * pure and one request sees one deployment. Nothing is cached between
 * requests, because disabling an integration is the kill switch an admin
 * reaches for, and on Vercel the next request lands on a warm invocation where
 * a module-level cache would keep the block running until the instance
 * recycled.
 */
/**
 * Re-exported so the layers above services can name the value they are handed.
 * The type lives in the engine, which the app tier may not import (the
 * boundaries gate), and passing it around without being able to name it is how
 * it ended up being read behind everyone's back in the first place.
 */
export type { DeploymentIntegrations };

export async function connectedDeploymentIntegrations(): Promise<DeploymentIntegrations> {
  // A build that ships no integration has nothing to read and no block to
  // decide about, so it asks the database nothing. That is every deployment
  // until the first integration lands. It is a shortcut, not the reason the
  // callers below work without a database: each of them is handed its state.
  if (integrationManifests.length === 0) return NO_INTEGRATIONS;
  return deploymentIntegrationsFrom(await readIntegrationStates());
}

/**
 * The assembly, over states somebody else read.
 *
 * Pure, and the only place manifests, states and the deployment's built-in
 * capabilities are put together. Every entry point above ends here, so
 * "what this build offers" has one answer however the state was obtained.
 */
async function deploymentIntegrationsFrom(
  states: Map<string, IntegrationState>,
): Promise<DeploymentIntegrations> {
  return deploymentIntegrations({
    manifests: integrationManifests,
    states,
    builtinCapabilities: await builtinCapabilitiesOfDeployment(),
  });
}

/** The same, for a caller holding its own database handle. Goes through the
 *  one derivation in `services/integrations`, never a second one. */
async function deploymentIntegrationsOn(db: Db): Promise<DeploymentIntegrations> {
  if (integrationManifests.length === 0) return NO_INTEGRATIONS;
  const { readIntegrationStatesOn } = await import("../integrations/index.js");
  return deploymentIntegrationsFrom(await readIntegrationStatesOn(db));
}

/**
 * The block data for a caller that knows which Harness Profile is in force.
 * Callers without one use the code-owned built-in default profile.
 *
 * `integrations` is required and has no default. It used to default to
 * `NO_INTEGRATIONS`, which reads as "this deployment has none" and is a
 * different statement from "nobody asked": the caller that forgot got a palette
 * missing every integration block and no way to notice. Deciding with no
 * integration state is still allowed, in one word - `NO_INTEGRATIONS` - and the
 * word is now at the call site where a reader can see it.
 */
export function blockContractsFor(
  profile: Pick<HarnessProfileManifest, "harness" | "model"> | undefined,
  integrations: DeploymentIntegrations,
): RequestBlockContracts {
  const context = workflowBlockRegistryContext(profile, integrations);
  const resolveContract = createWorkflowBlockContractResolver(context);
  let registry: Record<WorkflowBlockType, WorkflowBlockContract> | null = null;
  return {
    resolveContract,
    analyzeValues: createWorkflowValueAnalyzer(resolveContract, JSON_SCHEMA_SUPPORT),
    blockParamsSchemas: blockParamsSchemasFor(integrations),
    configuredVcsProviders: context.vcsProviders,
    blockRegistry: () => (registry ??= buildWorkflowBlockRegistry(context)),
  };
}

/**
 * The same block data for a process-bound caller with no run-specific profile.
 * Definition validation is synchronous after this API boundary, and every
 * such caller uses the one code-owned built-in default profile.
 */
export async function connectedBlockContracts(): Promise<RequestBlockContracts> {
  return blockContractsFor(undefined, await connectedDeploymentIntegrations());
}

/** The database-bound half also resolves each exact custom profile pin. A node
 *  without a pin is deliberately absent from the returned map, so its contract
 *  keeps the code-owned built-in default selected by the model catalog. */
export async function blockContractsOn(db: Db): Promise<RequestBlockContracts> {
  let organizationId: Promise<string> | null = null;
  const contracts = blockContractsFor(undefined, await deploymentIntegrationsOn(db));
  return {
    ...contracts,
    resolveHarnessProfiles: (definition) =>
      resolveHarnessProfilesForDefinition(
        definition,
        async ({ profileId, version }) => {
          organizationId ??= dashboardOrganizationIdOn(db);
          return (
            await resolveVerifiedHarnessProfileVersion(db, {
              organizationId: await organizationId,
              profileId,
              version,
            })
          )?.manifest ?? null;
        },
      ),
  };
}

async function dashboardOrganizationIdOn(db: Db): Promise<string> {
  const {
    dashboardOrganizationSettings,
    loadSettingsSnapshotOn,
  } = await import("../settings/index.js");
  const organization = dashboardOrganizationSettings(
    await loadSettingsSnapshotOn(db),
  );
  return dashboardOrganizationId(db, organization.slug);
}

export async function resolveHarnessProfilesForDefinition(
  definition: WorkflowDefinition,
  loadCustomProfile: (
    reference: HarnessProfileReference,
  ) => Promise<ResolvedHarnessProfileForDeployment | null>,
): Promise<ResolvedHarnessProfilesForDeployment> {
  const resolved = new Map<
    string,
    ResolvedHarnessProfileForDeployment | null
  >();
  const customProfiles = new Map<
    string,
    Promise<ResolvedHarnessProfileForDeployment | null>
  >();
  for (const node of definition.nodes) {
    const reference = node.configuration.harnessProfile;
    if (!isHarnessProfileReference(reference)) continue;
    const builtin = resolveBuiltinHarnessProfile(reference);
    if (builtin !== null) {
      resolved.set(node.id, builtin);
      continue;
    }
    const key = `${reference.profileId}:${reference.version}`;
    let pending = customProfiles.get(key);
    if (!pending) {
      pending = loadCustomProfile(reference);
      customProfiles.set(key, pending);
    }
    resolved.set(node.id, await pending);
  }
  return resolved;
}
