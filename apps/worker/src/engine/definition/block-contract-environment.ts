/**
 * The deployment this process is configured as.
 *
 * Split from `block-contract-resolver.ts` so that resolving a block contract
 * needs no environment: only this module reads one, and importing it is a
 * deliberate statement that the caller wants the running deployment rather than
 * a declared one.
 */
import type { WorkflowBlockContractResolver } from "@shared/contracts";
import { resolveModelDefaults } from "@shared/harness";
import { resolveVcsBotLogin } from "../../adapters/vcs/vcs-bot-identity.js";
import { env } from "../../infra/vcs-config.js";
import {
  createWorkflowBlockContractResolver,
  type WorkflowBlockRegistryContext,
} from "./block-contract-resolver.js";

/** The deployment as the environment describes it right now. */
export function workflowBlockRegistryContextFromEnv(): WorkflowBlockRegistryContext {
  const configuredModels = resolveModelDefaults({
    claude: env.CLAUDE_MODEL,
    codex: env.CODEX_MODEL,
  });
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
    defaultAgent: {
      provider: env.AGENT_KIND,
      model: configuredModels[env.AGENT_KIND],
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

/** The resolver for the deployment as it is configured right now. */
export function workflowBlockContractResolverFromEnv(): WorkflowBlockContractResolver {
  return createWorkflowBlockContractResolver(workflowBlockRegistryContextFromEnv());
}
