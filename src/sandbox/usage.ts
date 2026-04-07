/**
 * Extracts Claude Code usage/cost data from the JSON result envelope
 * that `claude --print --output-format json` outputs.
 */

export interface PhaseUsage {
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
}

/**
 * Scans raw agent output for a Claude Code result envelope and extracts cost fields.
 * Works with both single-object JSON and stream-json (newline-delimited) formats.
 * Returns null if no usage data is found (e.g. agent crashed before producing output).
 */
export function extractUsage(raw: string): PhaseUsage | null {
  if (!raw.trim()) return null;

  // Try single JSON object first (--output-format json)
  const envelope = findResultEnvelope(raw);
  if (!envelope) return null;

  const cost =
    typeof envelope.cost_usd === "number"
      ? envelope.cost_usd
      : typeof envelope.total_cost_usd === "number"
        ? envelope.total_cost_usd
        : null;
  if (cost === null) return null;

  return {
    cost_usd: cost,
    duration_ms:
      typeof envelope.duration_ms === "number" ? envelope.duration_ms : 0,
    duration_api_ms:
      typeof envelope.duration_api_ms === "number"
        ? envelope.duration_api_ms
        : 0,
    num_turns: typeof envelope.num_turns === "number" ? envelope.num_turns : 0,
  };
}

/**
 * Unwraps the text content from a Claude Code JSON result envelope.
 * Used for the research phase which outputs free-form text (no --json-schema).
 *
 * If the raw output is already plain text (no envelope), returns it as-is.
 */
export function unwrapResearchText(raw: string): string {
  if (!raw.trim()) return raw;

  const envelope = findResultEnvelope(raw);
  if (!envelope) return raw;

  // The text content lives in the `result` field of the envelope
  if (typeof envelope.result === "string") {
    return envelope.result;
  }

  // Fallback: return raw (shouldn't happen with --output-format json)
  return raw;
}

/**
 * Formats accumulated phase usage data into a compact Slack-friendly string.
 */
export function formatUsageReport(
  phases: Record<string, PhaseUsage | null>,
): string {
  const parts: string[] = [];
  let totalCost = 0;

  for (const [name, usage] of Object.entries(phases)) {
    if (!usage) {
      parts.push(`${name}: n/a`);
      continue;
    }
    totalCost += usage.cost_usd;
    const mins = Math.round(usage.duration_ms / 60_000);
    parts.push(`${name}: $${usage.cost_usd.toFixed(2)} (${mins}m)`);
  }

  return `Usage: $${totalCost.toFixed(2)} total | ${parts.join(" | ")}`;
}

// --- Internal ---

function findResultEnvelope(raw: string): Record<string, unknown> | null {
  // Try parsing as a single JSON object
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && obj.type === "result") {
      return obj as Record<string, unknown>;
    }
  } catch {
    // Not a single JSON object — try line-by-line
  }

  // Scan lines in reverse for a result envelope (stream-json format)
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === "object" && obj.type === "result") {
        return obj as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON, try next line
    }
  }

  return null;
}
