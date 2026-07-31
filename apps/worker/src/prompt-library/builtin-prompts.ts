import { DEFAULT_AGENT_PROMPTS } from "@shared/contracts";

export type BuiltInPromptName = keyof typeof DEFAULT_AGENT_PROMPTS;

/**
 * The prompt_library.slug each built-in registry name was seeded under.
 *
 * The two identifiers are independent and must never be substituted for each
 * other. A registry name is the DEFAULT_AGENT_PROMPTS key and is user-visible
 * and renameable (updatePromptMeta allows meta edits on a built-in); a slug is
 * assigned once and is what a {{prompt:<slug>@N}} token resolves through. They
 * happen to be equal today only because migration 0021 seeded slug = name.
 *
 * Keeping the mapping here means the resync generator and the drift check read
 * the same table: if a built-in is ever renamed, both move together instead of
 * one of them silently failing to match.
 */
export const BUILT_IN_PROMPT_SLUG_BY_NAME: Record<BuiltInPromptName, string> = {
  "research-plan": "research-plan",
  implement: "implement",
  review: "review",
};

const NAME_BY_SLUG = new Map<string, BuiltInPromptName>(
  (Object.keys(BUILT_IN_PROMPT_SLUG_BY_NAME) as BuiltInPromptName[]).map(
    (name) => [BUILT_IN_PROMPT_SLUG_BY_NAME[name], name],
  ),
);

/** The built-in registry name a slug belongs to, or null when the slug is not a
 *  built-in at all (a prompt the customer created). */
export function builtInPromptNameForSlug(slug: string): BuiltInPromptName | null {
  return NAME_BY_SLUG.get(slug) ?? null;
}

/** The shipped body for a slug, or null when the slug is not a built-in. */
export function builtInPromptBodyForSlug(slug: string): string | null {
  const name = builtInPromptNameForSlug(slug);
  return name === null ? null : DEFAULT_AGENT_PROMPTS[name];
}
