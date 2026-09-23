/**
 * Work scope: the one durable record, per subject of work, of which
 * repositories that work touches and why, the decision trail it folds from,
 * and the repository policy a trigger node carries.
 *
 * Shared rather than worker-owned because the worker writes the record, the
 * MCP surface reads the trail, and the dashboard edits both the record and the
 * trigger policy. The dashboard cannot import the engine, so the two pure
 * functions that turn a trigger's configuration into its effective policy live
 * here with the shapes they read.
 *
 * Nothing here has a default. A default on the trigger field would change the
 * canonical JSON, and with it the graph hash, of every stored definition the
 * next time it is saved.
 */
import { z } from "zod";
import type { WorkflowBlockType } from "./block-catalog.generated";
import type { WorkflowRepositoryScope } from "./domain";
import { INTEGRATION_ID } from "./integration-id";
import {
  REPOSITORY_CATALOG_LABEL_MAX_LENGTH,
  REPOSITORY_CATALOG_PATH_PATTERN,
  repositoryCatalogKey,
} from "./repository-catalog";
import type { PrTriggerType } from "./trigger-events";

export const WORK_SCOPE_RATIONALE_MAX_LENGTH = 500;
const WORK_SCOPE_MAP_TEXT_MAX_LENGTH = 1600;
const TRIGGER_POLICY_LISTED_KEYS_MAX = 50;
export const WORK_SCOPE_EDIT_CHANGES_MAX = 16;
/** One page of the trail, and the ceiling the store itself enforces on a page.
 *  Published because both surfaces that read the record bound their own page
 *  parameter before the store is asked. */
export const WORK_SCOPE_TRAIL_PAGE_DEFAULT = 50;
export const WORK_SCOPE_TRAIL_PAGE_MAX = 200;
/**
 * The ceiling on a version and on a trail id.
 *
 * `work_scopes.version` is an `integer` and `work_scope_trail.id` a `serial`, so
 * both are int4: a larger number names nothing the store could ever hold, and
 * sending it reaches the driver as a numeric overflow rather than as the
 * conflict or the empty page it deserves. On HTTP that is a 500 where a 409
 * belongs, and on MCP it burns an idempotency key on input alone, so both
 * surfaces refuse it here instead.
 */
export const WORK_SCOPE_INT4_MAX = 2_147_483_647;
/** A subject key is generated from a ticket key, a pull request path, or a
 *  webhook endpoint and subject id (`engine/support/subject-key.ts`); the
 *  longest of those is a nested GitLab path with a number on it. */
export const WORK_SCOPE_SUBJECT_KEY_MAX_LENGTH = 400;
/**
 * Every subject kind a key can name, in the spelling `subject-key.ts` writes.
 *
 * The list, not a pattern: what follows the kind differs per kind and a pattern
 * loose enough to cover all of them would accept anything with a colon in it.
 * A subset of these keeps a work scope record (`services/work-scope/record.ts`),
 * which is a different question and stays where it is.
 */
export const WORK_SCOPE_SUBJECT_KINDS = [
  "ticket:",
  "pr:",
  "webhook:",
  "schedule:",
  "repo:",
  "org:",
] as const;

/**
 * One spelling of a subject key for every surface that takes one, so the read
 * and the write cannot accept different keys for the same record.
 *
 * A KEY THAT NAMES NO SUBJECT KIND IS REFUSED, and that is not pedantry about
 * shapes. The read answers `carriesRecord: false` with an empty record for a
 * subject kind that legitimately keeps none, and until this refusal existed it
 * answered a mistyped key exactly the same way. Production, 2026-09-20: a
 * caller asked for `AWP-261` instead of `ticket:jira:AWP-261`, was handed a
 * confident empty record for a ticket whose record holds four decisions, and
 * nearly reported it as a lost record. A typo is worth one error; an empty
 * record that looks like an answer is worth an hour.
 */
export const workScopeSubjectKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(WORK_SCOPE_SUBJECT_KEY_MAX_LENGTH)
  .refine(
    (key) => WORK_SCOPE_SUBJECT_KINDS.some((kind) => key.startsWith(kind)),
    {
      // No example key, for the reason the repository key gives none: this
      // package may not read the registry, so any provider it wrote would be a
      // guess, and a reader copies an example back verbatim.
      message: `subjectKey must start with a subject kind (${WORK_SCOPE_SUBJECT_KINDS.join(" ")}), then the provider id and the subject, exactly as a run and its work scope record print it`,
    },
  );
const WORK_SCOPE_WRITE_PLAN_KEYS_MAX = 16;
const WORK_SCOPE_WRITE_PLAN_TRAIL_MAX = 32;
const WORK_SCOPE_ASKED_REPOSITORIES_MAX = 8;

export const WORK_SCOPE_ENTRY_STATES = ["selected", "excluded", "unavailable"] as const;
export const workScopeEntryStateSchema = z.enum(WORK_SCOPE_ENTRY_STATES);
export type WorkScopeEntryState = z.infer<typeof workScopeEntryStateSchema>;

export const WORK_SCOPE_UNAVAILABLE_REASONS = ["not_enabled", "unusable"] as const;
export const workScopeUnavailableReasonSchema = z.enum(WORK_SCOPE_UNAVAILABLE_REASONS);
export type WorkScopeUnavailableReason = z.infer<typeof workScopeUnavailableReasonSchema>;

/** Why a question about a repository was raised, recorded at ask time,
 *  because a "none" answer means something different for each reason: not
 *  enabled or unusable are recorded as unavailable, outside policy as
 *  excluded, selection records nothing. */
export const WORK_SCOPE_ASK_REASONS = ["not_enabled", "unusable", "outside_policy", "selection"] as const;
export const workScopeAskReasonSchema = z.enum(WORK_SCOPE_ASK_REASONS);
export type WorkScopeAskReason = z.infer<typeof workScopeAskReasonSchema>;

/** The closed set of origins. Precedence is NOT this order: it is declared
 *  per origin in `WORK_SCOPE_ORIGIN_RANKS`. */
export const WORK_SCOPE_ORIGINS = [
  "person",
  /**
   * THE WORKFLOW CHOSE, BECAUSE A PERSON ASKED IT TO.
   *
   * "whatever you think is best" is an answer, not a silence, and what it
   * decides is that we decide. The entry is therefore neither the person's own
   * naming (they named nothing, and recording it as theirs would put words in
   * their mouth) nor a guess (`inferred`, which every reader treats as no entry
   * at all: run start will not furnish a workspace from it, `isGuessEntry` lets
   * the next answer take it back, and the next guess may take the repository
   * again). Both readings are wrong about the same fact, so this is its own
   * origin, and the rationale names whoever asked.
   *
   * IT RANKS 0, TIED WITH A PERSON'S OWN WORD. It is a decision somebody asked
   * for, so nothing derived, no trigger policy and above all no guess may
   * overwrite it. The tie would also let it overwrite a person's own entry,
   * and that one overwrite is refused by the store (`overwriteAllowed` in
   * `apps/worker/src/db/repositories/work-scope.ts`): "you decide" is not
   * permission to undo what somebody decided themselves. The other direction
   * stays open, because a person who later names repositories outranks the
   * choice they once handed over, and that is exactly the way back they need.
   */
  "delegated",
  "workflow_owned_branch",
  "ticket_text",
  "trigger_policy",
  /**
   * THE CATALOG RELATES IT TO A REPOSITORY THIS WORK NAMES.
   *
   * An operator wrote on the Repositories page that A is the frontend for B; a
   * ticket names A; the run opens B as well, read only, without asking anybody.
   * That is a decision, and the Decision Trail exists to tell a person who
   * decided: `trigger_policy` would send them to the trigger, where they would
   * find nothing about relationships at all, and a rationale carrying the truth
   * that the origin denies is the hidden-decision shape this record exists to
   * end. So it is its own origin, and the rationale beside it names the source
   * repository and the relationship.
   *
   * IT IS RE-DERIVED, WHICH IS THE POINT OF NAMING IT. Only entries this origin
   * wrote are checked back against the catalog on the next run, and one whose
   * relationship the operator has since deleted is removed with a trail line
   * saying so. A repository that attaches itself forever after the reason was
   * taken away is worse than no automatic attachment, and an origin of its own
   * is what makes the re-check safe: nothing else gets re-checked against a
   * catalog it was never derived from.
   *
   * IT RANKS 3, TIED WITH `trigger_policy`. Both are a rule of this run taking
   * a repository in without asking, so neither outranks the other, and both are
   * outranked by every person, branch and ticket-text signal above. The tie is
   * the whole point of the number: what must never happen is `inferred` (4), a
   * guess, taking back a repository an operator's own recorded relationship put
   * here, and a rank below 4 is what stops it.
   */
  "related_repository",
  "inferred",
] as const;
export const workScopeOriginSchema = z.enum(WORK_SCOPE_ORIGINS);
export type WorkScopeOrigin = z.infer<typeof workScopeOriginSchema>;

/**
 * Precedence, lower wins. Persisted beside the entry as `origin_rank` so the
 * database itself can refuse a lower origin overwriting a higher one.
 *
 * A NUMBER DECLARED PER ORIGIN, NEVER A POSITION IN A LIST. Every stored row
 * carries the rank it was written with, and during a rollout the previous
 * deployment keeps writing its own numbers beside the new one's, so a rank
 * that moves inverts precedence between rows that already exist and between
 * two live deployments. A new origin gets a number of its own, a tie if it
 * must share one; an existing number never changes
 * (`work-scope-origin-ladder.test.ts` holds the five that predate `delegated`
 * to the values their rows carry). Typed against `WorkScopeOrigin`, so an
 * origin added to the list without a rank does not compile.
 */
export const WORK_SCOPE_ORIGIN_RANKS = {
  person: 0,
  delegated: 0,
  workflow_owned_branch: 1,
  ticket_text: 2,
  trigger_policy: 3,
  related_repository: 3,
  inferred: 4,
} as const satisfies Record<WorkScopeOrigin, number>;

/**
 * What an origin this build has never heard of is worth.
 *
 * The worker and the dashboard deploy separately, and a migration adds an
 * origin minutes before the code that knows it serves anything, so a reader
 * WILL meet a value that is not in its own list. Before this, the lookup
 * returned `undefined`, `undefined - number` was `NaN`, and the comparator that
 * ranks a subject's entries returned `NaN` for every pair involving that row:
 * the record came back in an order nobody could predict, which is the "blank"
 * failure, arriving as scrambled precedence rather than as an error.
 *
 * The weakest rank any origin carries, so an unknown origin sorts last and can
 * never be treated as outranking something this build does understand. Guessing
 * high would let a value we cannot reason about overwrite a person's decision.
 */
export const WORK_SCOPE_UNKNOWN_ORIGIN_RANK = 4;

/**
 * Total by construction: see `WORK_SCOPE_UNKNOWN_ORIGIN_RANK`.
 *
 * It takes a plain string because the callers that matter are readers of
 * stored rows rather than writers of new ones, and a reader's row may carry an
 * origin from a migration its own build predates. Writers stay honest through
 * `WORK_SCOPE_ORIGIN_RANKS` itself, which `satisfies Record<WorkScopeOrigin,
 * number>`: an origin added without a rank does not compile.
 */
export function workScopeOriginRank(origin: string): number {
  return (
    WORK_SCOPE_ORIGIN_RANKS[origin as WorkScopeOrigin] ?? WORK_SCOPE_UNKNOWN_ORIGIN_RANK
  );
}

export const WORK_SCOPE_REFUSAL_REASONS = [
  "outside_catalog",
  "outside_policy",
  // Enabled here, and the provider offered nothing this run could check out for
  // it. Deliberately NOT `outside_catalog`: that sentence says the repository is
  // off the catalog this run may use, which is false about a row sitting enabled
  // on the Repositories page, and a person sent there on the strength of it
  // finds it looking fine.
  "unusable",
  "excluded",
  // Read this one BESIDE `unusable` above, because the two names are close and
  // they mean different things. `unusable` is a fact about the provider right
  // now: it listed the repository and offered nothing to check out. This one is
  // a fact about the RECORD: an entry on this work already says the repository
  // was unavailable, whoever wrote it and whenever. One can be true without the
  // other, and the sentences a person reads say so.
  "unavailable",
  "workspace_cap",
  // More than three repositories were requested at once; the extras are
  // refused without a question.
  "request_limit",
  "rounds_exhausted",
  // A which-of-these question named the repository, the answer did not, and
  // nothing on the record has chosen it since: a guess, here the agent's own
  // request, may not take it back.
  "unnamed_in_answer",
] as const;
export const workScopeRefusalReasonSchema = z.enum(WORK_SCOPE_REFUSAL_REASONS);
export type WorkScopeRefusalReason = z.infer<typeof workScopeRefusalReasonSchema>;

function isRepositoryKey(key: string): boolean {
  const separator = key.indexOf(":");
  if (separator < 0) return false;
  const path = key.slice(separator + 1);
  return (
    // The id rule itself, not the provider schema: that one trims, and a key
    // is compared as the string it is, so "github :acme/api" would pass as a
    // key no catalog entry ever equals.
    INTEGRATION_ID.test(key.slice(0, separator)) &&
    path.length <= REPOSITORY_CATALOG_LABEL_MAX_LENGTH &&
    REPOSITORY_CATALOG_PATH_PATTERN.test(path)
  );
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** The normalised catalog key a run's frozen enabled list already carries:
 *  lower case "provider:path", where the provider is a registry id. The path
 *  follows the catalog's own rule, so a project in nested groups is a key on a
 *  provider whose paths nest, and a bare "owner/name" is never one. */
export const repositoryKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isRepositoryKey, {
    // NO EXAMPLE KEY HERE. This package may not read the registry, so any
    // example it wrote would name a provider by guess, and a reader copying
    // `provider:owner/name` sends a key naming a provider called `provider`.
    // The rule is stated instead, with the place real keys are printed.
    message:
      "repository key must be lower case: the repository's provider id, a colon, then its path, exactly as the repositories list and every run report print it",
  });
export type RepositoryKey = z.infer<typeof repositoryKeySchema>;

export const workScopeActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("person"),
      actorId: z.string().min(1),
      actorLabel: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("run"),
      runId: z.string().min(1),
      definitionId: z.number().int().positive(),
      definitionVersion: z.number().int().positive(),
      model: z.string().min(1).optional(),
    })
    .strict(),
]);
export type WorkScopeActor = z.infer<typeof workScopeActorSchema>;

export const workScopeEntrySchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    state: workScopeEntryStateSchema,
    unavailableReason: workScopeUnavailableReasonSchema.optional(),
    origin: workScopeOriginSchema,
    rationale: z.string().max(WORK_SCOPE_RATIONALE_MAX_LENGTH),
    decidedBy: workScopeActorSchema,
    /** ISO 8601. */
    decidedAt: z.string().min(1),
  })
  .strict()
  // A reason on a selected entry would be read by nobody and then trusted by
  // whoever reads it next, so the pairing is exact in both directions.
  .refine(
    (entry) => (entry.state === "unavailable") === (entry.unavailableReason !== undefined),
    {
      message: "unavailableReason is present exactly when the state is unavailable.",
      path: ["unavailableReason"],
    },
  );
export type WorkScopeEntry = z.infer<typeof workScopeEntrySchema>;

export const workScopeSchema = z
  .object({
    subjectKey: z.string().min(1),
    version: z.number().int().min(0),
    entries: z.array(workScopeEntrySchema),
  })
  .strict();
export type WorkScope = z.infer<typeof workScopeSchema>;

/** A repository a question named, and why it was asked: not enabled or
 *  unusable are recorded as unavailable if the answer is "none", outside
 *  policy is recorded as excluded, and selection records nothing. */
export const workScopeAskedRepositorySchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    askedBecause: workScopeAskReasonSchema,
    /**
     * Did the question's own words put THIS repository's key in front of the
     * person?
     *
     * A person has decided about a repository only if they were shown it.
     * Being asked a question that happened to be recorded against a key is not
     * deciding about it: silence in answer to a question that never named
     * something says nothing about that thing, exactly as silence about a
     * named one is not selection. Without this fact a generic question ("which
     * repository should this ticket use?") recorded against a key turns a
     * person's "none" into a decision about a repository whose name was never
     * on their screen, and a later run silences the question on that key and
     * tells them they were asked and did not name it.
     *
     * ABSENT MEANS NO, and that is the safe direction: the cost of forgetting
     * to set it is one question asked again, and the cost of assuming it is a
     * decision nobody made. It is stamped once, where the question's text and
     * the repositories it is recorded against are both in hand
     * (`engine/steps/clarification-hook-steps.ts`), so no producer of an ask
     * can forget it and no reader has to guess.
     */
    named: z.boolean().optional(),
  })
  .strict();
export type WorkScopeAskedRepository = z.infer<typeof workScopeAskedRepositorySchema>;

/**
 * The repositories one question put to a person, which may be NONE of them.
 *
 * AN EMPTY LIST AND NO LIST AT ALL ARE DIFFERENT FACTS, AND THEY MUST NEVER
 * COLLAPSE. An empty list says a question about repositories was asked and
 * named none of them, which is what the plain "which repository should this
 * ticket modify?" is. No list at all says the question was not about
 * repositories, which is every other clarification the platform raises: an
 * agent asking which API shape to build, a plan waiting for approval.
 *
 * The difference is load-bearing in three places. The answer path adjudicates
 * the first and refuses to read the second, so that a repository key mentioned
 * in passing while answering "Redis or Postgres?" never becomes somebody's
 * recorded decision. The decision reader writes a repository the person NAMED
 * whether or not the question listed it, which is what makes an empty list
 * worth recording at all. And the selection scan downstream trusts a refusal
 * only where the record was actually shown the answer.
 *
 * A person who writes a repository path has decided about that repository
 * whether or not we put the name in front of them; `named` above governs the
 * opposite direction, which is claiming somebody declined a repository they
 * were never shown.
 */
export const workScopeAskedRepositoriesSchema = z
  .array(workScopeAskedRepositorySchema)
  .max(WORK_SCOPE_ASKED_REPOSITORIES_MAX)
  .refine(
    (repositories) => hasUniqueValues(repositories.map((repository) => repository.repositoryKey)),
    { message: "Asked repositories must be unique." },
  );

/**
 * What a question was FOR, when the purpose is a fact about the SUBJECT and not
 * about any one repository.
 *
 * `askedBecause` on an asked repository answers a different question, namely
 * why THAT key was in front of the person, and it can only exist where a key
 * does. A question that asks somebody to narrow a set too large to list names
 * none of them, so its purpose has nowhere else to live, and without it the
 * only record of the question is a `question_asked` row that is
 * indistinguishable from the plain "which repository should this ticket
 * modify?".
 *
 * "narrowing": the run holds more repositories than it may work on, told the
 * person how many there were, and asked which are essential. What comes back is
 * the whole answer for the subject, because what the person did NOT name they
 * were never shown.
 */
export const WORK_SCOPE_QUESTION_PURPOSES = ["narrowing"] as const;
export const workScopeQuestionPurposeSchema = z.enum(WORK_SCOPE_QUESTION_PURPOSES);
export type WorkScopeQuestionPurpose = z.infer<typeof workScopeQuestionPurposeSchema>;

export const workScopeQuestionAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("repositories"),
      repositoryKeys: z
        .array(repositoryKeySchema)
        .min(1)
        .max(WORK_SCOPE_ASKED_REPOSITORIES_MAX)
        .refine(hasUniqueValues, { message: "Answered repositories must be unique." }),
    })
    .strict(),
  /**
   * The person handed the decision back, and these are the repositories the
   * workflow then took at their request.
   *
   * THE KEYS ARE OURS, NOT THEIRS, which is the whole reason this is not
   * `repositories`. A reader of the trail sees who asked (`answeredBy`), that
   * they asked us to choose (this kind), and what we chose (these keys), which
   * is everything the dashboard and MCP need to explain the run afterwards
   * without replaying anything.
   *
   * MAY BE EMPTY, and an empty one is still an answer: a question about a
   * repository this deployment cannot use, handed back to us, is answered by
   * continuing without it. Nothing is taken and nothing is recorded in that
   * person's name.
   *
   * WHAT IT DELIBERATELY DOES NOT DO is settle the repositories it did not
   * take. The two readers that close a question over a subject
   * (`readWorkScopeSelectionAnswered` and `readWorkScopeAnsweredRepositories`
   * in `db/repositories/work-scope.ts`) count `none` and `repositories` only,
   * so a delegation binds exactly what it took and leaves the rest open for a
   * later run to take or to ask about. A person who names three of five has
   * judged the other two; a person who hands the decision back has judged
   * nothing, and we may not claim otherwise in their name.
   */
  z
    .object({
      kind: z.literal("delegated"),
      repositoryKeys: z
        .array(repositoryKeySchema)
        .max(WORK_SCOPE_ASKED_REPOSITORIES_MAX)
        .refine(hasUniqueValues, { message: "Delegated repositories must be unique." }),
    })
    .strict(),
  z.object({ kind: z.literal("unrecognised") }).strict(),
  // An answer that arrived and was deliberately not read: more than one person's
  // words reached the record as one answer, so it is nobody's decision to
  // record. Distinct from "unrecognised", which is an answer we did read and
  // could not understand: the words here may be perfectly clear, and what is
  // missing is whose they are. Both leave the question unanswered, so it may be
  // asked again; neither writes an entry.
  z.object({ kind: z.literal("unattributed") }).strict(),
]);
export type WorkScopeQuestionAnswer = z.infer<typeof workScopeQuestionAnswerSchema>;

/**
 * What a repository question put in front of a person: a LIST to choose from,
 * or exactly ONE repository to say yes or no to.
 *
 * The shape is what makes a refusal readable. "no" under a question about one
 * repository refuses that repository and nothing else; the same word under a
 * list of four refuses nothing in particular, because it does not say which.
 * The reader is told the shape rather than counting the keys, so a list that
 * happens to hold one entry is still read as a list.
 */
export const WORK_SCOPE_QUESTION_SHAPES = ["list", "one"] as const;
export const workScopeQuestionShapeSchema = z.enum(WORK_SCOPE_QUESTION_SHAPES);
export type WorkScopeQuestionShape = z.infer<typeof workScopeQuestionShapeSchema>;

/**
 * THE CLOSED SET a person's answer may be read into. Nothing outside this is
 * accepted, from a model or from anything else.
 *
 * `declined_all` and `declined_one` are separate because the questions they
 * can answer are separate: a phrase that refuses one thing cannot settle a
 * question that offered four, and a phrase that refuses a whole list cannot be
 * the answer to a question about one repository. Collapsing them into a single
 * "no" is exactly the reading that turned "continue without it" into four
 * permanent exclusions.
 *
 * `unclear` carries the reader's own best paraphrase, and carrying it is the
 * point: it is what the person is shown when we ask them to confirm, so the
 * next reply is a yes or a name rather than the same sentence again.
 */
export const workScopeAnswerOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repositories"),
      repositoryKeys: z
        .array(repositoryKeySchema)
        .min(1)
        .max(WORK_SCOPE_ASKED_REPOSITORIES_MAX)
        .refine(hasUniqueValues, { message: "Answered repositories must be unique." }),
    })
    .strict(),
  z.object({ kind: z.literal("declined_all") }).strict(),
  z.object({ kind: z.literal("declined_one"), repositoryKey: repositoryKeySchema }).strict(),
  /**
   * THEY ASKED US TO DECIDE, which is an answer and not a failure to give one.
   *
   * Production, AWP-236: "whatever you think is best" was read as unclear, so
   * nothing was recorded, the run kept waiting, and the person was asked the
   * same question again. They had already answered it.
   *
   * IT IS NOT `unclear` AND THE DIFFERENCE IS EXACT. "not the fixture one" says
   * something about the repositories without saying what to use, so the
   * remainder would be our subtraction; this says nothing about the
   * repositories and everything about who chooses. The first records nothing,
   * the second records what we chose, in our own name.
   *
   * IT CARRIES NO KEYS. A reading may not choose repositories: which ones a
   * delegation takes is a rule over what the question offered
   * (`repositoriesADelegationTakes` in `engine/work-scope/decide.ts`), applied
   * by our code where the record is written, so a model cannot widen it.
   */
  z.object({ kind: z.literal("delegated") }).strict(),
  z
    .object({
      kind: z.literal("unclear"),
      /** One sentence saying what we think they may have meant, or nothing when
       *  even that would be a guess. */
      paraphrase: z.string().trim().min(1).max(400).optional(),
    })
    .strict(),
]);
export type WorkScopeAnswerOutcome = z.infer<typeof workScopeAnswerOutcomeSchema>;

/**
 * ONE READING OF ONE ANSWER, MADE ONCE, STORED BESIDE THE WORDS.
 *
 * Two readers of the same answer used to exist, the record's and the run's,
 * and they disagreed: "yes" to a question about one repository was a selection
 * to one and unreadable to the other, so the record said the person had chosen
 * and the run carried on without the repository. This is the single reading
 * both now consume. A replay reads it back rather than reading the words
 * again, so a resumed run cannot reach a different conclusion than the
 * execution that took the answer.
 *
 * `readBy` says which reader produced it. `model` is the ordinary path.
 * `deterministic` means the provider could not be reached and the surviving
 * unambiguous reading answered instead (a repository path written out, or the
 * bare word "none"); it is also what an unclear outcome carries when that
 * reading had nothing to say, which is the worst case this path had before a
 * model was involved at all.
 */
export const workScopeAnswerReadingSchema = z
  .object({
    /** Bumped when the meaning of a stored reading changes. A row carrying a
     *  version this build does not know is not read at all, and the question is
     *  put again, because acting on a reading we cannot interpret is the one
     *  thing this whole path exists to prevent. */
    version: z.literal(1),
    outcome: workScopeAnswerOutcomeSchema,
    readBy: z.enum(["model", "deterministic"]),
    /** The model that read it, absent on the deterministic path. */
    model: z.string().min(1).optional(),
    /** ISO 8601, so the stored reading says when it was made without the reader
     *  having to join back to the row it sits on. */
    readAt: z.string().min(1),
    /**
     * REPOSITORY NAMES THE REPLY POINTED AT THAT THE QUESTION NEVER OFFERED.
     *
     * NAMES, NEVER KEYS. The reading's own outcome stays inside the keys the
     * question put in front of the person, and nothing here is a key. Where the
     * answer chose or refused what it was offered, the record looks each name
     * up in the deployment's catalog and takes the ones it holds as that
     * person's own choice (`services/work-scope/from-answer.ts`, A19c); a name
     * that resolves
     * to nothing records nothing, which is what keeps an invented or injected
     * key harmless. The bound is therefore what the catalog holds, guarded by
     * where the name came from: a person's answer on an authenticated channel,
     * never ticket text, never our own bot, never words several people wrote.
     *
     * It exists because the alternative is worse than the risk. Somebody
     * answering "api and github:acme/web" to a question about api named two
     * repositories because they believe both are needed; recording api and
     * saying nothing about web is the system quietly doing half the job, which
     * is the failure this whole path exists to end. Every name comes back to
     * them, in the channel they answered in, with what became of it.
     *
     * BOUNDED AND SANITISED, never a span the model composed: at most four
     * names, each at most 100 characters and made only of the characters a
     * repository name can contain. The words themselves are already on the
     * ticket where that person wrote them, so echoing a name back exposes
     * nothing new; echoing free text would.
     */
    unofferedNames: z.array(z.string().min(1).max(100)).max(4).optional(),
  })
  .strict();
export type WorkScopeAnswerReading = z.infer<typeof workScopeAnswerReadingSchema>;

/**
 * The same closed set as a JSON schema, for the provider's structured output,
 * and it is deliberately FLAT rather than the discriminated union above.
 *
 * Providers answer a flat object with an enum reliably and a nested union
 * badly, and the union is not what keeps us safe here anyway: every field the
 * model returns is checked against the keys we handed it before it becomes a
 * reading. Normalising the flat answer into the union is that check.
 *
 * **No `$schema` key**, for the reason `REPOSITORY_SUGGESTION_ANSWER_JSON_SCHEMA`
 * gives: this object goes to the AI SDK as-is and the providers refuse or
 * ignore a dialect marker.
 */
export const WORK_SCOPE_ANSWER_READING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: {
      type: "string",
      enum: ["repositories", "declined_all", "declined_one", "delegated", "unclear"],
    },
    /** Only for `repositories`. Every value must be one of the keys the prompt
     *  listed; anything else throws the whole reading away. */
    repositoryKeys: {
      type: "array",
      maxItems: WORK_SCOPE_ASKED_REPOSITORIES_MAX,
      items: { type: "string" },
    },
    /** Only for `unclear`: one sentence on the best reading, shown to the
     *  person when we ask them to confirm. */
    paraphrase: { type: "string" },
    /** Repository names the reply pointed at that are NOT in the offered list.
     *  Never keys: our code looks them up in the catalog, and the model's
     *  choice stays inside the offered list. */
    unofferedNames: { type: "array", maxItems: 4, items: { type: "string" } },
  },
} as const;

/** Why an entry was taken off the record by something other than a person. */
export const WORK_SCOPE_REMOVAL_REASONS = [
  /** The catalog relationship that put a `related_repository` entry here is
   *  gone, so the run that would re-attach it has nothing to stand on. */
  "relationship_removed",
] as const;
export const workScopeRemovalReasonSchema = z.enum(WORK_SCOPE_REMOVAL_REASONS);
export type WorkScopeRemovalReason = z.infer<typeof workScopeRemovalReasonSchema>;

export const workScopeTrailEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("entry_written"),
      entry: workScopeEntrySchema,
      previousState: workScopeEntryStateSchema.nullable(),
      clarificationId: z.string().min(1).optional(),
    })
    .strict(),
  // `entry` is the row as it was before the delete.
  z
    .object({
      kind: z.literal("entry_removed"),
      entry: workScopeEntrySchema,
      removedBy: workScopeActorSchema,
      /**
       * Why it went, where the entry's own origin does not already say it.
       *
       * A ticket-text entry removed because the ticket stopped naming the
       * repository needs no sentence: the origin IS the reason. A repository
       * taken because the catalog related it to another one does, because what
       * changed is somewhere a person has to be sent. Optional in the same way
       * and for the same reason as `purpose` below: absent on every row written
       * before the field existed, and absent means nothing beyond the entry.
       */
      reason: workScopeRemovalReasonSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("question_asked"),
      clarificationId: z.string().min(1),
      repositories: workScopeAskedRepositoriesSchema,
      /** Why the question was put, where that is a fact about the subject. It
       *  is absent on every row written before this field existed and on every
       *  question whose purpose is already readable from the repositories it
       *  named, and absent means exactly that: nothing is known about the
       *  question beyond the keys it carried. */
      purpose: workScopeQuestionPurposeSchema.optional(),
    })
    .strict(),
  // A person's answer as the run read it. With `question_asked` under the
  // same clarification id it gives the full question and answer history of a
  // subject, including answers that wrote no entry (a none to a selection
  // question, an unreadable answer).
  z
    .object({
      kind: z.literal("question_answered"),
      clarificationId: z.string().min(1),
      answer: workScopeQuestionAnswerSchema,
      answeredBy: workScopeActorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("request_refused"),
      repositoryKey: repositoryKeySchema,
      reason: workScopeRefusalReasonSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("map_shown"),
      text: z.string().max(WORK_SCOPE_MAP_TEXT_MAX_LENGTH),
      repositoryKeys: z.array(repositoryKeySchema),
    })
    .strict(),
]);
export type WorkScopeTrailEvent = z.infer<typeof workScopeTrailEventSchema>;

/** subjectKey and runId are never both null: a panel edit has no run,
 *  a schedule run has no subject. */
export const workScopeTrailRowSchema = z
  .object({
    id: z.number().int().positive(),
    subjectKey: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    at: z.string().min(1),
    event: workScopeTrailEventSchema,
  })
  .strict()
  .refine((row) => row.subjectKey !== null || row.runId !== null, {
    message: "A trail row names a subject, a run, or both.",
    path: ["subjectKey"],
  });
export type WorkScopeTrailRow = z.infer<typeof workScopeTrailRowSchema>;

/** The one shape a caller hands the store for a single write. Every array may
 *  be empty, and so may the whole plan. */
export const workScopeWritePlanSchema = z
  .object({
    upserts: z
      .array(
        z
          .object({
            entry: workScopeEntrySchema,
            replacesExpired: z.boolean(),
          })
          .strict()
          // Replacing an expired entry means a repository recorded as
          // unavailable has since lost the reason it was unavailable, enabled
          // in the catalog after not_enabled or carrying a default branch after
          // unusable, and is now selected. It is the one case a lower origin may
          // overwrite a higher one, so it may not ride along on any other state.
          .refine((upsert) => !upsert.replacesExpired || upsert.entry.state === "selected", {
            message: "replacesExpired is valid only on a selected entry.",
            path: ["replacesExpired"],
          }),
      )
      .max(WORK_SCOPE_WRITE_PLAN_KEYS_MAX),
    // A delete names the origin its writer observed, so the store deletes only
    // a row still carrying it: a person who took the repository over in the
    // meantime is not undone by a run dropping its text match.
    deletes: z
      .array(
        z
          .object({ repositoryKey: repositoryKeySchema, origin: workScopeOriginSchema })
          .strict(),
      )
      .max(WORK_SCOPE_WRITE_PLAN_KEYS_MAX),
    trail: z.array(workScopeTrailEventSchema).max(WORK_SCOPE_WRITE_PLAN_TRAIL_MAX),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const upsertKeys = plan.upserts.map((upsert) => upsert.entry.repositoryKey);
    if (!hasUniqueValues(upsertKeys)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["upserts"],
        message: "A write plan upserts each repository at most once.",
      });
    }
    const deleteKeys = plan.deletes.map((deletion) => deletion.repositoryKey);
    if (!hasUniqueValues(deleteKeys)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deletes"],
        message: "A write plan deletes each repository at most once.",
      });
    }
    const upserted = new Set(upsertKeys);
    for (const [index, key] of deleteKeys.entries()) {
      if (!upserted.has(key)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deletes", index],
        message: `A write plan cannot both upsert and delete "${key}".`,
      });
    }
  });
export type WorkScopeWritePlan = z.infer<typeof workScopeWritePlanSchema>;

/** Shape only. Which candidates and expansions a given trigger type may carry
 *  is `validateTriggerRepositoryPolicy`, refused when a version is published,
 *  so a draft that is half way through an edit still saves. */
export const triggerRepositoryPolicySchema = z
  .object({
    candidates: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("enabled_catalog") }).strict(),
      // The six pull request trigger types only.
      z.object({ kind: z.literal("event_repository_and_related") }).strict(),
      z
        .object({
          kind: z.literal("listed"),
          repositoryKeys: z
            .array(repositoryKeySchema)
            .min(1)
            .max(TRIGGER_POLICY_LISTED_KEYS_MAX)
            .refine(hasUniqueValues, { message: "Listed repositories must be unique." }),
        })
        .strict(),
    ]),
    expansion: z.enum(["attach", "ask_once", "never"]),
  })
  .strict();
export type TriggerRepositoryPolicy = z.infer<typeof triggerRepositoryPolicySchema>;

/** A person's edit. One write, whole change set, one version. */
export const workScopeEditRequestSchema = z
  .object({
    subjectKey: workScopeSubjectKeySchema,
    /** 0 when the subject has no record yet. */
    expectedVersion: z.number().int().min(0).max(WORK_SCOPE_INT4_MAX),
    changes: z
      .array(
        z
          .object({
            repositoryKey: repositoryKeySchema,
            action: z.enum(["select", "exclude", "remove"]),
            // Becomes the entry's rationale, so it takes the entry's bound.
            rationale: z.string().max(WORK_SCOPE_RATIONALE_MAX_LENGTH).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(WORK_SCOPE_EDIT_CHANGES_MAX)
      .refine((changes) => hasUniqueValues(changes.map((change) => change.repositoryKey)), {
        message: "An edit changes each repository at most once.",
      }),
  })
  .strict();
export type WorkScopeEditRequest = z.infer<typeof workScopeEditRequestSchema>;

/**
 * The record as a person reads it before deciding to change it: what is decided
 * now, and how it came to be decided.
 *
 * `version` is 0 for a subject that carries no record yet, which is exactly the
 * version an edit of it must expect, so a reader never has to tell "no record"
 * apart from "an empty one" to be able to write.
 */
export interface WorkScopeRecordResponse {
  subjectKey: string;
  /**
   * False for a subject kind that keeps no record, a schedule occurrence being
   * the one that exists: every tick is a new key, so a record written for it
   * would be read by nobody. The read answers this plainly instead of refusing,
   * because asking whether a subject carries a record is a fair question and a
   * read cannot cause a bad write; the edit is what refuses.
   */
  carriesRecord: boolean;
  version: number;
  entries: WorkScopeEntry[];
  /** Newest first, so the decision a person is about to undo is the first line
   *  they read. */
  trail: WorkScopeTrailRow[];
  /** The `trailBefore` of the following page, or null at the end of the trail. */
  nextTrailBeforeId: number | null;
}

/**
 * An applied edit: the record as it stands after it, and nothing else.
 *
 * No field says what went unchecked, because nothing about that varies per
 * edit. The edit path lists no repositories, so EVERY selection it records is
 * recorded without checking that a run can reach the repository, and a field
 * repeating that on every reply is a constant wearing the clothes of news. The
 * sentence belongs in the route and tool documentation, where a reader meets it
 * once and keeps it.
 */
export interface WorkScopeEditResponse {
  scope: WorkScope;
}

/**
 * The 409 body a stale `expectedVersion` is refused with.
 *
 * `latestVersion` is what the editor saw at the moment of refusal, and is named
 * the way every other conflicting write on this API names it. Under a race it
 * can equal the version that was expected, so the answer it carries is always
 * "read the record again", never "retry with this number".
 */
export interface WorkScopeEditConflict {
  error: "version_conflict";
  latestVersion: number;
}

const PULL_REQUEST_TRIGGER_TYPES: readonly WorkflowBlockType[] = [
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
] satisfies readonly PrTriggerType[];

function triggerKindDefaultPolicy(
  triggerType: WorkflowBlockType,
  webhookHasSubjectPath: boolean,
): TriggerRepositoryPolicy | null {
  if (triggerType === "trigger_ticket_ai") {
    return { candidates: { kind: "enabled_catalog" }, expansion: "attach" };
  }
  if (PULL_REQUEST_TRIGGER_TYPES.includes(triggerType)) {
    return { candidates: { kind: "event_repository_and_related" }, expansion: "attach" };
  }
  // Nobody is awake to answer a schedule.
  if (triggerType === "trigger_schedule") {
    return { candidates: { kind: "enabled_catalog" }, expansion: "never" };
  }
  // Without a subject path every delivery is a new subject, so an answer
  // would never be read twice.
  if (triggerType === "trigger_webhook") {
    return {
      candidates: { kind: "enabled_catalog" },
      expansion: webhookHasSubjectPath ? "ask_once" : "never",
    };
  }
  return null;
}

/**
 * The policy a trigger node runs under: the configured one, else the kind
 * default with the definition pin as its candidate set when the pin names
 * repositories. `null` for a block that cannot carry a policy, which includes
 * `trigger_plan_approved`, because an approved plan carries its own frozen
 * scope.
 *
 * A pin with only `providers` counts as no pin: providers are applied where
 * they always were, and a candidate set built from them would be the whole
 * provider rather than a list.
 */
export function resolveTriggerRepositoryPolicy(input: {
  triggerType: WorkflowBlockType;
  configured?: TriggerRepositoryPolicy;
  definitionPin?: WorkflowRepositoryScope;
  webhookHasSubjectPath: boolean;
}): TriggerRepositoryPolicy | null {
  const kindDefault = triggerKindDefaultPolicy(input.triggerType, input.webhookHasSubjectPath);
  if (kindDefault === null) return null;
  if (input.configured) return input.configured;
  const pinned = input.definitionPin?.repositories ?? [];
  if (pinned.length === 0) return kindDefault;
  return {
    candidates: {
      kind: "listed",
      repositoryKeys: [
        ...new Set(
          pinned.map((repository) =>
            repositoryCatalogKey({ provider: repository.provider, path: repository.repoPath }),
          ),
        ),
      ],
    },
    expansion: kindDefault.expansion,
  };
}

export type TriggerRepositoryPolicyIssueCode =
  | "event_repository_outside_pull_request"
  | "ask_once_on_schedule"
  | "ask_once_without_subject_path"
  | "duplicate_repository_key";

export interface TriggerRepositoryPolicyIssue {
  code: TriggerRepositoryPolicyIssueCode;
  /** Relative to the policy, so a caller prefixes where the policy sits. */
  path: (string | number)[];
  message: string;
}

/**
 * What a well-shaped policy may not say on this trigger type. Empty when it is
 * valid. Duplicate keys are also refused by the schema; they are repeated here
 * so a caller holding an unparsed policy, such as the editor, gets the same
 * answer.
 */
export function validateTriggerRepositoryPolicy(
  triggerType: WorkflowBlockType,
  policy: TriggerRepositoryPolicy,
  options: { webhookHasSubjectPath: boolean },
): TriggerRepositoryPolicyIssue[] {
  const issues: TriggerRepositoryPolicyIssue[] = [];
  if (
    policy.candidates.kind === "event_repository_and_related" &&
    !PULL_REQUEST_TRIGGER_TYPES.includes(triggerType)
  ) {
    issues.push({
      code: "event_repository_outside_pull_request",
      path: ["candidates", "kind"],
      message:
        "Only a pull request trigger has an event repository, so this trigger cannot take its candidates from one.",
    });
  }
  if (policy.expansion === "ask_once" && triggerType === "trigger_schedule") {
    issues.push({
      code: "ask_once_on_schedule",
      path: ["expansion"],
      message: "A schedule cannot ask about repositories, because nobody is there to answer.",
    });
  }
  if (
    policy.expansion === "ask_once" &&
    triggerType === "trigger_webhook" &&
    !options.webhookHasSubjectPath
  ) {
    issues.push({
      code: "ask_once_without_subject_path",
      path: ["expansion"],
      message:
        "A webhook can ask about repositories only when it configures a subject path, because without one every delivery is a new subject.",
    });
  }
  if (policy.candidates.kind === "listed") {
    const seen = new Set<string>();
    for (const [index, key] of policy.candidates.repositoryKeys.entries()) {
      const normalized = key.trim().toLowerCase();
      if (seen.has(normalized)) {
        issues.push({
          code: "duplicate_repository_key",
          path: ["candidates", "repositoryKeys", index],
          message: `Repository "${normalized}" is listed more than once.`,
        });
      }
      seen.add(normalized);
    }
  }
  return issues;
}

/** The one entry shape no person stands behind: a repository a run picked for
 *  itself. Every other entry is a decision somebody or something took. */
export function isGuessEntry(entry: WorkScopeEntry): boolean {
  return entry.state === "selected" && entry.origin === "inferred";
}

/**
 * A repository a question ALREADY ANSWERED on this work listed, and that
 * nothing on the record has chosen since.
 *
 * THE ONE READING OF "UNNAMED", for everything that acts on it. The rule that
 * stops a guess from taking such a repository, the sentence a person reads when
 * one was left out, and the repository map that tells an agent not to ask for
 * it all have to mean the same set, or the map invites a request the rule is
 * about to refuse and the run pays a pass to discover it.
 *
 * `answeredRepositoryKeys` is keyed on questions a person ANSWERED: an open
 * question tells us nothing about anybody's intent, and a repository in one is
 * not here.
 *
 * A GUESS'S OWN ENTRY IS NOT AN ENTRY HERE. An earlier run may have written
 * `selected` `inferred` before anybody was asked, and read as an entry it would
 * shield the key forever: the answer writes nothing for a name it left out, so
 * the pair never forms. Any other entry (a person's own, delegated, a path in
 * the ticket, a trigger policy, a workflow-owned branch) means somebody has
 * chosen since, and the repository is not unnamed any more. That is what keeps
 * a later positive answer from being swallowed.
 */
export function isUnnamedInAnswer(
  repositoryKey: string,
  answeredRepositoryKeys: readonly string[],
  entries: readonly WorkScopeEntry[],
): boolean {
  if (!answeredRepositoryKeys.includes(repositoryKey)) return false;
  return entries
    .filter((entry) => entry.repositoryKey === repositoryKey)
    .every(isGuessEntry);
}

/**
 * Why such a repository is not in this work, in the words every surface uses.
 *
 * It names neither who answered nor when: the run holds the answered set as
 * keys alone, and a sentence that guessed at a name or a day would be a
 * fabrication about a person. It does not say "did not name it" either, because
 * the same fact is true of a repository somebody named and whose entry a person
 * later removed, and there that clause would be false.
 *
 * IT NAMES NO WAY BACK. It reaches the agent's own prompt, through the refusal
 * and through the repository map, and a lever for reversing a person's decision
 * may never appear in the channel the system signs (rule 7 and D4 of
 * `docs/product/repository-record-behaviour.md`). The way back rides the ticket
 * comment beside it, for the person alone.
 */
export function workScopeUnnamedWhy(repositoryKey: string): string {
  return `${repositoryKey} was listed in a repository question already answered on this work and is not selected on it`;
}
