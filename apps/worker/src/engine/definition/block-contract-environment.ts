/**
 * The deployment this process is configured as.
 *
 * Split from `block-contract-resolver.ts` so that resolving a block contract
 * needs no environment: only this module reads one, and importing it is a
 * deliberate statement that the caller wants the running deployment rather than
 * a declared one.
 */
import type {
  SettingsSnapshot,
  WorkflowBlockContractResolver,
} from "@shared/contracts";
import { resolveModelDefaults } from "@shared/harness";
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
 * Credentials only. The agent defaults that used to be read here beside them
 * (`AGENT_KIND`, `CLAUDE_MODEL`, `CODEX_MODEL`) are operator-editable settings
 * and come from a snapshot, so the two halves are separated: one asks what the
 * deployment is wired to, the other asks what the operator decided.
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
 * The default model per agent kind, for a run holding a settings snapshot.
 *
 * The registry stores both model keys as "unset means the catalog's default",
 * exactly as the environment schema left them optional, so the same resolver
 * the environment read went through still runs here: an empty string or a null
 * must reach `resolveModelDefaults` as an ABSENT key, not as a falsy value it
 * would then treat as a model name.
 *
 * One function rather than the spread written out twice. The two sites that
 * needed it (the workflow body's own defaults and the block contract context)
 * are the run's two answers to "which model does this deployment default to",
 * and two copies of the spread is exactly how those two answers drift apart.
 */
export function runModelDefaults(
  settings: SettingsSnapshot,
): ReturnType<typeof resolveModelDefaults> {
  return resolveModelDefaults({
    ...(settings.CLAUDE_MODEL ? { claude: settings.CLAUDE_MODEL } : {}),
    ...(settings.CODEX_MODEL ? { codex: settings.CODEX_MODEL } : {}),
  });
}

/**
 * The deployment as one caller sees it: the credentials it is wired to, plus
 * the agent defaults the given settings decided.
 *
 * One function for every caller, a run and an editor request alike. There used
 * to be two, a zero-argument form that read the defaults from the environment
 * and a run form that took the snapshot, and they answered differently on a
 * deployment whose operator had changed the default agent: the editor's block
 * table showed the variable's value and the run used the stored one. A run
 * passes the snapshot its run-start step froze, so it still resolves every
 * block contract against one answer for its whole life; an entry point passes
 * the snapshot it loaded.
 */
export function workflowBlockRegistryContext(
  settings: SettingsSnapshot,
): WorkflowBlockRegistryContext {
  const configuredModels = runModelDefaults(settings);
  return {
    ...deploymentCapabilities(),
    defaultAgent: {
      provider: settings.AGENT_KIND,
      model: configuredModels[settings.AGENT_KIND],
    },
  };
}

/** The resolver for the deployment as the given settings describe it. */
export function workflowBlockContractResolver(
  settings: SettingsSnapshot,
): WorkflowBlockContractResolver {
  return createWorkflowBlockContractResolver(workflowBlockRegistryContext(settings));
}
