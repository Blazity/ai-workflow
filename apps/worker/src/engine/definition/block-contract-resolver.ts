/**
 * The environment-aware half of the block registry.
 *
 * `block-registry.ts` owns what a block's contract is: its ports, its output
 * schema and the definition-local issues its own params can carry. What a block
 * may do here depends on the deployment (which agent, LLM, VCS and messaging
 * providers are configured, and which model runs by default), and that is this
 * module. It binds the two into a `WorkflowBlockContractResolver`, which is what
 * the pure definition rules take instead of an environment.
 *
 * Which deployment is a parameter, not a read: `block-contract-environment.ts`
 * is the only module that answers it from the process environment, so a test
 * binds a deployment it declares without loading the environment at all.
 */
import {
  BLOCK_CATALOG,
  BLOCK_TYPE_SPECS,
  type VcsProviderKind,
  type WorkflowBlockAvailability,
  type WorkflowBlockContract,
  type WorkflowBlockContractResolver,
  type WorkflowBlockType,
  type WorkflowParamValue,
} from "@shared/contracts";
import { resolveLlmProvider, type LlmProvider } from "../../infra/llm-provider.js";
import {
  blockContractDefinitions,
  catalogPresentation,
  resolvedBindingOutput,
  resolvedOutput,
  workflowBlockDefinitionIssue,
} from "./block-registry.js";
import {
  coreBlockCapabilities,
  coreCapabilityIssue,
  integrationBlockAvailability,
  type DeploymentIntegrations,
} from "./integration-availability.js";
import {
  integrationBlockContract,
  integrationBlockContracts,
} from "./integration-block-contract.js";

export interface WorkflowBlockRegistryContext {
  agentProviders: { claude: boolean; codex: boolean };
  llmProviders: { claude: boolean; codex: boolean };
  defaultAgent: { provider: "claude" | "codex"; model: string };
  vcsProviders: VcsProviderKind[];
  vcsBotIdentities: VcsProviderKind[];
  webhookTriggerConfigured: boolean;
  /**
   * What this deployment's integrations let a workflow do.
   *
   * The rules below that name a provider are the ones for providers the plan
   * has not moved out yet (ADR-010, stages S8 to S12); each of those stages
   * deletes its own. Everything an integration contributes is decided from
   * this field and the registry, so adding an integration edits no core file.
   */
  integrations: DeploymentIntegrations;
}

const vcsBlocks = new Set<WorkflowBlockType>([
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
  "prepare_workspace",
  "finalize_workspace",
  "run_pre_pr_checks",
  "run_checks",
  "fetch_pr_context",
  "open_pr",
  "post_pr_comment",
  "create_pr_check",
  "complete_pr_check",
  "post_pr_review",
]);

const agentBlocks = new Set<WorkflowBlockType>([
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
]);

const available: WorkflowBlockAvailability = { available: true, unavailableReason: null };

function unavailable(unavailableReason: string): WorkflowBlockAvailability {
  return { available: false, unavailableReason };
}

function availabilityFor(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): WorkflowBlockAvailability {
  // An integration's block first, and from data alone: its integration's state
  // and the capabilities it declared. Core writes no rule for one and learns
  // nothing about the provider behind it.
  const fromIntegration = integrationBlockAvailability(type, context.integrations, {
    coreOwnsType: coreOwnsBlockType(type),
  });
  if (fromIntegration) return fromIntegration;
  const definitionIssue = workflowBlockDefinitionIssue(type, params);
  if (definitionIssue) return unavailable(definitionIssue);
  // What this core block needs is stated once, in integration-availability, and
  // read here, by the run's pin and by the dispatch blocker alike. A second
  // statement is how a palette and a run come to disagree.
  for (const capability of coreBlockCapabilities(type, params).required) {
    const issue = coreCapabilityIssue(capability, context.integrations);
    if (!issue) continue;
    return unavailable(
      type === "investigate"
        ? `${issue} Turn off that provider on this block for an issue-tracker-only investigation.`
        : issue,
    );
  }
  if (type === "trigger_webhook" && !context.webhookTriggerConfigured) {
    return unavailable("Webhook trigger encryption is not configured.");
  }
  const selectedProviders = Array.isArray(params.providers)
    ? params.providers.filter((provider): provider is VcsProviderKind => typeof provider === "string")
    : [];
  if (vcsBlocks.has(type) && context.vcsProviders.length === 0) {
    return unavailable("No version-control provider is configured.");
  }
  if (
    vcsBlocks.has(type) &&
    selectedProviders.length > 0 &&
    !selectedProviders.some((provider) => context.vcsProviders.includes(provider))
  ) {
    return unavailable(
      `Selected VCS providers are not configured: ${selectedProviders.join(", ")}.`,
    );
  }
  if (type === "trigger_pr_review") {
    const states = Array.isArray(params.on)
      ? params.on.filter((state): state is string => typeof state === "string")
      : [];
    // The providers this trigger can hear from: the ones it names that are
    // connected, or every connected one when it names none.
    const effectiveProviders = selectedProviders.length > 0
      ? selectedProviders.filter((provider) => context.vcsProviders.includes(provider))
      : context.vcsProviders;
    const unreported = unreportedReviewStatesIssue(states, effectiveProviders, context);
    if (unreported) return unavailable(unreported);
    if (states.includes("commented")) {
      const missingBotIdentities = effectiveProviders.filter(
        (provider) => !context.vcsBotIdentities.includes(provider),
      );
      if (missingBotIdentities.length > 0) {
        return unavailable(
          `Commented review triggers require a bot username for ${missingBotIdentities.join(", ")} to prevent recursive bot reviews. Configure it on the Integrations page.`,
        );
      }
    }
  }
  if (type === "call_llm") {
    const explicitProvider: LlmProvider | undefined =
      params.provider === "claude" || params.provider === "codex"
        ? params.provider
        : undefined;
    const explicitModel =
      typeof params.model === "string" && params.model.trim() !== ""
        ? params.model.trim()
        : undefined;
    const runtimeProvider =
      explicitModel === undefined
        ? (explicitProvider ?? context.defaultAgent.provider)
        : explicitProvider;
    const requested = resolveLlmProvider(
      explicitModel ?? context.defaultAgent.model,
      runtimeProvider,
    );
    if (!context.llmProviders[requested]) {
      return unavailable(
        requested === "codex"
          ? "Codex API credentials are not configured for Call LLM."
          : "Claude API credentials are not configured for Call LLM.",
      );
    }
  }
  if (agentBlocks.has(type)) {
    const requested =
      params.provider === "claude" || params.provider === "codex"
        ? params.provider
        : context.defaultAgent.provider;
    if (!context.agentProviders[requested]) {
      return unavailable(
        requested === "codex"
          ? "Codex credentials are not configured."
          : "Claude credentials are not configured.",
      );
    }
  }
  return available;
}

/**
 * Why a review trigger could never start a run, when none of its providers
 * reports a review in any state it waits for; null when one does.
 *
 * Each provider's states come from its own manifest (`webhook.reviewStates`),
 * so the sentence names the provider and what it does report: GitLab delivers
 * a merge request note and nothing else, and a trigger waiting only for
 * "changes_requested" there would sit silent with nothing on any screen.
 */
function unreportedReviewStatesIssue(
  states: readonly string[],
  providers: readonly string[],
  context: WorkflowBlockRegistryContext,
): string | null {
  // Judged only against a manifest this build ships: a provider nothing is
  // declared for is the providers check's business, above, not a silent "no".
  const reported = providers.flatMap((provider) => {
    const presence = context.integrations.byId.get(provider);
    return presence ? [{ name: presence.name, states: presence.reviewStates }] : [];
  });
  if (states.length === 0 || reported.length === 0) return null;
  if (reported.some((provider) => provider.states.some((state) => states.includes(state)))) {
    return null;
  }
  const quoted = (list: readonly string[]) => list.map((state) => `"${state}"`).join(" or ");
  const phrases = reported.map((provider) =>
    provider.states.length > 0
      ? `${provider.name} reports a review only as ${quoted(provider.states)}`
      : `${provider.name} reports no reviews`,
  );
  return `${phrases.join("; ")}, so a trigger waiting for ${quoted(states)} would never start a run.`;
}

/**
 * Whether core's own catalog owns this block type.
 *
 * A stored definition may name a type this build does not ship, because an
 * integration was removed since it was published. Asking the catalog rather
 * than trusting the type is what lets that node be answered instead of
 * crashing a lookup that assumes every type is core's.
 */
function coreOwnsBlockType(type: WorkflowBlockType): boolean {
  return Object.prototype.hasOwnProperty.call(blockContractDefinitions, type);
}

export function resolveWorkflowBlockContract(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): WorkflowBlockContract {
  if (!coreOwnsBlockType(type)) {
    return integrationBlockContract(
      type,
      context.integrations,
      availabilityFor(type, params, context),
    );
  }
  const definition = blockContractDefinitions[type];
  const catalog = BLOCK_CATALOG[type];
  const defaults = defaultsForContext(type, catalog.defaults, context);
  const spec = BLOCK_TYPE_SPECS[type];
  const output = resolvedOutput(type, params, definition.output);
  return {
    type,
    presentation: catalogPresentation(type),
    defaults: {
      ...(agentBlocks.has(type)
        ? { provider: context.defaultAgent.provider, model: context.defaultAgent.model }
        : {}),
      ...defaults,
    },
    ports: [...spec.ports],
    allowsFailurePort: spec.allowsFailurePort,
    inputs: catalog.inputs,
    additionalInputs: catalog.additionalInputs,
    output: {
      schema: output,
      bindingSchema: resolvedBindingOutput(type, params, definition, output),
      statusVariants: [...definition.statusVariants],
    },
    availability: availabilityFor(type, params, context),
  };
}

/**
 * Every block this deployment offers: core's catalog plus the blocks the
 * integrations in this build contribute.
 *
 * An integration's block is listed whether or not it is usable, carrying its
 * availability, because the palette is where an author learns that the block
 * exists and what is missing. A build that ships no such integration lists
 * none, so an author is never offered a block nothing here could run.
 */
export function buildWorkflowBlockRegistry(
  context: WorkflowBlockRegistryContext,
): Record<WorkflowBlockType, WorkflowBlockContract> {
  return Object.fromEntries([
    ...(Object.keys(blockContractDefinitions) as WorkflowBlockType[]).map((type) => [
      type,
      resolveWorkflowBlockContract(
        type,
        defaultsForContext(type, BLOCK_CATALOG[type].defaults, context),
        context,
      ),
    ]),
    ...integrationBlockContracts(context.integrations, (type, params) =>
      availabilityFor(type, params, context),
    ),
  ]) as Record<WorkflowBlockType, WorkflowBlockContract>;
}

/**
 * A block's defaults on this deployment.
 *
 * A review trigger starts on the shared default states unless no connected
 * provider reports any of them. Then it starts on the states they do report:
 * on a deployment whose only version control is GitLab, "changes_requested"
 * would place a block that is refused the moment it lands.
 */
function defaultsForContext(
  type: WorkflowBlockType,
  defaults: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): Record<string, WorkflowParamValue> {
  if (type !== "trigger_pr_review") return defaults;
  const states = Array.isArray(defaults.on) ? defaults.on : [];
  const reported = [
    ...new Set(
      context.vcsProviders.flatMap(
        (provider) => context.integrations.byId.get(provider)?.reviewStates ?? [],
      ),
    ),
  ];
  if (reported.length === 0 || states.some((state) => reported.includes(state as string))) {
    return defaults;
  }
  return { ...defaults, on: reported };
}

/**
 * Bind one environment into a resolver.
 *
 * Built once per request and handed to every rule that needs a contract, so one
 * validation cannot see two different deployments: a provider that comes online
 * between two reads would otherwise make the same definition valid in one half
 * of an answer and invalid in the other.
 */
export function createWorkflowBlockContractResolver(
  context: WorkflowBlockRegistryContext,
): WorkflowBlockContractResolver {
  return (type, params) => resolveWorkflowBlockContract(type, params, context);
}
