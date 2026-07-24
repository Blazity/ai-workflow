import type {
  JsonSchema202012,
  JsonValue,
  WorkflowDataReferenceV2,
  WorkflowInputBindingV2,
} from "./domain.js";

/** A typed value a reusable prompt requires from the workflow that includes it. */
export interface PromptSlotDefinition {
  name: string;
  description: string;
  schema: JsonSchema202012;
  required: boolean;
  defaultValue?: JsonValue;
}

/** Slot values use the same canonical reference-or-literal contract as v2 inputs. */
export type PromptSlotBinding = WorkflowInputBindingV2;

export interface ParsedPromptSlotToken {
  raw: string;
  start: number;
  end: number;
  name: string;
}

export interface ParsedPromptDataToken {
  raw: string;
  start: number;
  end: number;
  reference: WorkflowDataReferenceV2;
}

export const PROMPT_SLOT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const PROMPT_SLOT_TOKEN_SOURCE =
  String.raw`\{\{slot:([A-Za-z_][A-Za-z0-9_-]{0,63})\}\}`;
const PROMPT_SLOT_TOKEN_CANDIDATE_SOURCE = String.raw`\{\{slot:([^{}]+)\}\}`;
const PROMPT_DATA_TOKEN_CANDIDATE_SOURCE = String.raw`\{\{data:([^{}]+)\}\}`;
const UNSAFE_REFERENCE_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isSafeReferencePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !/\s/.test(segment) &&
    !UNSAFE_REFERENCE_SEGMENTS.has(segment)
  );
}

function isAddressableNodeId(segment: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment) &&
    !UNSAFE_REFERENCE_SEGMENTS.has(segment)
  );
}

export function isPromptDataReference(
  value: unknown,
): value is WorkflowDataReferenceV2 {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const segments = value.split(".");
  if (segments[0] === "run") {
    return (
      segments.length >= 2 &&
      segments.slice(1).every(isSafeReferencePathSegment)
    );
  }
  if (
    segments[0] !== "steps" ||
    segments.length < 3 ||
    segments[2] !== "output"
  ) {
    return false;
  }
  return (
    (segments[1] === "entry" || isAddressableNodeId(segments[1] ?? "")) &&
    segments.slice(3).every(isSafeReferencePathSegment)
  );
}

export function isPromptSlotBinding(
  value: unknown,
): value is PromptSlotBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "reference") {
    return (
      Object.keys(record).length === 2 &&
      isPromptDataReference(record.reference)
    );
  }
  return (
    record.kind === "literal" &&
    Object.keys(record).length === 2 &&
    isJsonValue(record.value)
  );
}

export function isPromptSlotDefinition(
  value: unknown,
): value is PromptSlotDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const schema = record.schema;
  return (
    typeof record.name === "string" &&
    PROMPT_SLOT_NAME_PATTERN.test(record.name) &&
    typeof record.description === "string" &&
    typeof record.required === "boolean" &&
    schema !== null &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    isJsonValue(schema) &&
    (!Object.prototype.hasOwnProperty.call(record, "defaultValue") ||
      isJsonValue(record.defaultValue))
  );
}

export function formatPromptSlotToken(name: string): string {
  if (!PROMPT_SLOT_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid prompt slot name "${name}".`);
  }
  return `{{slot:${name}}}`;
}

export function parsePromptSlotTokens(text: string): ParsedPromptSlotToken[] {
  const pattern = new RegExp(PROMPT_SLOT_TOKEN_SOURCE, "g");
  return [...text.matchAll(pattern)].map((match) => ({
    raw: match[0],
    start: match.index,
    end: match.index + match[0].length,
    name: match[1]!,
  }));
}

export function containsMalformedPromptSlotToken(text: string): boolean {
  const candidates = [
    ...text.matchAll(new RegExp(PROMPT_SLOT_TOKEN_CANDIDATE_SOURCE, "g")),
  ];
  if (
    candidates.some(
      (match) => !PROMPT_SLOT_NAME_PATTERN.test(match[1] ?? ""),
    )
  ) {
    return true;
  }
  const withoutCompleteTokens = text.replace(
    new RegExp(PROMPT_SLOT_TOKEN_CANDIDATE_SOURCE, "g"),
    "",
  );
  return /\{\{\s*slot\s*:/i.test(withoutCompleteTokens);
}

export function formatPromptDataToken(
  reference: WorkflowDataReferenceV2,
): string {
  if (!isPromptDataReference(reference)) {
    throw new Error(`Invalid prompt data reference "${reference}".`);
  }
  return `{{data:${reference}}}`;
}

export function parsePromptDataTokens(text: string): ParsedPromptDataToken[] {
  const pattern = new RegExp(PROMPT_DATA_TOKEN_CANDIDATE_SOURCE, "g");
  const tokens: ParsedPromptDataToken[] = [];
  for (const match of text.matchAll(pattern)) {
    const reference = match[1];
    if (!isPromptDataReference(reference)) continue;
    tokens.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      reference,
    });
  }
  return tokens;
}

export function containsMalformedPromptDataToken(text: string): boolean {
  const candidates = [
    ...text.matchAll(new RegExp(PROMPT_DATA_TOKEN_CANDIDATE_SOURCE, "g")),
  ];
  if (
    candidates.some((match) => !isPromptDataReference(match[1]))
  ) {
    return true;
  }
  const withoutCompleteTokens = text.replace(
    new RegExp(PROMPT_DATA_TOKEN_CANDIDATE_SOURCE, "g"),
    "",
  );
  return /\{\{\s*data\s*:/i.test(withoutCompleteTokens);
}
