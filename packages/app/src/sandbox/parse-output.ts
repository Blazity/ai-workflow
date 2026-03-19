import type { AgentOutput } from "./types.js";

export function sanitizeForLog(text: string): string {
  return text.slice(-1000);
}

/**
 * Claude Code with `--output-format json --json-schema <schema>` returns an envelope:
 *   { "type": "result", "subtype": "success", "result": "...", "structured_output": { ... } }
 * Our agent schema lives in `structured_output`. If `--json-schema` was not honoured
 * (older Claude Code, or schema error) we fall back to parsing the envelope `result` field.
 */
export function parseAgentOutput(stdout: string): AgentOutput | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const envelope = JSON.parse(line);

      if (
        envelope.structured_output &&
        typeof envelope.structured_output.result === "string"
      ) {
        return envelope.structured_output as AgentOutput;
      }

      if (
        envelope.result &&
        typeof envelope.result === "string" &&
        ["implemented", "clarification_needed", "failed"].includes(envelope.result)
      ) {
        return envelope as AgentOutput;
      }
    } catch {
      continue;
    }
  }
  return null;
}
