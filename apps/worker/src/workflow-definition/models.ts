import type { WorkflowEditorOptions } from "@shared/contracts";
import {
  recognised,
  resolveModelDefaults,
  selectable,
} from "@shared/harness";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import { env } from "../infra/vcs-config.js";
import { RUN_BINDING_SCHEMA } from "./bindings.js";

export const FALLBACK_MODELS = recognised;

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

export async function fetchTicketStatuses(
  issueTracker?: IssueTrackerAdapter,
): Promise<Array<{ id: string; name: string }>> {
  try {
    const adapter =
      issueTracker ?? (await import("../engine/support/adapters.js")).createAdapters().issueTracker;
    return (await adapter.listStatuses?.()) ?? [];
  } catch {
    // The editor remains usable during provider outages. Passing an empty list
    // makes buildWorkflowEditorOptions expose the configured legacy targets.
    return [];
  }
}

async function fetchClaudeModels(): Promise<string[]> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return [...FALLBACK_MODELS.claude];
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [...FALLBACK_MODELS.claude];
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, MODEL_LIST_CAP);
    return ids.length > 0 ? ids : [...FALLBACK_MODELS.claude];
  } catch {
    return [...FALLBACK_MODELS.claude];
  }
}

async function fetchCodexModels(): Promise<string[]> {
  const apiKey = env.CODEX_API_KEY;
  if (!apiKey) return [...FALLBACK_MODELS.codex];
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [...FALLBACK_MODELS.codex];
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .filter((id) => isCodexDiscoveryModelId(id) && !DATED_SNAPSHOT.test(id))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, MODEL_LIST_CAP);
    return ids.length > 0 ? ids : [...FALLBACK_MODELS.codex];
  } catch {
    return [...FALLBACK_MODELS.codex];
  }
}

function isCodexDiscoveryModelId(modelId: string): boolean {
  return (
    recognised.codex.some((catalogId) => modelId.startsWith(catalogId)) ||
    modelId.includes("codex")
  );
}

/** The editor's opening payload. The block registry arrives resolved, because
 *  which blocks a deployment offers is environment state this module must not
 *  read for itself. */
export function buildWorkflowEditorOptions(
  models: AvailableModels,
  discoveredTicketStatuses: Array<{ id: string; name: string }>,
  blockRegistry: WorkflowEditorOptions["blockRegistry"],
): WorkflowEditorOptions {
  const agentKind = env.AGENT_KIND;
  const configuredModels = resolveModelDefaults({
    claude: env.CLAUDE_MODEL,
    codex: env.CODEX_MODEL,
  });
  const defaultModel = configuredModels[agentKind];
  const ticketStatuses = dedupeTicketStatuses(discoveredTicketStatuses);
  return {
    agentKind,
    defaultModel,
    defaultModels: configuredModels,
    models: {
      claude: selectable({
        provider: "claude",
        modelIds: dedupePrepend(configuredModels.claude, models.claude),
      }),
      codex: selectable({
        provider: "codex",
        modelIds: dedupePrepend(configuredModels.codex, models.codex),
      }),
    },
    ticketStatusTargets:
      ticketStatuses.length > 0
        ? ticketStatuses.map((status) => ({
            value: status.id,
            label: status.name,
          }))
        : [
            { value: "ai_review", label: env.COLUMN_AI_REVIEW },
            { value: "backlog", label: env.COLUMN_BACKLOG },
          ],
    blockRegistry,
    runBindingSchema: RUN_BINDING_SCHEMA,
  };
}

function dedupeTicketStatuses(
  statuses: Array<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; name: string }> = [];
  for (const status of statuses) {
    const id = status.id.trim();
    const name = status.name.trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name });
  }
  return result;
}

function dedupePrepend(model: string, list: string[]): string[] {
  return [model, ...list.filter((entry) => entry !== model)];
}
