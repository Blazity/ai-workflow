import { z } from "zod";

const agentOutputSchema = z.object({
  result: z.enum(["implemented", "clarification_needed", "failed"]),
  summary: z.string().optional(),
  questions: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;

export const AGENT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    result: {
      type: "string",
      enum: ["implemented", "clarification_needed", "failed"],
    },
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["result"],
});

export function parseAgentOutput(raw: string): AgentOutput {
  // Empty — treat as failure
  if (!raw.trim()) {
    return { result: "failed", error: "Agent produced no output" };
  }

  // Try direct parse first (normal --output-format json)
  try {
    const direct = agentOutputSchema.safeParse(JSON.parse(raw));
    if (direct.success) return direct.data;
  } catch {
    // Not valid JSON — try extraction below
  }

  // stream-json / result-envelope format: one JSON object per line — look for the result event
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);

      if (event.type === "result") {
        // Try event.result as JSON (--output-format json envelope)
        if (typeof event.result === "string") {
          try {
            const parsed = agentOutputSchema.safeParse(JSON.parse(event.result));
            if (parsed.success) return parsed.data;
          } catch {
            // event.result is not valid JSON
          }
        }

        // Try event.subtype as JSON (legacy stream-json format)
        if (typeof event.subtype === "string") {
          try {
            const parsed = agentOutputSchema.safeParse(JSON.parse(event.subtype));
            if (parsed.success) return parsed.data;
          } catch {
            // subtype is not valid JSON
          }
        }

        // Agent completed but returned text instead of structured JSON.
        // Infer result from the envelope's success/failure status.
        if (event.subtype === "success" && !event.is_error) {
          return {
            result: "implemented",
            summary: typeof event.result === "string"
              ? event.result.trim().slice(0, 500)
              : undefined,
          };
        }

        return {
          result: "failed",
          error: typeof event.result === "string"
            ? event.result.trim().slice(0, 500)
            : "Agent returned non-structured result",
        };
      }

      // Also check if the line itself matches our schema
      const direct = agentOutputSchema.safeParse(event);
      if (direct.success) return direct.data;
    } catch {
      // Not valid JSON, try next line
    }
  }

  // Fallback: extract individual JSON objects from mixed text
  const objects = raw.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  for (const [candidate] of objects) {
    try {
      const result = agentOutputSchema.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
    } catch {
      // Not valid JSON, try next candidate
    }
  }

  return {
    result: "failed",
    error: `Agent output was not structured JSON. Output starts with: ${raw.slice(0, 500)}`,
  };
}

/**
 * Format a stream-json event into a human-readable log line.
 * Returns null for events that aren't worth logging.
 */
export function formatStreamEvent(line: string): string | null {
  try {
    const e = JSON.parse(line);

    if (e.type === "system" && e.subtype === "init") {
      return `[init] session=${e.session_id} model=${e.model}`;
    }
    if (e.type === "assistant" && e.message?.content) {
      const parts: string[] = [];
      for (const block of e.message.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        }
        if (block.type === "tool_use") {
          parts.push(`[tool] ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
        }
      }
      return parts.join("\n") || null;
    }
    if (e.type === "tool_result") {
      const content = typeof e.content === "string"
        ? e.content.slice(0, 300)
        : JSON.stringify(e.content).slice(0, 300);
      return `[result] ${e.name ?? "tool"}: ${content}`;
    }
    if (e.type === "result") {
      return `[done] ${e.subtype} turns=${e.num_turns} cost=$${e.total_cost_usd?.toFixed(2) ?? "?"}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildAgentCommand(model: string, debug = false): {
  cmd: string;
  args: string[];
} {
  const flags = [
    "--print",
    `--model "${model}"`,
    "--dangerously-skip-permissions",
    ...(debug
      ? ["--output-format stream-json", "--verbose", `--json-schema '${AGENT_SCHEMA}'`]
      : ["--output-format json", `--json-schema '${AGENT_SCHEMA}'`]),
  ].join(" ");

  return {
    cmd: "bash",
    args: ["-c", `cat /vercel/sandbox/requirements.md | claude ${flags}`],
  };
}
