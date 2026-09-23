import type { JsonValue } from "@shared/contracts";

/**
 * A block attempt's logs, read for a person rather than dumped as JSON.
 *
 * What the worker stores (`appendReplayLogEnvelope`): one value per log it
 * observed, a list once there are several. An agent's log is `{ stream, tail }`,
 * where `tail` is the end of the CLI's stdout or stderr, and that tail is
 * mostly one JSON event per line whose fields can hold JSON documents of their
 * own (a result, a plan). A progress note is a plain string. A set that ran
 * over its size budget is stored as the tail of its own serialized JSON behind
 * a "[TRUNCATED]" marker, which no longer parses.
 *
 * `JSON.stringify` of all that escaped every layer again, three levels deep for
 * a plan inside a result inside a tail, and the one sentence that said why a run
 * stopped sat in a wall of backslashes. Here each JSON line is parsed, and each
 * string field that is itself a JSON document is read as that document, so the
 * view can show fields and text with their own line breaks. The stored value is
 * never changed: the raw dump stays one click away.
 */

type ReplayLogLine =
  | { kind: "text"; text: string }
  | { kind: "json"; value: JsonValue };

export interface ReplayLogEntry {
  /** "stdout" or "stderr" for an agent's log; null for a plain note. */
  stream: string | null;
  lines: ReplayLogLine[];
}

/** How deep a document inside a field inside a document is still unwrapped.
 *  Real logs nest two levels (a plan inside a result inside an event). */
const MAX_NESTED_DOCUMENTS = 4;

/** The logs as entries of lines, or null when there is nothing to show, so the
 *  caller keeps its raw fallback. */
export function readReplayLogs(value: JsonValue): ReplayLogEntry[] | null {
  const values = Array.isArray(value) ? value : [value];
  const entries = values.flatMap((item): ReplayLogEntry[] => {
    if (item === null) return [];
    if (typeof item === "string") return textEntry(null, item);
    if (typeof item === "object" && !Array.isArray(item) && typeof item.tail === "string") {
      return textEntry(typeof item.stream === "string" ? item.stream : null, item.tail);
    }
    return [{ stream: null, lines: [{ kind: "json", value: unwrapDocuments(item, 0) }] }];
  });
  return entries.length > 0 ? entries : null;
}

function textEntry(stream: string | null, text: string): ReplayLogEntry[] {
  const lines = readLines(text);
  return lines.length > 0 ? [{ stream, lines }] : [];
}

/** JSON lines become fields; the text between them stays one block, in order. */
function readLines(text: string): ReplayLogLine[] {
  const lines: ReplayLogLine[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length > 0) lines.push({ kind: "text", text: pending.join("\n") });
    pending = [];
  };
  for (const line of text.replace(/\n+$/, "").split("\n")) {
    const document = parseDocument(line);
    if (document === undefined) {
      pending.push(line);
      continue;
    }
    flush();
    lines.push({ kind: "json", value: unwrapDocuments(document, 0) });
  }
  flush();
  return lines;
}

/** A JSON object or array written as text, or undefined for anything else. */
function parseDocument(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function unwrapDocuments(value: JsonValue, depth: number): JsonValue {
  if (typeof value === "string") {
    if (depth >= MAX_NESTED_DOCUMENTS) return value;
    const document = parseDocument(value);
    return document === undefined ? value : unwrapDocuments(document, depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => unwrapDocuments(item, depth));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unwrapDocuments(item, depth)]),
    );
  }
  return value;
}
