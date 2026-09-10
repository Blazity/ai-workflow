/** Stable fallback and filename lookup over the built-in prompt registry. */
import {
  DEFAULT_IMPLEMENT_PROMPT,
  DEFAULT_RESEARCH_PLAN_PROMPT,
  DEFAULT_REVIEW_PROMPT,
} from "./default-prompts";

const researchPlanPrompt = DEFAULT_RESEARCH_PLAN_PROMPT;
const implementPrompt = DEFAULT_IMPLEMENT_PROMPT;
const reviewPrompt = DEFAULT_REVIEW_PROMPT;

export const PROMPT_NAMES = ["research-plan", "implement", "review"] as const;
export type PromptName = typeof PROMPT_NAMES[number];

/** Fallback strings keyed by prompt name (no `.md` suffix). */
export const PROMPT_FALLBACKS: Record<PromptName, string> = {
  "research-plan": researchPlanPrompt,
  "implement": implementPrompt,
  "review": reviewPrompt,
};

const prompts: Record<string, string> = {
  "research-plan.md": researchPlanPrompt,
  "implement.md": implementPrompt,
  "review.md": reviewPrompt,
};

export function getPrompt(name: string): string {
  const content = prompts[name];
  if (!content) throw new Error(`Unknown prompt: ${name}`);
  return content;
}
