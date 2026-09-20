/**
 * The open vocabularies of agent visibility.
 *
 * THE WORKER AND THE DASHBOARD DEPLOY SEPARATELY, so every set that can grow is
 * an open slug on the read side: a value this build does not know parses, and a
 * renderer shows it as itself. Each list below is what a renderer can label
 * today, never what a reader accepts. A closed enum here would turn the first
 * new repository state into a dashboard that cannot open any briefing at all.
 */
import { z } from "zod";
import { BUILTIN_HARNESS_PROFILE_IDS, REPOSITORY_RELATIONSHIP_KINDS } from "@shared/contracts";

/** Lower case, starts with a letter, then letters, digits, `_`, `.` or `-`. */
export const VISIBILITY_SLUG_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
export const visibilitySlugSchema = z.string().regex(VISIBILITY_SLUG_PATTERN, {
  message: "must be a lower-case slug: a letter, then letters, digits, _, . or -, at most 64",
});

/** True when a renderer has a label for this value; false means show it as it is. */
export function isKnownSlug<T extends string>(known: readonly T[], value: string): value is T {
  return (known as readonly string[]).includes(value);
}

/**
 * Which kind of send a briefing records. Closed on the WRITE side (the builder
 * refuses anything else), open on the read side.
 *
 * `discovery` decides which repositories a run uses; `agent` is every pass of
 * every sandboxed agent block; `llm` is an in-process model call (`call_llm`,
 * `investigate`).
 */
export const AGENT_BRIEFING_KINDS = ["discovery", "agent", "llm"] as const;
export type AgentBriefingKind = (typeof AGENT_BRIEFING_KINDS)[number];

/**
 * What a section IS. The first five are the compiler's own kinds
 * (`packages/prompts/effective-prompt.ts`). `discovery` is the discovery
 * prompt, which goes through no compiler; `system` is the system prompt of an
 * in-process model call.
 */
export const AGENT_BRIEFING_SECTION_KINDS = [
  "profile",
  "repository",
  "memory",
  "block",
  "runtime",
  "discovery",
  "system",
] as const;

/**
 * The storage budget cuts these first, because each carries provenance that
 * identifies its source (the profile version, the file, the memory document):
 * a person can find the text again from its identity. Run data has no other
 * copy and goes last (`RUN_DATA_SECTION_KINDS`); everything else sits between.
 */
export const PROVENANCE_SECTION_KINDS = ["profile", "repository", "memory"] as const;
export const RUN_DATA_SECTION_KINDS = ["runtime", "discovery"] as const;

/**
 * Where a part's text came from. `platform` is our own rule text; the section
 * kinds name the one part a section without explicit parts gets. The prompt
 * composer defines the rest (ticket, comments, answers, research notes...).
 */
export const AGENT_BRIEFING_ORIGIN_KINDS = ["platform", ...AGENT_BRIEFING_SECTION_KINDS] as const;

/**
 * Why text of a part was removed before the model received it.
 * `section_cap`: the compiler cuts a section at 200,000 characters.
 * `clarification_budget`: the composer shortens the clarification rounds it
 * puts in a prompt to their 16,000 character budget. Both are losses the
 * agent really had, unlike a storage cut.
 */
export const AGENT_BRIEFING_CUT_CAUSES = ["section_cap", "clarification_budget"] as const;

/**
 * Stripped control characters (ANSI sequences, NUL and the like), removed so
 * the stored text passes the MCP result sanitizer unchanged. Counted per part
 * rather than listed, because a CI trace holds thousands of them.
 */
export const CONTROL_CHARACTERS_REDACTION_KIND = "control_characters";

/**
 * What removed text from a stored copy: the replay sanitizer's classes, plus
 * stripped control characters.
 */
export const AGENT_BRIEFING_REDACTION_KINDS = [
  "configured_secret",
  "token",
  "jwt",
  "private_key",
  "credential_url",
  "email",
  "phone",
  "payment_card",
  "iban",
  "payment_identifier",
  "control_characters",
] as const;

/** The harness providers a briefing names today. */
export const AGENT_BRIEFING_PROVIDERS = Object.keys(BUILTIN_HARNESS_PROFILE_IDS) as readonly string[];

/**
 * How a repository could be used by this send. `write`, `read_only` and
 * `offered` are usable; every other known state carries a reason, because "you
 * may not touch this" without a why is the sentence that sends a person to the
 * wrong screen.
 *
 * `disabled` and `unusable` are two values on purpose, the distinction the work
 * scope contract already keeps between `outside_catalog` and `unusable`
 * (`packages/contracts/work-scope.ts`): somebody switched a repository off
 * here, and the provider offered nothing this run could check out, are
 * different facts with different remedies. Sending an operator to the
 * Repositories page for the second one costs them a round to discover the
 * switch is already on.
 */
export const REPOSITORY_STATES = [
  "write",
  "read_only",
  "offered",
  "excluded",
  "disabled",
  "not_enabled",
  "unusable",
  "outside_catalog",
  // This run asked for it and was refused for a reason that holds for the rest
  // of the run. Not `excluded`: nobody decided anything about this repository,
  // the run's own rules closed the door, and sending a person to the
  // Repositories page to undo a decision that was never made wastes their time.
  "refused",
] as const;
export const USABLE_REPOSITORY_STATES = ["write", "read_only", "offered"] as const;

/**
 * Why a repository is in the context at all.
 *
 * `named`: the ticket or event text names it. `event_repository`: the event
 * happened on it. `attached`: a person attached it to the run. `related`: a
 * relationship from another repository in the context (see `via`).
 * `offered_by_question`: a question put it in front of a person.
 * `chosen_by_workflow`: a person handed the decision back and the workflow
 * took it. `work_scope_entry`: the record has an entry for it. `catalog`: it is
 * listed because it is in the enabled catalog (discovery, the map's one-line
 * entries).
 */
export const REPOSITORY_INCLUSION_CAUSES = [
  "named",
  "event_repository",
  "attached",
  "related",
  "offered_by_question",
  "chosen_by_workflow",
  "work_scope_entry",
  "catalog",
] as const;

/** Whether the map gave a repository its full entry or one line. */
export const REPOSITORY_RENDERINGS = ["full", "line"] as const;

/** Whose words the description is: the operator's catalog profile, the
 *  provider's listing text, or nothing. */
export const REPOSITORY_DESCRIPTION_SOURCES = ["catalog", "provider", "none"] as const;

/** The catalog's relationship vocabulary, read back as slugs. */
export const REPOSITORY_RELATIONSHIP_KIND_NAMES = REPOSITORY_RELATIONSHIP_KINDS.map(
  (entry) => entry.kind,
) as readonly string[];

/** Why a join key was not stored: longer than a page can carry, or holding
 *  something the detector reports (a secret, a token, a control character),
 *  which may not be stored and which MCP would rewrite at serve time. */
export const WITHHELD_KEY_REASONS = ["too_long", "redacted"] as const;

/** Why a briefing that should exist was not recorded. */
export const NOT_RECORDED_CAUSES = ["predates_capture", "capture_disabled", "capture_skipped"] as const;

/** The read model maps each clarification row to one of these; a question a
 *  retried attempt wrote again joins its round, whose status is the latest
 *  ask's. `resume_failed`: the answer was taken and the run could not resume;
 *  `superseded`: a later question replaced this one. */
export const CLARIFICATION_ROUND_STATUSES = [
  "pending",
  "answered",
  "expired",
  "cancelled",
  "resume_failed",
  "superseded",
] as const;
export const CLARIFICATION_DELIVERY_SURFACES = ["jira", "dashboard", "mcp", "other"] as const;
/** `several_people`: the Jira path composed the answer out of several people's
 *  comments, so it is nobody's decision alone. */
export const CLARIFICATION_AUTHOR_KINDS = ["person", "several_people"] as const;
