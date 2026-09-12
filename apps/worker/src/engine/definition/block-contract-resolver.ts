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
} from "../../workflow-definition/block-registry.js";

export interface WorkflowBlockRegistryContext {
  agentProviders: { claude: boolean; codex: boolean };
  llmProviders: { claude: boolean; codex: boolean };
  defaultAgent: { provider: "claude" | "codex"; model: string };
  vcsProviders: VcsProviderKind[];
  vcsBotIdentities: VcsProviderKind[];
  slackConfigured: boolean;
  arthurConfigured: boolean;
  webhookTriggerConfigured: boolean;
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
  const definitionIssue = workflowBlockDefinitionIssue(type, params);
  if (definitionIssue) return unavailable(definitionIssue);
  if (type === "send_slack_message" && !context.slackConfigured) {
    return unavailable("Slack messaging is not configured.");
  }
  if (type === "investigate" && !context.slackConfigured) {
    // An absent selection means both providers on (the param's own default), so
    // only a list that omits Slack opts out.
    const providers: unknown = params.providers;
    const slackEnabled = Array.isArray(providers)
      ? providers.includes("slack")
      : true;
    if (slackEnabled) {
      return unavailable(
        "Slack messaging is not configured; turn off the Slack provider for a Jira-only investigation.",
      );
    }
  }
  if (type === "arthur_injection_check" && !context.arthurConfigured) {
    return unavailable("Arthur Engine is not configured.");
  }
  if (type === "trigger_webhook" && !context.webhookTriggerConfigured) {
    return unavailable("Webhook trigger encryption is not configured.");
  }
  const selectedProviders = Array.isArray(params.providers)
    ? params.providers.filter(
      (provider): provider is VcsProviderKind => provider === "github" || provider === "gitlab",
    )
    : [];
  if (
    type === "trigger_pr_review" &&
    selectedProviders.includes("gitlab") &&
    !(Array.isArray(params.on) && params.on.includes("commented"))
  ) {
    return unavailable(
      'GitLab review triggers must include "commented"; GitLab does not emit a reliable changes-requested review event.',
    );
  }
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
    const states = Array.isArray(params.on) ? params.on : [];
    if (states.includes("commented")) {
      const missingBotIdentities = selectedProviders.filter(
        (provider) =>
          context.vcsProviders.includes(provider) &&
          !context.vcsBotIdentities.includes(provider),
      );
      if (missingBotIdentities.length > 0) {
        const variables = missingBotIdentities.map((provider) =>
          provider === "github" ? "GITHUB_BOT_LOGIN" : "GITLAB_BOT_LOGIN",
        );
        const label = missingBotIdentities[0] === "github" ? "GitHub" : "GitLab";
        return unavailable(
          context.vcsProviders.length === 1
            ? `Commented ${label} review triggers require ${variables[0]} (or VCS_BOT_LOGIN in a single-provider deployment) to prevent recursive bot reviews.`
            : missingBotIdentities.length === 1
              ? `Commented review triggers require a configured ${variables[0]} to prevent recursive bot reviews.`
              : `Commented review triggers require configured ${variables.join(" and ")} values to prevent recursive bot reviews.`,
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

export function resolveWorkflowBlockContract(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): WorkflowBlockContract {
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

export function buildWorkflowBlockRegistry(
  context: WorkflowBlockRegistryContext,
): Record<WorkflowBlockType, WorkflowBlockContract> {
  return Object.fromEntries(
    (Object.keys(blockContractDefinitions) as WorkflowBlockType[]).map((type) => [
      type,
      resolveWorkflowBlockContract(
        type,
        defaultsForContext(type, BLOCK_CATALOG[type].defaults, context),
        context,
      ),
    ]),
  ) as Record<WorkflowBlockType, WorkflowBlockContract>;
}

function defaultsForContext(
  type: WorkflowBlockType,
  defaults: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): Record<string, WorkflowParamValue> {
  if (
    type === "trigger_pr_review" &&
    !context.vcsProviders.includes("github") &&
    context.vcsProviders.includes("gitlab")
  ) {
    return { ...defaults, providers: ["gitlab"], on: ["commented"] };
  }
  return defaults;
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
