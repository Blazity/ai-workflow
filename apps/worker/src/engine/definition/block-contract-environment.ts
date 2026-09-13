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
  };
}

/**
 * The deployment as one caller sees it: configured credentials plus the
 * provider and model of the Harness Profile in force.
 *
 * A caller resolving a specific node passes its resolved profile. Definition
 * authoring and other callers without a node use the one code-owned built-in
 * default profile selected by `@shared/harness`.
 */
export function workflowBlockRegistryContext(
  profile: Pick<HarnessProfileManifest, "harness" | "model"> =
    defaultBuiltinHarnessProfile(),
): WorkflowBlockRegistryContext {
  return {
    ...deploymentCapabilities(),
    defaultAgent: {
      provider: profile.harness.provider,
      model: profile.model.id,
    },
  };
}

/** The resolver for the deployment and optional profile described above. */
export function workflowBlockContractResolver(
  profile?: Pick<HarnessProfileManifest, "harness" | "model">,
): WorkflowBlockContractResolver {
  return createWorkflowBlockContractResolver(workflowBlockRegistryContext(profile));
}
