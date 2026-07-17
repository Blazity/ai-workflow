import type { AgentKind } from "../sandbox/agents/index.js";

export interface ResolvedAgent {
  kind: AgentKind;
  model: string;
}

const AGENT_BLOCK_TYPES = new Set([
  "planning_agent",
  "implementation_agent",
  "review_agent",
]);

// Precedence for the run-wide default agent kind: a per-ticket label override
// wins, otherwise the env-configured default applies.
export function resolveRunDefaultKind(
  labelOverride: AgentKind | null,
  envAgentKind: AgentKind,
): AgentKind {
  return labelOverride ?? envAgentKind;
}

function resolveKind(
  params: Record<string, unknown> | undefined,
  defaultKind: AgentKind,
): AgentKind {
  const provider = params?.provider;
  return provider === "claude" || provider === "codex" ? provider : defaultKind;
}

export function resolveBlockAgent(
  params: Record<string, unknown> | undefined,
  defaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): ResolvedAgent {
  const kind = resolveKind(params, defaultKind);
  const rawModel = params?.model;
  const model =
    typeof rawModel === "string" && rawModel.trim().length > 0
      ? rawModel.trim()
      : defaults[kind];
  return { kind, model };
}

export function requiredAgentKinds(
  blocks: Array<{ type: string; params?: Record<string, unknown> }>,
  defaultKind: AgentKind,
): AgentKind[] {
  const kinds: AgentKind[] = [defaultKind];
  for (const block of blocks) {
    if (!AGENT_BLOCK_TYPES.has(block.type)) continue;
    const kind = resolveKind(block.params, defaultKind);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}
