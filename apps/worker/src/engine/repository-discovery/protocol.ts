import { z } from "zod";

// Protocol values cross the pre-sandbox and engine boundary without service state.
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import {
  repositoryCatalogKey,
  type RepositoryCatalogEntry,
} from "./catalog.js";
import {
  repositoryKeySchema,
  type RepositoryKey,
  type WorkScopeActor,
  type WorkScopeAskReason,
  type WorkScopeAskedRepository,
  type WorkScopeEntry,
} from "@shared/contracts";

const MAX_DISCOVERED_REPOSITORIES = 3;

const discoveryResultSchema = z
  .object({
    status: z.enum(["selected", "clarification_needed", "failed"]),
    repositories: z
      .array(
        z
          .object({
            provider: z.enum(["github", "gitlab"]),
            repoPath: z.string().min(1),
            rationale: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(MAX_DISCOVERED_REPOSITORIES)
      .nullable(),
    confidence: z.enum(["high", "medium", "low"]).nullable(),
    questions: z.array(z.string().trim().min(1).max(500)).max(3).nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict();

/**
 * A repository a discovery clarification is ABOUT, and why the catalog refused
 * it.
 *
 * The reason is the work scope ask vocabulary rather than a second one of this
 * module's own: the caller writes it straight onto the question, and a reason
 * nothing else speaks could not be answered into the record. The two values are
 * the two worlds the lookup already tells apart, and they mean different things
 * to a person: a repository this deployment does not hold is one they can
 * enable, and one the catalog holds and cannot use is not.
 */
interface RepositoryDiscoveryRefusal {
  repositoryKey: RepositoryKey;
  reason: Extract<WorkScopeAskReason, "not_enabled" | "unusable">;
  /** Why the model said it needed the repository, in its own words. A person
   *  deciding whether to take an exclusion back needs the argument. */
  rationale: string;
}

export type RepositoryDiscoveryDecision =
  | {
      kind: "selected";
      repositories: SelectedRepository[];
      confidence: "high";
    }
  | {
      kind: "clarification_needed";
      questions: string[];
      reason: string;
      /**
       * The repositories this clarification concerns, so the question that
       * carries it to a person can name them and their answer can be recorded
       * against them.
       *
       * At most one today, because the loop below refuses at the FIRST
       * repository it cannot use, and a list because that is what a question
       * records itself against. EMPTY, deliberately, on every clarification
       * that is about no repository: a duplicate proposal, a response that did
       * not parse, confidence too low to select, and a model that asked for
       * clarification itself are all the model's behaviour rather than a
       * question about a repository, and there is nothing an answer to them
       * could be recorded against.
       */
      refused: RepositoryDiscoveryRefusal[];
    }
  | {
      kind: "failed";
      error: string;
    };

type ProposedRepository = {
  provider: "github" | "gitlab";
  repoPath: string;
  rationale: string;
};

export function validateRepositoryDiscoveryResult(
  raw: unknown,
  catalog: RepositoryCatalogEntry[],
  mandatoryRepositories: SelectedRepository[],
): RepositoryDiscoveryDecision {
  const parsed = discoveryResultSchema.safeParse(raw);
  if (!parsed.success) {
    return clarification("Repository discovery returned an invalid response.");
  }
  const result = parsed.data;
  if (result.status === "failed") {
    return {
      kind: "failed",
      error: result.error ?? "Repository discovery failed.",
    };
  }
  if (result.status === "clarification_needed") {
    return {
      kind: "clarification_needed",
      questions:
        result.questions && result.questions.length > 0
          ? result.questions
          : [whichRepositoryQuestion()],
      reason: "model_requested_clarification",
      refused: [],
    };
  }
  // AIW-147 IM-7: only "high" confidence auto-selects. "medium" and "low" now
  // become a clarification. When the model proposed candidates, list them (with
  // provider-scoped paths and rationales) so the human can pick one quickly,
  // mirroring the pre-AIW-147 ranked-candidate question that repo-selection
  // asked before this branch.
  const proposals = result.repositories ?? [];
  if (result.confidence !== "high" || proposals.length === 0) {
    if (proposals.length > 0) {
      return {
        kind: "clarification_needed",
        questions: [candidateClarificationQuestion(proposals)],
        reason:
          result.confidence === "medium"
            ? "discovery_confidence_medium"
            : "discovery_confidence_low",
        refused: [],
      };
    }
    return clarification("Repository discovery confidence was too low.");
  }

  const catalogByKey = new Map(
    catalog.map((repository) => [repositoryCatalogKey(repository), repository]),
  );
  const selected = new Map<string, SelectedRepository>();
  for (const repository of mandatoryRepositories) {
    selected.set(repositoryCatalogKey(repository), repository);
  }
  const discoveredKeys = new Set<string>();
  for (const requested of proposals) {
    const key = repositoryCatalogKey(requested);
    if (discoveredKeys.has(key)) {
      // Names no repository, on purpose, and must keep naming none. The model
      // proposing one repository twice is a protocol error by the model, not a
      // question about a repository: there is no answer a person could give
      // that says anything about the repository itself, so recording one
      // against their name would write a decision they never made.
      return clarification("Repository discovery returned duplicate repositories.");
    }
    discoveredKeys.add(key);
    const repository = catalogByKey.get(key);
    if (!repository || !repository.usable) {
      return unavailableClarification(
        key,
        repository ? "unusable" : "not_enabled",
        requested.rationale,
      );
    }
    if (!selected.has(key)) {
      selected.set(key, {
        provider: repository.provider,
        repoPath: repository.repoPath,
        defaultBranch: repository.defaultBranch,
        selectedRationale: requested.rationale,
      });
    }
  }
  if (selected.size > MAX_DISCOVERED_REPOSITORIES) {
    return clarification("Repository discovery exceeded the initial repository limit.");
  }

  return {
    kind: "selected",
    repositories: [...selected.values()],
    confidence: "high",
  };
}

/**
 * The one sentence a repository REFUSED BY THE CATALOG adds to the question.
 *
 * Only on that arm. "Enable it on the Repositories page" is advice for a
 * repository the catalog does not enable, and reads as nonsense on a
 * clarification about duplicates or an unparseable answer, so the other
 * refusals keep the bare question.
 */
const UNAVAILABLE_REPOSITORY_HINT =
  "Enable it on the Repositories page, or answer with another repository.";

function clarification(reason: string): RepositoryDiscoveryDecision {
  return {
    kind: "clarification_needed",
    questions: [whichRepositoryQuestion()],
    reason,
    refused: [],
  };
}

/**
 * The refusal that is ABOUT a repository: the catalog either does not hold the
 * key at all, or holds it and cannot use it.
 *
 * The sentence and the hint are the ones this branch has always sent. What is
 * new is that the decision says which repository it is about, because the
 * caller writes that onto the question and a question that names no repository
 * is one whose answer is dropped.
 *
 * A path the model invented that is not a repository key names nothing the
 * record could hold, so it is refused with the same sentence and carries
 * nothing: a question falls back to what it always was rather than recording a
 * key nothing can read back.
 */
function unavailableClarification(
  key: string,
  reason: RepositoryDiscoveryRefusal["reason"],
  rationale: string,
): RepositoryDiscoveryDecision {
  const repositoryKey = repositoryKeySchema.safeParse(key);
  return {
    kind: "clarification_needed",
    questions: [whichRepositoryQuestion(UNAVAILABLE_REPOSITORY_HINT)],
    reason: "Repository discovery requested an unavailable repository.",
    refused: repositoryKey.success
      ? [{ repositoryKey: repositoryKey.data, reason, rationale }]
      : [],
  };
}

/**
 * What a person is asked, and what the question records itself against.
 *
 * Discovery runs the agent once and its proposal is final, so there is no turn
 * in which the model can be refused and try again: this question reaches a
 * person or nobody. Two things follow. It has to be true, which is why a
 * repository somebody EXCLUDED on this work gets its own sentence instead of
 * the enable hint, and it has to carry the repository it asks about, or the
 * answer is dropped and the next run asks the same person the same thing.
 *
 * THE WHOLE DECISION IS HERE, and the caller only reads three things off the
 * run and hands them over. A closure inside a `"use workflow"` body cannot be
 * invoked by a test, so a decision left there could be reverted to the false
 * enable-it sentence without one test going red.
 */
export function repositoryDiscoveryQuestion(input: {
  decision: Extract<RepositoryDiscoveryDecision, { kind: "clarification_needed" }>;
  /** The subject whose record filtered the catalog, or null when the run froze
   *  none or could not bind one. Null is every run before the record existed:
   *  nothing to record an answer against, and nothing the record could claim. */
  subjectKey: string | null;
  /** The record's entries as the run holds them. */
  recorded: readonly WorkScopeEntry[];
  /** The catalog BEFORE the record filtered it, which is the only place the
   *  difference between "the record kept it back" and "it is not there any
   *  more" can be seen. */
  catalog: readonly RepositoryCatalogEntry[];
}): {
  questions: string[];
  ask: { subjectKey: string; askedRepositories: WorkScopeAskedRepository[] } | null;
} {
  // The validator refuses at the first repository it cannot use, so a
  // clarification is about one repository or about none.
  const [refused] = input.decision.refused;
  if (!refused || input.subjectKey === null) {
    return { questions: input.decision.questions, ask: null };
  }
  // The exclusion sentence PROMISES the repository back, so it is said only
  // where the record can keep that promise. A repository that has since been
  // disabled or deleted is gone from the catalog whatever the record says: the
  // person would destroy their own decision, and the run would refuse the key
  // as outside the catalog in the same breath. Then today's sentence is the
  // true one.
  const excluded = input.recorded.find(
    (entry) => entry.repositoryKey === refused.repositoryKey && entry.state === "excluded",
  );
  const reversible =
    excluded &&
    input.catalog.some(
      (entry) => entry.usable && repositoryCatalogKey(entry) === refused.repositoryKey,
    )
      ? excluded
      : undefined;
  return {
    questions: reversible
      ? [excludedRepositoryQuestion(refused, reversible)]
      : input.decision.questions,
    ask: {
      subjectKey: input.subjectKey,
      askedRepositories: [
        {
          repositoryKey: refused.repositoryKey,
          // `selection` is the meaning, not a compromise: a "none" to this
          // question leaves the exclusion the person already made standing and
          // writes nothing, and naming the repository writes their new
          // decision.
          askedBecause: reversible ? "selection" : refused.reason,
        },
      ],
    },
  };
}

/**
 * The one sentence for a repository a person took off this work.
 *
 * Everything the validator's own sentence says is false here: the repository is
 * enabled, it is usable, and the only thing between the run and it is their own
 * decision, so being sent to the Repositories page is being sent to do nothing.
 * The one recovery that sentence does offer, naming the repository again, takes
 * their decision back without saying so. This says it instead.
 *
 * Not the sentence `repositoryExpansionRefusalSentence` builds, and the two are
 * not one function: that one tells a MODEL why the run refused it and ends the
 * exchange, this one asks a PERSON to decide again and says what their answer
 * will do.
 *
 * The model writes one piece of this sentence and none of its shape. Its
 * rationale is worth showing, quoted and attributed to it, but it arrives as up
 * to 500 characters of anything: a newline in it would end the one-line
 * property the answer reader leans on, and a repository key in it would put our
 * own words where the person's answer is looked for. So it is flattened to one
 * line and cut short before it is quoted.
 */
function excludedRepositoryQuestion(
  refused: RepositoryDiscoveryRefusal,
  excluded: Pick<WorkScopeEntry, "decidedBy" | "decidedAt">,
): string {
  return [
    `${refused.repositoryKey} was excluded on this work by ${actorLabel(excluded.decidedBy)} on ${plainDate(excluded.decidedAt)}.`,
    `Repository discovery asked for it anyway, because "${theModelsWords(refused.rationale)}".`,
    `Answer with ${refused.repositoryKey} to take that exclusion back and let this run use it,`,
    "or with the repositories this ticket should use instead.",
  ].join(" ");
}

/** How much of the model's own reason a sentence a person reads will carry. The
 *  protocol lets it write 500 characters; a question is read at a glance, and
 *  the rest is in the run's own record. */
const MODEL_WORDS_MAX = 160;

/** The model's reason, in one line and no longer than a sentence a person will
 *  actually read. Whitespace runs collapse, newlines included, so nothing the
 *  model writes can change the SHAPE of what we send. */
function theModelsWords(rationale: string): string {
  const oneLine = rationale.replace(/\s+/gu, " ").trim();
  return oneLine.length <= MODEL_WORDS_MAX
    ? oneLine
    : `${oneLine.slice(0, MODEL_WORDS_MAX).trimEnd()}...`;
}

/** Who decided, as a sentence names them. */
function actorLabel(actor: WorkScopeActor): string {
  return actor.kind === "person" ? actor.actorLabel : `run ${actor.runId}`;
}

/** The day, as a sentence says it. The record stores an instant, and a person
 *  reading "2026-09-10T08:30:00.000Z" in a sentence about their own decision
 *  gets precision nobody needs. Anything that is not an ISO instant is left
 *  exactly as it is rather than guessed at. */
function plainDate(decidedAt: string): string {
  return /^\d{4}-\d{2}-\d{2}T/u.test(decidedAt) ? decidedAt.slice(0, 10) : decidedAt;
}

function whichRepositoryQuestion(hint?: string): string {
  const question =
    "Which repository or repositories should this ticket inspect or modify? Reply with full repository paths.";
  return hint === undefined ? question : `${question} ${hint}`;
}

// Ranked list of the repositories the model proposed, each with its
// provider-scoped path and rationale, so a human can confirm the selection in
// one reply.
function candidateClarificationQuestion(proposals: ProposedRepository[]): string {
  const candidates = proposals
    .map((proposal) => `${proposal.provider}:${proposal.repoPath} (${proposal.rationale})`)
    .join(", ");
  return [
    "Repository discovery was not confident enough to select automatically.",
    "Which repository or repositories should this ticket inspect or modify?",
    "Reply with full provider-scoped paths (for example github:acme/app).",
    `Proposed candidates: ${candidates}.`,
  ].join(" ");
}
