import { PROMPT_FALLBACKS } from "../lib/prompts.js";

export interface LoadedPrompts {
  research: string;
  implement: string;
  review: string;
}

export async function loadPrompts(): Promise<LoadedPrompts> {
  "use step";
  // Prompts are first-party: the in-code defaults (mirrored from
  // @shared/contracts via PROMPT_FALLBACKS) are the single source of truth.
  // Per-block prompt overrides are applied elsewhere in the graph.
  return {
    research: PROMPT_FALLBACKS["research-plan"],
    implement: PROMPT_FALLBACKS["implement"],
    review: PROMPT_FALLBACKS["review"],
  };
}
loadPrompts.maxRetries = 0;
