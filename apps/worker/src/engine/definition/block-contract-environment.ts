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
import { coreServesIssueTracker } from "../support/adapters.js";
import { env } from "../../infra/vcs-config.js";
import {
  createWorkflowBlockContractResolver,
  type WorkflowBlockRegistryContext,
} from "./block-contract-resolver.js";
import { NO_INTEGRATIONS, type DeploymentIntegrations } from "./integration-availability.js";

/**
 * The deployment as its credentials describe it: which agents, LLMs, VCS
 * providers and integrations this process can actually reach.
 *
 * Credentials only. Provider and model belong to a Harness Profile and are
 * added by `workflowBlockRegistryContext` below.
 */
function deploymentCapabilities(): Omit<WorkflowBlockRegistryContext, "defaultAgent"> {
  const vcsProviders: WorkflowBlockRegistryContext["vcsProviders"] = [];
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID) {
    vcsProviders.push("github");
  }
  if (env.GITLAB_TOKEN) vcsProviders.push("gitlab");
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
    vcsProviders,
    vcsBotIdentities: vcsProviders.filter((provider) =>
      Boolean(
        resolveVcsBotLogin(provider, vcsProviders, {
          github: env.GITHUB_BOT_LOGIN,
          gitlab: env.GITLAB_BOT_LOGIN,
          legacy: env.VCS_BOT_LOGIN,
        }),
      ),
    ),
    slackConfigured: Boolean(env.CHAT_SDK_SLACK_TOKEN && env.CHAT_SDK_CHANNEL_ID),
    arthurConfigured: Boolean(env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT),
    webhookTriggerConfigured: Boolean(env.WEBHOOK_TRIGGER_ENCRYPTION_KEY),
    // Filled by the async reader below, which is the only caller that can ask
    // the database what is connected. A caller that cannot wait gets an empty
    // deployment, which offers no integration block rather than offering one
    // nothing here could run.
    integrations: NO_INTEGRATIONS,
  };
}

/**
 * The capabilities this deployment serves from core rather than from an
 * integration.
 *
 * Each one is a provider the plan moves into its own package in a later stage
 * (ADR-010, stages S8 to S13). Until then a block that asks for the capability
 * is served by core's own adapters, built from the same variables they always
 * were, which is what keeps every deployment running with nothing to migrate.
 * The set shrinks to nothing as those stages land; nothing else reads it.
 */
export function builtinCapabilitiesOfDeployment(): string[] {
  const deployment = deploymentCapabilities();
  const served: string[] = [];
  // Each one is credential-gated, the way the palette already gates the core
  // blocks that use it. An ungated entry would offer and publish a block on a
  // deployment that cannot serve the capability at all, and the refusal would
  // arrive inside the call rather than in the editor. The tracker's own module
  // answers for it, so this file names no provider.
  if (coreServesIssueTracker()) served.push("issue_tracker");
  if (deployment.vcsProviders.length > 0) served.push("vcs");
  if (deployment.slackConfigured) served.push("messaging");
  return served;
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
  return {
    ...deploymentCapabilities(),
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
