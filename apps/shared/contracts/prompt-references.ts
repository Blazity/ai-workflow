export type PromptReferenceSelector = "latest" | number;

export interface PromptReference {
  promptId: number;
  version: PromptReferenceSelector;
}

export interface ParsedPromptReference extends PromptReference {
  raw: string;
  start: number;
  end: number;
}

export interface ResolvedPromptReference {
  promptId: number;
  promptName: string;
  requestedVersion: PromptReferenceSelector;
  resolvedVersion: number;
  bodyHash: string;
}

const PROMPT_REFERENCE_SOURCE = String.raw`\{\{prompt:([1-9]\d*)(?:@(latest|[1-9]\d*))?\}\}`;

export function formatPromptReferenceToken(reference: PromptReference): string {
  return reference.version === "latest"
    ? `{{prompt:${reference.promptId}}}`
    : `{{prompt:${reference.promptId}@${reference.version}}}`;
}

export function parsePromptReferenceTokens(text: string): ParsedPromptReference[] {
  const pattern = new RegExp(PROMPT_REFERENCE_SOURCE, "g");
  const references: ParsedPromptReference[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const selector = match[2];
    references.push({
      raw,
      start: match.index,
      end: match.index + raw.length,
      promptId: Number(match[1]),
      version: selector === undefined || selector === "latest" ? "latest" : Number(selector),
    });
  }
  return references;
}

export function containsMalformedPromptReference(text: string): boolean {
  const withoutValidReferences = text.replace(new RegExp(PROMPT_REFERENCE_SOURCE, "g"), "");
  return /\{\{\s*prompt\s*:/i.test(withoutValidReferences);
}
