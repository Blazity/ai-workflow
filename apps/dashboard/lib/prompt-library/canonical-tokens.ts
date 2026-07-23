import {
  isPromptDataReference,
  PROMPT_SLOT_NAME_PATTERN,
} from "@shared/contracts";

export type CanonicalPromptTokenKind = "data" | "prompt" | "slot";

export interface CanonicalPromptToken {
  kind: CanonicalPromptTokenKind;
  raw: string;
  value: string;
  label: string;
  start: number;
  end: number;
}

const DATA_TOKEN = /^\{\{data:([^{}]+)\}\}/;
const PROMPT_TOKEN =
  /^\{\{prompt:([a-z][a-z0-9-]{0,63})@([1-9]\d*)\}\}/;
const SLOT_TOKEN = /^\{\{slot:([^{}]+)\}\}/;

function dataLabel(reference: string): string {
  if (reference.startsWith("run.")) {
    return `Run · ${reference.slice(4).replaceAll(".", " · ")}`;
  }
  const parts = reference.split(".");
  const source = parts[1] === "entry" ? "Trigger" : parts[1];
  return `${source} · ${parts.slice(3).join(" · ")}`;
}

export function parseCanonicalPromptToken(
  source: string,
  start = 0,
): CanonicalPromptToken | null {
  const candidate = source.slice(start);
  const data = candidate.match(DATA_TOKEN);
  if (data && isPromptDataReference(data[1])) {
    return {
      kind: "data",
      raw: data[0],
      value: data[1],
      label: dataLabel(data[1]),
      start,
      end: start + data[0].length,
    };
  }
  const prompt = candidate.match(PROMPT_TOKEN);
  if (prompt) {
    return {
      kind: "prompt",
      raw: prompt[0],
      value: `${prompt[1]}@${prompt[2]}`,
      label: `${prompt[1]} · v${prompt[2]}`,
      start,
      end: start + prompt[0].length,
    };
  }
  const slot = candidate.match(SLOT_TOKEN);
  if (slot && PROMPT_SLOT_NAME_PATTERN.test(slot[1])) {
    return {
      kind: "slot",
      raw: slot[0],
      value: slot[1],
      label: slot[1],
      start,
      end: start + slot[0].length,
    };
  }
  return null;
}

function backtickRun(source: string, start: number): number {
  let end = start;
  while (source[end] === "`") end += 1;
  return end - start;
}

function fencedCodeAt(source: string, start: number): string | null {
  const lineStart = start === 0 || source[start - 1] === "\n";
  if (!lineStart) return null;
  const line = source.slice(start).match(/^( {0,3})(`{3,}|~{3,})/);
  return line?.[2] ?? null;
}

/** Finds canonical tokens while leaving inline and fenced Markdown code literal. */
export function findCanonicalPromptTokens(
  markdown: string,
): CanonicalPromptToken[] {
  const tokens: CanonicalPromptToken[] = [];
  let index = 0;
  let fence: string | null = null;

  while (index < markdown.length) {
    const maybeFence = fencedCodeAt(markdown, index);
    if (maybeFence) {
      if (fence === null) {
        fence = maybeFence;
      } else if (
        maybeFence[0] === fence[0] &&
        maybeFence.length >= fence.length
      ) {
        fence = null;
      }
      const newline = markdown.indexOf("\n", index);
      index = newline === -1 ? markdown.length : newline + 1;
      continue;
    }
    if (fence !== null) {
      const newline = markdown.indexOf("\n", index);
      index = newline === -1 ? markdown.length : newline + 1;
      continue;
    }

    if (markdown[index] === "`") {
      const length = backtickRun(markdown, index);
      const delimiter = "`".repeat(length);
      const close = markdown.indexOf(delimiter, index + length);
      index = close === -1 ? index + length : close + length;
      continue;
    }

    if (markdown.startsWith("{{", index)) {
      const token = parseCanonicalPromptToken(markdown, index);
      if (token) {
        tokens.push(token);
        index = token.end;
        continue;
      }
    }
    index += 1;
  }
  return tokens;
}

export function promptTokenNodeAttributes(raw: string): {
  kind: CanonicalPromptTokenKind;
  token: string;
  value: string;
  label: string;
} | null {
  const parsed = parseCanonicalPromptToken(raw);
  if (!parsed || parsed.end !== raw.length) return null;
  return {
    kind: parsed.kind,
    token: parsed.raw,
    value: parsed.value,
    label: parsed.label,
  };
}
