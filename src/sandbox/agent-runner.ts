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
        // --json-schema puts validated output in structured_output
        if (event.structured_output != null) {
          const parsed = agentOutputSchema.safeParse(event.structured_output);
          if (parsed.success) return parsed.data;
        }

        // Fallback: try event.result as JSON
        if (typeof event.result === "string") {
          try {
            const parsed = agentOutputSchema.safeParse(JSON.parse(event.result));
            if (parsed.success) return parsed.data;
          } catch {
            // event.result is not valid JSON
          }
        }

        // Agent completed but structured_output was missing/invalid.
        // Infer from the envelope status as last resort.
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

// --- Research Status Parser ---

export type ResearchStatus = "completed" | "clarification_needed" | "failed";

export interface ResearchResult {
  status: ResearchStatus;
  body: string;
}

const VALID_RESEARCH_STATUSES: ResearchStatus[] = ["completed", "clarification_needed", "failed"];

export function parseResearchStatus(raw: string): ResearchResult {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    const match = line.match(/^STATUS:\s*([a-z_]+)/i);
    if (!match) continue;

    const status = match[1].toLowerCase() as ResearchStatus;
    if (VALID_RESEARCH_STATUSES.includes(status)) {
      const body = lines.slice(i + 1).join("\n").trim();
      return { status, body };
    }
  }

  return { status: "failed", body: raw };
}

// --- Review Output Schema ---

const reviewOutputSchema = z.object({
  result: z.enum(["approved", "failed"]),
  feedback: z.string(),
  issues: z.array(z.object({
    file: z.string(),
    description: z.string(),
    severity: z.enum(["critical", "suggestion"]),
  })),
  error: z.string().optional(),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    result: {
      type: "string",
      enum: ["approved", "failed"],
    },
    feedback: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["critical", "suggestion"] },
        },
        required: ["file", "description", "severity"],
      },
    },
    error: { type: "string" },
  },
  required: ["result", "feedback", "issues"],
});

export function parseReviewOutput(raw: string): ReviewOutput {
  if (!raw.trim()) {
    return { result: "failed", feedback: "", issues: [], error: "Review agent produced no output" };
  }

  // Direct parse
  try {
    const direct = reviewOutputSchema.safeParse(JSON.parse(raw));
    if (direct.success) return direct.data;
  } catch {}

  // Stream-json / result-envelope format
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);

      if (event.type === "result" && event.structured_output != null) {
        const parsed = reviewOutputSchema.safeParse(event.structured_output);
        if (parsed.success) return parsed.data;
      }

      const direct = reviewOutputSchema.safeParse(event);
      if (direct.success) return direct.data;
    } catch {}
  }

  // Fallback: extract JSON objects
  const objects = raw.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  for (const [candidate] of objects) {
    try {
      const result = reviewOutputSchema.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
    } catch {}
  }

  return {
    result: "failed",
    feedback: "",
    issues: [],
    error: `Review output was not structured JSON. Output starts with: ${raw.slice(0, 500)}`,
  };
}
