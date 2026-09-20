/**
 * Every bound in this package, in one place, so a reader, a writer and a test
 * cite the same number.
 *
 * A bound on free text is a bound on what a READER accepts: the builder and
 * the round assembler clamp longer text to it and say so (`clampText`). They
 * refuse only broken structure, because a briefing refused over a long title
 * would reach a person as "not recorded" about a prompt that was sent.
 */

/** Bumped when the meaning of a stored or served shape changes. A reader given
 *  a higher number says the record was written by a newer version instead of
 *  guessing at it (`readVisibilityRecord`). */
export const AGENT_VISIBILITY_SCHEMA_VERSION = 1 as const;

/** The plan's 512 KB per briefing, applied to the stored section texts. The
 *  caller passes the budget in; this is the value it passes by default. */
export const AGENT_BRIEFING_DEFAULT_BUDGET_BYTES = 512 * 1024;
/** Ceiling on the budget a caller may pass. */
export const AGENT_BRIEFING_MAX_BUDGET_BYTES = 16 * 1024 * 1024;
/**
 * The hard ceiling on one stored index (everything but the texts), as JSON.
 *
 * What one briefing can store before content addressing shares anything, as
 * the first pass of an attempt does: its section texts (the budget, 512 KiB by
 * default and 16 MiB at most), this index (512 KiB) and one repository context
 * document (1 MiB). That is 2 MiB at the default budget and 17.5 MiB at the
 * largest; later passes that repeat the ticket, the instructions and the map
 * add only what changed.
 *
 * A planning pass with 150 sections' worth of metadata and hundreds of parts
 * lands far below it. Over it, section and part titles, origins and withheld
 * rules are shortened to one common length first, then sections list fewer
 * redaction spans; only an index with more parts than can be described at all
 * is refused.
 */
export const AGENT_BRIEFING_INDEX_MAX_BYTES = 512 * 1024;
/**
 * The ceiling on one repository context document, as JSON. It is stored once
 * per distinct content, so six planning passes that saw the same map store it
 * once. 150 repositories with 5 KB profiles fit whole; over it, descriptions,
 * rules and reasons are shortened alike.
 */
export const AGENT_BRIEFING_CONTEXT_MAX_BYTES = 1024 * 1024;
/**
 * Ceiling on what a section claims it was when sent. The compiler cuts a
 * section at 200,000 UTF-16 units, but discovery and `call_llm` prompts go
 * through no compiler. It exists so a corrupt size is refused rather than
 * turned into a paging loop that never ends.
 */
export const AGENT_BRIEFING_SENT_BYTES_MAX = 64 * 1024 * 1024;
/** A workspace holds at most 8 repositories, each giving up to 13 instruction
 *  sections and 2 memory documents, which is about 130 with the rest. */
export const AGENT_BRIEFING_SECTIONS_MAX = 200;
/** Runtime data split into ticket, comments, answers, threads, CI and notes. */
export const AGENT_BRIEFING_PARTS_PER_SECTION_MAX = 1_000;
/**
 * Provenance entries a section lists; `provenanceCount` counts them all. A
 * block section's provenance is its prompt manifest, every prompt its fields
 * include, nested to depth 10, so nine or more is ordinary.
 *
 * Sixteen is what a worst-case section header holds on the default page: each
 * entry is at most a 64-character kind, a key of
 * `AGENT_VISIBILITY_JOIN_KEY_MAX_BYTES`, a 128-character hash and a version,
 * about 2.3 KB as JSON, so sixteen are about 37 KB beside a title of at most
 * 1.2 KB, under the 48 KB page.
 */
export const AGENT_BRIEFING_PROVENANCE_MAX = 16;
/**
 * Redaction spans a section lists; `redactionCount` counts them all and
 * `redactionListComplete` says whether every marker in the stored text is
 * listed. A ticket with a few hundred email addresses stays well under it; a
 * CI trace with thousands of tokens can pass it, and its markers past the
 * list cannot be told from text a person typed. The spans are served as a
 * list of their own. Stripped control characters are counted per part, never
 * listed.
 */
export const AGENT_BRIEFING_SECTION_SPANS_MAX = 2_048;
/** Sends one Block Attempt may record. A guard against a runaway loop, far
 *  above any pass count the planning block produces. */
export const AGENT_BRIEFING_SEQUENCE_MAX = 10_000;

/** A run id, node id, activation scope id, clarification id or block type. */
export const AGENT_VISIBILITY_ID_MAX_LENGTH = 200;
/** A repository key as a reader accepts it. */
export const AGENT_VISIBILITY_KEY_MAX_LENGTH = 256;
/** A section, part or pass title: one line. */
export const AGENT_VISIBILITY_TITLE_MAX_LENGTH = 200;
/** An origin ref or label, a model id, a harness profile id. */
export const AGENT_VISIBILITY_LABEL_MAX_LENGTH = 200;
/**
 * A join key (a provenance id, a harness profile id) is stored whole up to
 * this many bytes of its JSON spelling, which is what it costs on a page.
 * A provenance id is `promptId:promptName` and a prompt's name has no bound
 * when it is written. A longer key is never cut: the entry is kept, its key
 * withheld as its length and sha256 (`idWithheld`, reason `too_long`), so a
 * reader holding the key can still match it. A key the detector reports is
 * withheld the same way (reason `redacted`).
 */
export const AGENT_VISIBILITY_JOIN_KEY_MAX_BYTES = 2_048;
/** A skill id. */
export const AGENT_VISIBILITY_SKILL_ID_MAX_LENGTH = 100;
/** A sentence: a withheld reason, a state's reason, a failure message. */
export const AGENT_VISIBILITY_MESSAGE_MAX_LENGTH = 2_000;
/** ISO 8601 with milliseconds and an offset is 29 characters. */
export const AGENT_VISIBILITY_TIMESTAMP_MAX_LENGTH = 40;
/** A hash as the compiler spells it (sha256 hex today): letters, digits and
 *  `+/=:._-`, at most this many. */
export const AGENT_VISIBILITY_HASH_MAX_LENGTH = 128;

/** Pinned skills a briefing lists (`skillCount` counts them all). */
export const AGENT_BRIEFING_SKILLS_MAX = 16;
/** Unresolved sources a briefing lists (`unresolvedSourceCount` counts them
 *  all). They are served as a list of their own, not in the overview. */
export const AGENT_BRIEFING_UNRESOLVED_SOURCES_MAX = 16;
export const AGENT_BRIEFING_UNRESOLVED_REFERENCE_MAX_LENGTH = 200;
export const AGENT_BRIEFING_UNRESOLVED_MESSAGE_MAX_LENGTH = 300;

/** Repositories (and left-out keys) a context document lists, and
 *  relationships one repository lists. Discovery is offered the enabled
 *  catalog, so this is the order of magnitude of a deployment's catalog, not
 *  of a workspace. A larger catalog is listed from the start and counted
 *  (`repositoryCount`, `leftOutCount`, `relationshipCount`), never refused. */
export const AGENT_BRIEFING_REPOSITORIES_MAX = 1_000;
export const AGENT_BRIEFING_RELATIONSHIPS_MAX = 100;
/** A catalog description or rules field holds 20,000 characters
 *  (`REPOSITORY_CATALOG_MARKDOWN_MAX_LENGTH`); the slack is for redaction
 *  markers and the clamp note. */
export const AGENT_BRIEFING_REPOSITORY_TEXT_MAX_LENGTH = 24_000;

/** A round lists its first ask and its newest ones, and counts all of them. */
export const CLARIFICATION_ROUND_ASKS_MAX = 16;
/** Questions one round lists (`questionCount` counts them all), and the length
 *  of each. */
export const CLARIFICATION_ROUND_QUESTIONS_MAX = 10;
/** Repositories one question offered. The write contract allows 8
 *  (`WORK_SCOPE_ASKED_REPOSITORIES_MAX`); a reader leaves room to grow. */
export const CLARIFICATION_ROUND_OFFERED_MAX = 16;
/** Keys and names one reading of an answer lists. The write contract allows 8
 *  keys and 4 unoffered names. */
export const CLARIFICATION_READING_KEYS_MAX = 16;
export const CLARIFICATION_QUESTION_MAX_LENGTH = 4_000;
/** Words of one delivery and the note posted back. The answer channels accept
 *  10,000 characters; the Jira path composes several comments into one. */
export const CLARIFICATION_WORDS_MAX_LENGTH = 20_000;
export const CLARIFICATION_NOTE_MAX_LENGTH = 4_000;

/**
 * Page sizes, in UTF-8 bytes of the page serialized as JSON.
 *
 * The default sits below what MCP clients show inline (Claude Code saves a
 * larger result to a file instead of showing it). The ceiling is the server's
 * `MCP_MAX_RESULT_BYTES` default (`packages/contracts/settings-registry.ts`),
 * above which the whole result becomes a digest. The floor is what one
 * shortened item and the page envelope need.
 */
export const AGENT_VISIBILITY_PAGE_DEFAULT_BYTES = 48 * 1024;
export const AGENT_VISIBILITY_PAGE_MIN_BYTES = 1_024;
export const AGENT_VISIBILITY_PAGE_MAX_BYTES = 524_288;
