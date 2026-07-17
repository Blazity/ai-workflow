import type { WorkflowEditorOptions } from "@shared/contracts";
import { env } from "../../env.js";
import {
  buildWorkflowBlockRegistry,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";
import { RUN_BINDING_SCHEMA } from "./bindings.js";

export const FALLBACK_MODELS = {
  claude: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  codex: ["gpt-5-codex", "gpt-5", "gpt-5-mini"],
};

export interface AvailableModels {
  claude: string[];
  codex: string[];
}

const MODEL_LIST_CAP = 15;
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 3_600_000;
const DATED_SNAPSHOT = /\d{4}-\d{2}-\d{2}/;

let cache: { value: AvailableModels; expiresAt: number } | null = null;

export async function fetchAvailableModels(): Promise<AvailableModels> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }
  const [claude, codex] = await Promise.all([fetchClaudeModels(), fetchCodexModels()]);
  const value: AvailableModels = { claude, codex };
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

async function fetchClaudeModels(): Promise<string[]> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return FALLBACK_MODELS.claude;
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return FALLBACK_MODELS.claude;
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, MODEL_LIST_CAP);
    return ids.length > 0 ? ids : FALLBACK_MODELS.claude;
  } catch {
    return FALLBACK_MODELS.claude;
  }
}

async function fetchCodexModels(): Promise<string[]> {
  const apiKey = env.CODEX_API_KEY;
  if (!apiKey) return FALLBACK_MODELS.codex;
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return FALLBACK_MODELS.codex;
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .filter((id) => (id.startsWith("gpt-5") || id.includes("codex")) && !DATED_SNAPSHOT.test(id))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, MODEL_LIST_CAP);
    return ids.length > 0 ? ids : FALLBACK_MODELS.codex;
  } catch {
    return FALLBACK_MODELS.codex;
  }
}

export function buildWorkflowEditorOptions(models: AvailableModels): WorkflowEditorOptions {
  const agentKind = env.AGENT_KIND;
  const defaultModel = agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
  return {
    agentKind,
    defaultModel,
    defaultModels: { claude: env.CLAUDE_MODEL, codex: env.CODEX_MODEL },
    models: {
      claude: dedupePrepend(env.CLAUDE_MODEL, models.claude),
      codex: dedupePrepend(env.CODEX_MODEL, models.codex),
    },
    ticketStatusTargets: [
      { value: "ai_review", label: env.COLUMN_AI_REVIEW },
      { value: "backlog", label: env.COLUMN_BACKLOG },
    ],
    blockRegistry: buildWorkflowBlockRegistry(workflowBlockRegistryContextFromEnv()),
    runBindingSchema: RUN_BINDING_SCHEMA,
  };
}

export function workflowBlockRegistryContextFromEnv(): WorkflowBlockRegistryContext {
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
      model: env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL,
    },
    vcsProviders,
    slackConfigured: Boolean(env.CHAT_SDK_SLACK_TOKEN && env.CHAT_SDK_CHANNEL_ID),
    arthurConfigured: Boolean(env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT),
  };
}

function dedupePrepend(model: string, list: string[]): string[] {
  return [model, ...list.filter((entry) => entry !== model)];
}
