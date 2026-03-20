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

  // Try direct parse first
  try {
    const direct = agentOutputSchema.safeParse(JSON.parse(raw));
    if (direct.success) return direct.data;
  } catch {
    // Not valid JSON — try extraction below
  }

  // Claude may wrap JSON in markdown or text — extract individual JSON objects
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

export function buildAgentCommand(model: string): {
  cmd: string;
  args: string[];
} {
  return {
    cmd: "bash",
    args: [
      "-c",
      `cat /vercel/sandbox/requirements.md | claude --print --output-format json --json-schema '${AGENT_SCHEMA}' --model "${model}" --dangerously-skip-permissions`,
    ],
  };
}
