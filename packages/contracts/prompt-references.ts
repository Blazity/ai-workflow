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
