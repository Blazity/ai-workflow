export type PromptReferenceSelector = "latest" | number;

/** Canonical reference target: the prompt's immutable, human-readable slug
 *  (e.g. "research-plan"). Slugs are assigned at create time and never change
 *  on rename, so tokens embedded in workflow definitions stay valid. */
export interface PromptReference {
  slug: string;
  version: PromptReferenceSelector;
}

/** A reference token found in authored text. New tokens always target a slug;
 *  `legacyPromptId` is set instead when the token uses the pre-slug numeric
 *  form ({{prompt:7}}), which the runtime still resolves for definitions
 *  saved before slugs existed. Exactly one of `slug` / `legacyPromptId` is set. */
export interface ParsedPromptReference {
  raw: string;
  start: number;
  end: number;
  version: PromptReferenceSelector;
  slug?: string;
  legacyPromptId?: number;
}

export interface ResolvedPromptReference {
  promptId: number;
  promptName: string;
  requestedVersion: PromptReferenceSelector;
  resolvedVersion: number;
  bodyHash: string;
}

export const PROMPT_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const PROMPT_REFERENCE_SOURCE = String.raw`\{\{prompt:([a-z][a-z0-9-]{0,63}|[1-9]\d*)(?:@(latest|[1-9]\d*))?\}\}`;

export function formatPromptReferenceToken(reference: PromptReference): string {
  return reference.version === "latest"
    ? `{{prompt:${reference.slug}}}`
    : `{{prompt:${reference.slug}@${reference.version}}}`;
}

export function parsePromptReferenceTokens(text: string): ParsedPromptReference[] {
  const pattern = new RegExp(PROMPT_REFERENCE_SOURCE, "g");
  const references: ParsedPromptReference[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const target = match[1];
    const selector = match[2];
    references.push({
      raw,
      start: match.index,
      end: match.index + raw.length,
      version: selector === undefined || selector === "latest" ? "latest" : Number(selector),
      ...(/^\d+$/.test(target)
        ? { legacyPromptId: Number(target) }
        : { slug: target }),
    });
  }
  return references;
}

export function containsMalformedPromptReference(text: string): boolean {
  const withoutValidReferences = text.replace(new RegExp(PROMPT_REFERENCE_SOURCE, "g"), "");
  return /\{\{\s*prompt\s*:/i.test(withoutValidReferences);
}

/** True when the token points at the given library row (slug for new tokens,
 *  numeric id for legacy ones). */
export function promptReferenceMatchesRow(
  reference: Pick<ParsedPromptReference, "slug" | "legacyPromptId">,
  row: { id: number; slug: string },
): boolean {
  return reference.slug !== undefined
    ? row.slug === reference.slug
    : row.id === reference.legacyPromptId;
}

/** Short human label for a reference whose row is unknown/missing. */
export function promptReferenceTargetLabel(
  reference: Pick<ParsedPromptReference, "slug" | "legacyPromptId">,
): string {
  return reference.slug ?? `#${reference.legacyPromptId}`;
}

/** Derives a slug candidate from a prompt name: lowercase kebab-case, letters
 *  first (a leading digit gets a "p-" prefix), capped at 64 chars. Uniqueness
 *  is the caller's job (suffixing happens against the live library). */
export function slugifyPromptName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const prefixed = /^[a-z]/.test(base) ? base : base.length > 0 ? `p-${base}` : "prompt";
  return prefixed.slice(0, 64).replace(/-+$/g, "");
}
