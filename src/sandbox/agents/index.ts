import { ClaudeAgentAdapter } from "./claude.js";
import { CodexAgentAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

export type AgentKind = "claude" | "codex";

export function createAgentAdapter(kind: AgentKind): AgentAdapter {
  switch (kind) {
    case "claude": return new ClaudeAgentAdapter();
    case "codex":  return new CodexAgentAdapter();
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown AGENT_KIND: ${_exhaustive}`);
    }
  }
}

const AGENT_LABEL_PREFIX = "agent:";

/**
 * Parse a per-ticket agent override from issue-tracker labels. Returns the
 * AgentKind named by the first `agent:<kind>` label, or `null` if none/invalid.
 * Conflicting labels (e.g. both `agent:claude` and `agent:codex`) collapse to
 * `null` — caller falls back to the env default.
 */
export function parseAgentKindOverride(labels: readonly string[]): AgentKind | null {
  const matches = new Set<string>();
  for (const raw of labels) {
    const lower = raw.trim().toLowerCase();
    if (!lower.startsWith(AGENT_LABEL_PREFIX)) continue;
    matches.add(lower.slice(AGENT_LABEL_PREFIX.length));
  }
  if (matches.size !== 1) return null;
  const [only] = matches;
  if (only === "claude" || only === "codex") return only;
  return null;
}

export type { AgentAdapter } from "./types.js";
