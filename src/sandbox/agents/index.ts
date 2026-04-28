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

export type { AgentAdapter } from "./types.js";
