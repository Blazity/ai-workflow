/**
 * The deployment this process is configured as.
 *
 * Split from `block-contract-resolver.ts` so that resolving a block contract
 * needs no environment: only this module reads one, and importing it is a
 * deliberate statement that the caller wants the running deployment rather than
 * a declared one.
 */
import type {
  HarnessProfileManifest,
  WorkflowBlockContractResolver,
} from "@shared/contracts";
import { defaultBuiltinHarnessProfile } from "@shared/harness";
import { resolveVcsBotLogin } from "../../adapters/vcs/vcs-bot-identity.js";
import { env } from "../../infra/vcs-config.js";
import {
  createWorkflowBlockContractResolver,
  type WorkflowBlockRegistryContext,
} from "./block-contract-resolver.js";
import { NO_INTEGRATIONS, type DeploymentIntegrations } from "./integration-availability.js";

/**
 * The deployment as its environment describes it: which agents and LLMs this
 * process has credentials for, and whether webhook trigger secrets can be
 * sealed.
 *
 * Credentials only. Provider and model belong to a Harness Profile, and every
 * provider an integration serves (version control included) comes from the
 * integrations the caller read; `workflowBlockRegistryContext` below adds both.
 */
function deploymentCapabilities(): Omit<
  WorkflowBlockRegistryContext,
  "defaultAgent" | "vcsProviders" | "vcsBotIdentities" | "integrations"
> {
  return {
    agentProviders: {
      claude: Boolean(env.ANTHROPIC_API_KEY),
      codex: Boolean(env.CODEX_API_KEY || env.CODEX_CHATGPT_OAUTH_TOKEN),
    },
    llmProviders: {
      claude: Boolean(
        env.ANTHROPIC_API_KEY && !env.ANTHROPIC_API_KEY.startsWith("sk-ant-oat"),
      ),
      codex: Boolean(env.CODEX_API_KEY),
    },
    webhookTriggerConfigured: Boolean(env.WEBHOOK_TRIGGER_ENCRYPTION_KEY),
  };
}

/**
 * The deployment as one caller sees it: configured credentials plus the
 * provider and model of the Harness Profile in force.
 *
 * A caller resolving a specific node passes its resolved profile. Definition
 * authoring and other callers without a node use the one code-owned built-in
 * default profile selected by `@shared/harness`.
 *
 * `integrations` is read from the database, which this tier cannot reach, so
 * the caller that can passes it (`services/workflow-definitions/block-contracts.ts`).
 * Omitting it declares a deployment with no integration rather than one whose
 * integrations nobody looked up, so a caller who forgets offers no integration
 * block instead of offering one that cannot run.
 */
export function workflowBlockRegistryContext(
  profile: Pick<HarnessProfileManifest, "harness" | "model"> =
    defaultBuiltinHarnessProfile(),
  integrations: DeploymentIntegrations = NO_INTEGRATIONS,
): WorkflowBlockRegistryContext {
  const deployment = deploymentCapabilities();
  // Every version control provider is an integration since S11, so the ones
  // this deployment has are the usable integrations that serve it.
  const vcsProviders = [...(integrations.providers.get("vcs") ?? [])];
  const soleProvider = vcsProviders.length === 1 ? vcsProviders[0] : undefined;
  // Whether a provider has an automation account is the integration resolver's
  // answer and only its answer. Reading the environment a second time here
  // would disagree with it the moment a connection moved to stored values, and
  // the editor would offer a trigger the run then refuses.
  const byProvider = Object.fromEntries(vcsProviders.map((provider) => [
    provider,
    integrations.botIdentityProviders.has(provider) ? "configured" : undefined,
  ]));
  const legacy = soleProvider && integrations.legacyBotIdentityProviders.has(soleProvider)
    ? "configured"
    : undefined;
  const vcsBotIdentities = vcsProviders.filter((provider) => Boolean(
    resolveVcsBotLogin(provider, vcsProviders, { byProvider, legacy }),
  ));
  return {
    ...deployment,
    vcsProviders,
    vcsBotIdentities,
    integrations,
    defaultAgent: {
      provider: profile.harness.provider,
      model: profile.model.id,
    },
  };
}

/** The resolver for the deployment and optional profile described above. */
export function workflowBlockContractResolver(
  profile?: Pick<HarnessProfileManifest, "harness" | "model">,
  integrations?: DeploymentIntegrations,
): WorkflowBlockContractResolver {
  return createWorkflowBlockContractResolver(
    workflowBlockRegistryContext(profile, integrations),
  );
}
