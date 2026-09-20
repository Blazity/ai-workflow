import { z } from "zod";

// Protocol values cross the pre-sandbox and engine boundary without service state.
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { PreSandboxPromptAddition } from "../../sandbox/context.js";
import {
  repositoryCatalogKey,
  type RepositoryCatalogEntry,
} from "./catalog.js";
import { exclusionRecoveryNotes, unnamedRecoveryNotes } from "../work-scope/context.js";
import { isGuessEntry, isUnnamedInAnswer } from "../work-scope/decide.js";
import {
  workScopeUnnamedSentence,
  workScopeUnnamedWhy,
} from "../work-scope/refusal-sentence.js";
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
 * A repository a discovery clarification is ABOUT, and why it is asking.
 *
 * The reason is the work scope ask vocabulary rather than a second one of this
 * module's own: the caller writes it straight onto the question, and a reason
 * nothing else speaks could not be answered into the record. The three values
 * are the three ways a discovery question comes to be about a repository, and
 * they mean different things to a person: one this deployment does not hold is
 * one they can enable, one the catalog holds and cannot use is not, and one the
 * model proposed without confidence is a choice they are being offered.
 */
interface RepositoryDiscoveryAsk {
  repositoryKey: RepositoryKey;
  reason: Extract<WorkScopeAskReason, "not_enabled" | "unusable" | "selection">;
  /** Why the model said it needed the repository, in its own words. A person
   *  deciding whether to take an exclusion back needs the argument. */
  rationale: string;
}

export type RepositoryDiscoveryDecision =
  | {
      kind: "selected";
      repositories: SelectedRepository[];
      confidence: "high";
      /**
       * What the run left out of this selection without asking: the repository,
       * and the sentence saying why. Empty on every run that left nothing out.
       *
       * A repository dropped in silence is the worse half of A47: the ticket
       * visibly names it, the run did not open it, and with nothing said a
       * person is left to conclude the run simply missed it. So the sentence
       * reaches both readers there are, the agent's prompt and the ticket
       * comment, and the key travels beside it because the comment's repository
       * section is keyed and prose is not.
       */
      leftOut: RepositoryLeftOut[];
      /**
       * The repositories the sentences above say were left out, as keys.
       *
       * Beside the prose rather than parsed back out of it, because the two
       * reach different readers and only one of them reads prose: the notes go
       * into the agent's prompt, and these go onto the run as an observation,
       * which is where a person asking why a run touched less than the ticket
       * names can actually find it and where a query can count it.
       */
      droppedRepositoryKeys: RepositoryKey[];
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
       * One, when the catalog refused it, because the loop below refuses at the
       * FIRST repository it cannot use. Several, when the model proposed them
       * and was not confident enough to be believed. EMPTY, deliberately, on
       * every clarification that is about no repository: a response that did
       * not parse, a proposal in which nothing the model named is a key we hold,
       * and a model that asked for clarification itself are all the model's
       * behaviour rather than a question about a repository, and there is
       * nothing an answer to them could be recorded against.
       */
      about: RepositoryDiscoveryAsk[];
    }
  | {
      kind: "failed";
      error: string;
      /**
       * Whose failure it is. The model's own is the provider's; a run left with
       * nothing because a person excluded what the model proposed is somebody's
       * configuration, and sending an operator to read provider logs for it
       * sends them to the wrong place.
       */
      blame: "provider" | "work_scope";
    };

/** A repository the run was asked to work on and did not, as both readers need
 *  it: the sentence for a person, the key for the line it is rendered on.
 *
 *  Not exported: it is the element type of `leftOut` on the decision above, and
 *  every caller reaches it through that field rather than by name. */
interface RepositoryLeftOut {
  repositoryKey: string;
  reason: string;
}

/**
 * What the agents are told about the repositories discovery left out, in the
 * same place the pre-sandbox puts the ones it kept back.
 *
 * Here rather than in the workflow body, where no test can reach it: the
 * marker is what keeps the prompt from calling this a pre-sandbox addition,
 * which it is not (discovery ran in a sandbox), so dropping it must turn a
 * test red.
 */
export function discoveryLeftOutAddition(
  leftOut: readonly { reason: string }[],
): PreSandboxPromptAddition {
  return {
    target: ["research", "implementation", "review"],
    title: "Repositories left out",
    content: leftOut.map((left) => `- ${left.reason}`).join("\n"),
    producedBy: "repository_discovery",
  };
}

type ProposedRepository = {
  provider: "github" | "gitlab";
  repoPath: string;
  rationale: string;
};

export function validateRepositoryDiscoveryResult(
  raw: unknown,
  catalog: RepositoryCatalogEntry[],
  mandatoryRepositories: SelectedRepository[],
  /**
   * What this subject has already settled, on a run that froze a record.
   *
   * Neither half is derivable from the catalog above, and that is why it is
   * passed: the record has already filtered the offered list, so a repository
   * somebody excluded is missing from it in exactly the way one nobody ever
   * enabled is. Absent on every run that froze no record, which is the whole
   * old path.
   */
  settled?: {
    /** The usable repositories this run holds that a question on this subject
     *  named and the answer did not take (`answerLeftUnnamedKeys` on the run's
     *  recorder). They were left off `catalog` above for exactly that reason,
     *  so this is the only place the validator can still learn their names, and
     *  it needs them for one sentence: the one that stops a run with nothing
     *  left to offer rather than asking again (`nothingLeftToOffer`). */
    answerLeftUnnamed: readonly RepositoryKey[];
    /** The repositories a question on this subject named and somebody answered
     *  for. It is the ONLY fact this file decides on, and it is per repository
     *  rather than per subject on purpose: an answer about one repository says
     *  nothing about another, so a subject-wide flag would both silence a
     *  question nobody was asked and read a refusal as consent.
     *
     *  Empty means nothing was asked yet, so ask. A run resuming from a context
     *  frozen before this fact existed has no set, and being asked once more is
     *  the only acceptable cost direction. */
    answeredRepositoryKeys: readonly string[];
    /** The record's entries as the run holds them. */
    recorded: readonly WorkScopeEntry[];
    /** Would a full path written in a ticket comment about these repositories
     *  reach the next run and be taken? Decided by the run's own record
     *  (`commentPathIsTaken` in `engine/work-scope/context.ts`) and asked
     *  rather than recomputed, so this file's way back and the pre-sandbox's
     *  are the same sentence about the same ticket. */
    commentPathIsTaken: (repositoryKeys: readonly RepositoryKey[]) => boolean;
  },
): RepositoryDiscoveryDecision {
  // NOTHING LEFT TO OFFER IS NOT A QUESTION (C11p), and it is decided before
  // the model's answer is read because no answer changes it. Every clarification
  // below names no repository, so none of them is covered by the per-repository
  // stops further down, and each one reached a person who had just declined
  // every repository this run could use: asked by the model which of those same
  // repositories to put off, or asked by us which repository to use at all.
  const nothingLeft = nothingLeftToOffer(catalog, mandatoryRepositories, settled);
  const parsed = discoveryResultSchema.safeParse(raw);
  if (!parsed.success) {
    return nothingLeft ?? clarification("Repository discovery returned an invalid response.");
  }
  const result = parsed.data;
  if (result.status === "failed") {
    return {
      kind: "failed",
      error: result.error ?? "Repository discovery failed.",
      blame: "provider",
    };
  }
  if (result.status === "clarification_needed") {
    return (
      nothingLeft ?? {
        kind: "clarification_needed",
        questions:
          result.questions && result.questions.length > 0
            ? result.questions
            : [whichRepositoryQuestion()],
        reason: "model_requested_clarification",
        about: [],
      }
    );
  }
  const proposals = result.repositories ?? [];
  if (proposals.length === 0) {
    return nothingLeft ?? clarification("Repository discovery confidence was too low.");
  }
  // AIW-147 IM-7: only "high" confidence auto-selects. "medium" and "low"
  // become a clarification. When the model proposed candidates, list them (with
  // provider-scoped paths and rationales) so the human can pick one quickly,
  // mirroring the pre-AIW-147 ranked-candidate question that repo-selection
  // asked before this branch.
  //
  // ASKED AT MOST ONCE PER REPOSITORY. Without a stop this question never
  // terminates: a "none" to it writes no entry by design, so the next run reads
  // exactly what this one read, the model repeats its proposal, and the
  // identical question is posted again for as long as the person keeps
  // answering (A47). The stop is per repository and not per subject, because a
  // question about the dashboard settles nothing about the API schema.
  //
  // SILENCE IS NOT SELECTION, and this is the rule the whole branch turns on.
  // Suppressing the question is NOT permission to act on what it would have
  // offered. A person who was asked "which of these should I start from" and
  // answered "none" REFUSED these repositories; attaching them on the strength
  // of their having answered at all executes the refusal as consent, and does it
  // silently. So the suppressed branch proceeds WITHOUT the candidates, never
  // with them. A candidate they DID name is not lost by this: naming it wrote a
  // `selected` entry, and the record carries it into the run on its own.
  //
  // WHAT THE QUESTION NAMES IS WHAT IT RECORDS, and they were two different
  // lists: the question listed every proposal while the ask carried only the
  // ones the record can hold, so a proposal outside the catalog was named to a
  // person, recorded against nobody, and asked again on every run for as long as
  // the model kept proposing it. One list now. A candidate this file cannot
  // record is not offered as a choice either: the loop below meets it and asks
  // about it BY NAME, which is a question whose answer lands somewhere.
  //
  // NOBODY IS ASKED AGAIN ABOUT WHAT THEY ALREADY ANSWERED, and that holds for
  // each repository on the list, not only for the list as a whole. A candidate
  // this work already decided about (a person's selection, an exclusion, any
  // entry that is not a guess) is no candidate: the record carries it, so it is
  // neither offered nor counted as declined. A candidate somebody was already
  // asked about and answered stays a candidate, so a list made only of those is
  // still the declined proposal below, but it is left off any question that
  // asks about the rest.
  const unsure = result.confidence !== "high";
  const candidates = unsure
    ? candidateAsks(proposals, catalog).filter(
        (candidate) =>
          !mandatoryRepositories.some(
            (repository) => repositoryCatalogKey(repository) === candidate.repositoryKey,
          ) &&
          !(settled?.recorded ?? []).some(
            (entry) => entry.repositoryKey === candidate.repositoryKey && !isGuessEntry(entry),
          ),
      )
    : [];
  const candidateKeys = candidates.map((candidate) => candidate.repositoryKey as string);
  const unanswered = candidates.filter(
    (candidate) => !alreadyAsked(candidate.repositoryKey, settled),
  );
  if (unsure && unanswered.length > 0) {
    return {
      kind: "clarification_needed",
      questions: [candidateClarificationQuestion(unanswered)],
      reason:
        result.confidence === "medium"
          ? "discovery_confidence_medium"
          : "discovery_confidence_low",
      // A selection among named candidates, exactly like the "which of these"
      // question the pre-sandbox asks, so the answer settles this subject for
      // good instead of being dropped for naming no repository (A46).
      about: unanswered,
    };
  }
  /** True when the question above was suppressed because every candidate it
   *  would have NAMED had already been put to somebody who answered. Past this
   *  line an unsure proposal contributes nothing.
   *
   *  False when it would have named none, and that is not a detail: a refusal
   *  nobody was ever offered is not a refusal, so an unsure proposal the record
   *  cannot hold goes to the loop below and is asked about there rather than
   *  dropped in silence against an answer nobody gave. */
  const declined = unsure && candidateKeys.length > 0;

  const catalogByKey = new Map(
    catalog.map((repository) => [repositoryCatalogKey(repository), repository]),
  );
  const selected = new Map<string, SelectedRepository>();
  for (const repository of mandatoryRepositories) {
    selected.set(repositoryCatalogKey(repository), repository);
  }
  const discoveredKeys = new Set<string>();
  const dropped: DroppedRepository[] = [];
  /** Proposals an answer on this subject left unnamed, in proposal order. */
  const unnamed: RepositoryKey[] = [];
  // SILENCE IS NOT SELECTION: an unsure proposal every candidate of which was
  // already put to somebody contributes nothing at all.
  for (const requested of declined ? [] : proposals) {
    const key = repositoryCatalogKey(requested);
    // The model proposing one repository twice is a protocol error by the
    // model, and a person cannot usefully answer it: there is no answer that
    // says anything about the repository itself. The clarification it used to
    // raise named no repository, so its answer was dropped on arrival, and it
    // hid whatever else was wrong with the proposal behind a generic question.
    // The second mention adds no repository, so nothing is lost by carrying on
    // and the refusals that matter are reached in the proposal's own order
    // (A48).
    if (discoveredKeys.has(key)) continue;
    discoveredKeys.add(key);
    // A proposal is a guess at ANY confidence, and a guess does not take back a
    // repository a which-of-these answer left unnamed. Before the catalog is
    // consulted, because the record may have filtered such a repository out of
    // the offered list, and a missing repository would otherwise be asked about
    // as one nobody enabled. A repository the run already holds for a reason of
    // its own is not a guess and stays.
    if (
      settled &&
      !selected.has(key) &&
      isUnnamedInAnswer(key, settled.answeredRepositoryKeys, settled.recorded)
    ) {
      unnamed.push(key);
      continue;
    }
    const repository = catalogByKey.get(key);
    if (!repository || !repository.usable) {
      // ASKED ONCE, TOLD AFTERWARDS. A person who already answered a question
      // about THIS repository settled it; asking them again offers one answer
      // that destroys their own decision and one that changes nothing, and the
      // run that follows the second answer reads exactly what it read before,
      // so the same question comes back for as long as they keep answering
      // (A47). A repository nobody has been shown is still asked about, which
      // is wave 8's question and the first half of the same rule (A44).
      const reason = repository ? "unusable" : "not_enabled";
      const decided = alreadyDecided(key, settled);
      if (decided) {
        dropped.push({ decided, reason, rationale: requested.rationale });
        continue;
      }
      return unavailableClarification(key, reason, requested.rationale);
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
  if (selected.size === 0) {
    // NOBODY IS ASKED TWICE, AND THE EMPTY CASE IS NOT AN EXCEPTION TO IT.
    //
    // The empty case has three outcomes and this branch is only ever the last
    // two of them, by the shape of the loop above rather than by a condition
    // here. A repository nobody has been shown is ASKED ABOUT WHERE IT IS MET,
    // inside the loop, and that return happens long before this line. A
    // repository reaches `dropped` only when `alreadyDecided` (below) found it in the
    // answered set, which is to say the question naming it was already put and
    // somebody answered it; a candidate reaches `declined` on the same footing.
    // So everything arriving here has been asked about and answered, and asking
    // again would put the same question to the same person and get the same
    // answer. That is not a door either, so the run says what happened and
    // stops.
    //
    // The sentence is the record: it names each repository and who took it off
    // this work, because the next move is a person's and they need to know
    // whose decision it is they would be revisiting.
    return {
      kind: "failed",
      error:
        dropped.length > 0
          ? nothingLeftToWorkOn(dropped)
          : unnamed.length > 0
            ? nothingLeftButUnnamed(unnamed, settled?.commentPathIsTaken(unnamed) ?? false)
            : nothingLeftToStartFrom(
                candidateKeys,
                settled?.commentPathIsTaken(candidateKeys) ?? false,
              ),
      blame: "work_scope",
    };
  }

  return {
    kind: "selected",
    repositories: [...selected.values()],
    confidence: "high",
    leftOut: [
      ...dropped.map((left) => ({
        repositoryKey: left.decided.repositoryKey as string,
        reason: leftOutNote(left.decided),
      })),
      // Left out rather than taken, and said out loud either way: a repository
      // the ticket names and the run never opened reads as a run that missed it.
      // One entry per repository rather than one sentence naming several,
      // because the comment renders these as a line against a repository each.
      ...(declined
        ? candidateKeys.map((key) => ({ repositoryKey: key, reason: leftUnnamedNote([key]) }))
        : []),
      // The same sentence the pre-sandbox says about a guess it did not take, so
      // a person reads one wording whichever guess it was. It reaches the model
      // as well, so it carries no way back (rule 7).
      ...unnamed.map((key) => ({
        repositoryKey: key,
        reason: workScopeUnnamedSentence(key, "run_start"),
      })),
    ],
    droppedRepositoryKeys: dropped.map((left) => left.decided.repositoryKey),
  };
}

/**
 * The run's end when discovery has nothing left to offer anybody: every
 * repository this run could use was named in a question on this subject and
 * left out of the answer, and the run holds none for a reason of its own.
 *
 * Undefined whenever something is still open, and that bound is the point. A
 * usable repository left in `catalog` is one nobody has declined, so a question
 * about a capability the catalog lacks is a real question there and is asked.
 * A repository the catalog cannot use is not open either, so it does not keep a
 * run parked on a question whose only honest answers were already given.
 *
 * Only when an answer left something out, because that is the one state in
 * which the empty offer is somebody's decision rather than a catalog nobody
 * filled: the sentence names those repositories and the way back to them.
 */
function nothingLeftToOffer(
  catalog: readonly RepositoryCatalogEntry[],
  mandatoryRepositories: readonly SelectedRepository[],
  settled:
    | {
        answerLeftUnnamed: readonly RepositoryKey[];
        commentPathIsTaken: (repositoryKeys: readonly RepositoryKey[]) => boolean;
      }
    | undefined,
): Extract<RepositoryDiscoveryDecision, { kind: "failed" }> | undefined {
  if (!settled || settled.answerLeftUnnamed.length === 0) return undefined;
  if (mandatoryRepositories.length > 0 || catalog.some((entry) => entry.usable)) {
    return undefined;
  }
  const leftOut = [...settled.answerLeftUnnamed];
  return {
    kind: "failed",
    error: nothingLeftButUnnamed(leftOut, settled.commentPathIsTaken(leftOut)),
    blame: "work_scope",
  };
}

/** A repository this run took out of the proposal because the record already
 *  decided it, with what the question about it WOULD have said. The question
 *  inputs are kept because dropping every proposal leaves the run with nothing,
 *  and the run then has to ask after all. */
interface DroppedRepository {
  decided: WorkScopeEntry;
  reason: Extract<RepositoryDiscoveryAsk["reason"], "not_enabled" | "unusable">;
  rationale: string;
}

/**
 * Was a question naming THIS repository put to somebody on this subject, and did
 * they answer it?
 *
 * The one fact this file decides on. It says a person has seen this repository
 * in a question and replied, which is what makes a second question about it a
 * repeat. It says NOTHING about what they replied, so nothing may be attached on
 * the strength of it.
 *
 * NAMING IS PART OF THE FACT, not a property of the question that happened to
 * carry it. The set is built from the asks whose question put the key in front
 * of a person (`db/repositories/work-scope.ts`), so a generic question recorded
 * against a key is not in it: being asked something is not deciding about a
 * repository whose name was never on the screen.
 */
function alreadyAsked(
  key: string,
  settled: { answeredRepositoryKeys: readonly string[] } | undefined,
): boolean {
  return settled?.answeredRepositoryKeys.includes(key) ?? false;
}

/**
 * The record's entry for a repository a proposal names that this work already
 * decided, which is the entry that says who decided it and when.
 *
 * Two conditions, and each one alone would be wrong. THIS repository must have
 * been NAMED to somebody in a question they answered, because that is the ask
 * A44 promises and A47 spends: a person who was never shown this repository is
 * owed the question, whatever else they have answered on this work. And this
 * work must already hold an entry about it.
 *
 * BOTH STATES THAT SAY SO COUNT, and the second one is the fix for a real loop.
 * An `excluded` entry is a person's decision to leave the repository out. An
 * `unavailable` one is the ANSWER TO THE VERY QUESTION this branch is about to
 * ask again: a person was told the repository is not available and did not name
 * it, and the entry records that. Honouring only the first asked them the same
 * question on every later run, forever, while the same answer already counted
 * as decided everywhere else. Honouring it here is safe precisely because this
 * branch is reached only while the repository is STILL unusable: the entry
 * expires by itself the moment the catalog can use it, and then the loop takes
 * the repository instead of ever reaching this line.
 *
 * The subject-wide flag is deliberately not consulted here. It cannot tell this
 * repository's question from another repository's, so gating on it drops the
 * very first question about a repository the moment any other one was answered.
 */
function alreadyDecided(
  key: string,
  settled:
    | { answeredRepositoryKeys: readonly string[]; recorded: readonly WorkScopeEntry[] }
    | undefined,
): WorkScopeEntry | undefined {
  if (!settled || !alreadyAsked(key, settled)) return undefined;
  return settled.recorded.find(
    (recorded) =>
      recorded.repositoryKey === key &&
      (recorded.state === "excluded" || recorded.state === "unavailable"),
  );
}

/** Who took a repository off this work, and when, as a sentence about it
 *  starts. Every sentence this module writes about an exclusion opens with it,
 *  because the fact a person needs first is whose decision this was. */
function excludedBy(
  repositoryKey: RepositoryKey,
  excluded: Pick<WorkScopeEntry, "decidedBy" | "decidedAt">,
): string {
  return `${repositoryKey} was excluded on this work by ${actorLabel(excluded.decidedBy)} on ${plainDate(excluded.decidedAt)}`;
}

/** What a run says about a repository it left out rather than asking about a
 *  second time. Two sentences, because the two entries are two different facts:
 *  somebody took this repository off the work, or somebody was told this
 *  deployment cannot give it to the run and left it at that. A person reading
 *  the second one can act on it today, so it says how. */
function leftOutNote(decided: WorkScopeEntry): string {
  return decided.state === "unavailable"
    ? `${decided.repositoryKey} is not available to this run, ${actorLabel(decided.decidedBy)} was asked about it on ${plainDate(decided.decidedAt)} and did not name it, and this run left it out rather than asking again. ${enableThemNext(1)}`
    : `${excludedBy(decided.repositoryKey, decided)}, and this run left it out rather than asking about it again.`;
}

/** The move a person has when a repository is merely unavailable. It is a real
 *  one: the entry expires by itself the moment the catalog can use the
 *  repository, so enabling it is all that is needed and no decision has to be
 *  taken back. */
function enableThemNext(count: number): string {
  const them = count > 1 ? "them" : "it";
  return `Enable ${them} on the Repositories page and start a new run to use ${them}.`;
}

/**
 * The move a person has when the record holds somebody's EXCLUSION, which is
 * the sentence a failing run ends on.
 *
 * NOT THIS FILE'S OWN WORDS, and that is the point. This sentence used to say
 * the way forward was a new ticket, which was honest when it was written
 * (nothing constructed an `edited` event, so no route, no tool and no screen
 * reached the record) and is false now that the edit path exists. A sentence
 * that has to be revisited every time the product grows a door is a sentence
 * that will be wrong again, so there is one source for what a person is told
 * about taking an exclusion back and every surface reads it.
 *
 * It is called with no catalog, and that is not laziness. The catalog this
 * module is handed is the OFFERED one, which the record has already filtered,
 * so a repository somebody excluded is missing from it in exactly the way one
 * nobody enabled is: its absence here says nothing about the deployment. The
 * promise the sentence makes is about the LIST, which this run can see is
 * changeable, and not about the repository working afterwards.
 */
function exclusionNext(dropped: DroppedRepository[]): string {
  return exclusionRecoveryNotes(
    dropped
      .filter((left) => left.decided.state === "excluded")
      .map((left) => left.decided.repositoryKey),
    { enabledKeys: null, unusableKeys: null },
  ).join(" ");
}

/** What a run says about an unsure proposal it left out because the candidates
 *  had already been put to somebody who named none of them. */
function leftUnnamedNote(repositoryKeys: string[]): string {
  const them = repositoryKeys.length > 1 ? "them" : "it";
  return `Repository discovery was not confident about ${repositoryKeys.join(", ")}, and somebody on this work was already asked which repositories to start from and did not name ${them}, so this run left ${them} out rather than acting on a question nobody answered with ${them}.`;
}

/** What a run says when leaving the repositories the record decided out left it
 *  with nothing. Each one names who took it off this work, because the only
 *  move left is a person's and it is their own decision they would revisit. */
function nothingLeftToWorkOn(dropped: DroppedRepository[]): string {
  return [
    ...dropped.map((left) =>
      left.decided.state === "unavailable"
        ? `${left.decided.repositoryKey} is not available to this run, and ${actorLabel(left.decided.decidedBy)} was asked about it on ${plainDate(left.decided.decidedAt)} and did not name it.`
        : `${excludedBy(left.decided.repositoryKey, left.decided)}.`,
    ),
    "Repository discovery proposed nothing else this run can use,",
    "so it has no repository to work on.",
    // The sentence is the only thing a person has here, so it ends on what they
    // can do rather than on whose decision it was.
    dropped.some((left) => left.decided.state === "excluded")
      ? exclusionNext(dropped)
      : enableThemNext(dropped.length),
  ].join(" ");
}

/** What a run says when every proposal was a repository an answer left
 *  unnamed. A failure reason reaches the run's status and the ticket comment
 *  and not the agent's instructions, so it ends on the way back, which is the
 *  same one the pre-sandbox gives (`unnamedRecoveryNotes`). */
function nothingLeftButUnnamed(
  repositoryKeys: RepositoryKey[],
  commentPathIsTaken: boolean,
): string {
  // NAMED WITHIN THE CEILING THE MESSAGE BOUND WAS SIZED AT, and counted past
  // it. A proposal never names more than three, but the offer an answer
  // emptied (`nothingLeftToOffer`) can hold any number, and past the ceiling
  // the surfaces elide the middle of the sentence, which is where the way back
  // would be cut from (`execution-error-invariant.test.ts`). The count takes
  // the room of the third name, so the longest sentence stays the one sized.
  const named =
    repositoryKeys.length > MAX_DISCOVERED_REPOSITORIES
      ? repositoryKeys.slice(0, MAX_DISCOVERED_REPOSITORIES - 1)
      : repositoryKeys;
  const more = repositoryKeys.length - named.length;
  return [
    ...named.map((key) => `${workScopeUnnamedWhy(key)}.`),
    ...(more > 0
      ? [
          `${more} more ${more === 1 ? "repository was" : "repositories were"} left out of an answer on this work the same way.`,
        ]
      : []),
    "Repository discovery proposed nothing else this run can use,",
    "so it has no repository to work on.",
    ...unnamedRecoveryNotes(repositoryKeys, commentPathIsTaken),
  ].join(" ");
}

/** What a run says when leaving those candidates out left it with nothing.
 *
 *  It ends on a door that is really open. A "none" to the which-of-these
 *  question writes NO entry by design, so nothing on this work refuses these
 *  repositories: a full path written in a COMMENT after that answer is matched
 *  by the pre-sandbox before any question is asked, and it attaches (C11g). Not
 *  the description: the description is the text the question was already asked
 *  about, so an edit there is bound by the answer and the run stops here again
 *  (C11f). That is the cheap move, and it is the one to say first, WHERE IT
 *  WORKS. Where the ticket already names more
 *  open repositories than the run may decide between, its text is asked about
 *  rather than taken from (`commentPathIsTaken`), so there the sentence names
 *  the record instead. */
function nothingLeftToStartFrom(
  repositoryKeys: string[],
  commentPathIsTaken: boolean,
): string {
  const them = repositoryKeys.length > 1 ? "them" : "it";
  return [
    `Repository discovery was not confident about ${repositoryKeys.join(", ")},`,
    `and somebody on this work was already asked which repositories to start from and did not name ${them}.`,
    "Not naming a repository is not choosing it,",
    "so this run has no repository to work on.",
    commentPathIsTaken
      ? `Write the full path of each repository this ticket should work on in a comment on this ticket, as ${repositoryKeys[0] ?? "github:owner/repo"}, and start a new run.`
      : "Select the repositories this ticket should work on in this work's repository list, through the work scope API or the work_scope.edit tool, and start a new run.",
  ].join(" ");
}

/**
 * The proposals a low confidence question may record itself against: the ones
 * the offered catalog holds AND can use.
 *
 * A proposal the catalog does not hold, or that does not parse as a repository
 * key, is not carried. The contract requires every asked repository to be a
 * real key, and a key invented from a model's typo would record a decision
 * about a repository nobody has.
 *
 * An UNUSABLE one is not carried either, and that is the narrower half. The
 * offered catalog deliberately keeps unusable entries, so membership alone
 * would put a repository nothing can clone in front of a person as a choice;
 * naming it writes a permanent `selected` `person` entry that every later run
 * then refuses to attach, and until the panel ships there is no screen on which
 * anyone can take it back.
 *
 * Deduplicated because the contract refuses a repeated key, and a question the
 * contract refuses is one whose ask is dropped.
 */
function candidateAsks(
  proposals: ProposedRepository[],
  catalog: RepositoryCatalogEntry[],
): RepositoryDiscoveryAsk[] {
  const offerable = new Set(
    catalog
      .filter((repository) => repository.usable)
      .map((repository) => repositoryCatalogKey(repository)),
  );
  const asks: RepositoryDiscoveryAsk[] = [];
  for (const proposal of proposals) {
    const key = repositoryCatalogKey(proposal);
    if (!offerable.has(key)) continue;
    const repositoryKey = repositoryKeySchema.safeParse(key);
    if (!repositoryKey.success) continue;
    if (asks.some((ask) => ask.repositoryKey === repositoryKey.data)) continue;
    asks.push({
      repositoryKey: repositoryKey.data,
      // `selection` is the meaning rather than a compromise, and what each
      // answer does is worth stating exactly, because this reads like the
      // reason that decides nothing and it is not.
      //
      // Naming one writes `selected` `person`, which is that person's own
      // decision and survives every later run. A "none" writes NO ENTRY, so the
      // repositories recorded on this work are left exactly as they were: that
      // is the half this reason is chosen for. It is not the same as deciding
      // nothing. A "none" is still an answer to a `selection` question, and an
      // answered `selection` question raises this subject's
      // selection-answered flag PERMANENTLY, which silences two questions for
      // good: this one, above, and the pre-sandbox "which of these"
      // (`decideTextAmbiguous`, `engine/work-scope/decide.ts`). That is the
      // point rather than a side effect, because a question nothing silences is
      // a question every later run asks again.
      reason: "selection",
      rationale: proposal.rationale,
    });
  }
  return asks;
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
    about: [],
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
  reason: Extract<RepositoryDiscoveryAsk["reason"], "not_enabled" | "unusable">,
  rationale: string,
): RepositoryDiscoveryDecision {
  const repositoryKey = repositoryKeySchema.safeParse(key);
  return {
    kind: "clarification_needed",
    // NAMED WHEREVER IT IS RECORDED. This question used to say only "which
    // repository should this ticket use", while the ask beside it was written
    // against the key the model asked for: a person answering "none" to a
    // question that named nothing was recorded as having decided about a
    // repository they never saw, and a later run then silenced the question and
    // failed the ticket telling them they had been asked. So the two say the
    // same thing, and the fallback below is the arm that records nothing.
    questions: [
      repositoryKey.success
        ? unavailableRepositoryQuestion(repositoryKey.data, reason)
        : whichRepositoryQuestion(UNAVAILABLE_REPOSITORY_HINT),
    ],
    reason: "Repository discovery requested an unavailable repository.",
    about: repositoryKey.success
      ? [{ repositoryKey: repositoryKey.data, reason, rationale }]
      : [],
  };
}

/**
 * The one sentence for a repository the catalog cannot give this run, naming it.
 *
 * The name is not decoration: it is what makes the answer a decision about this
 * repository rather than about nothing, and it is the difference between a
 * person being told what is missing and being asked to guess. What to do next
 * differs by arm, so the sentence does too: a repository this deployment does
 * not hold can be enabled, and one it holds and cannot clone cannot be fixed
 * from the Repositories page at all.
 */
// A QUESTION MAY NOT TEACH A PHRASING THE READER REFUSES. Both questions below
// used to end with "or with the repositories this ticket should use instead",
// and a person taking us up on that wrote "acme/web instead of acme/api", which
// says no about one repository and names another. A reply that says no records
// nothing (`readRepositoryAnswer`), so the copy asked for the one answer that
// cannot be read. It now asks for what it can: the repositories to use, and
// nothing else, in the words the ticket comment uses when it explains the same
// rule (`NAME_ONLY_THE_ONES_TO_USE` in `engine/support/clarification-comment-format.ts`).
function unavailableRepositoryQuestion(
  repositoryKey: RepositoryKey,
  reason: Extract<RepositoryDiscoveryAsk["reason"], "not_enabled" | "unusable">,
): string {
  // THE LAST CLAUSE IS "OR" ONLY WHERE THERE IS SOMETHING TO BE OR TO. The
  // enabled arm offers a move, so naming other repositories is the alternative
  // to it. The unusable arm offers none, because nobody can fix a repository
  // the catalog cannot clone from a screen, and "Or name only the repositories
  // to use" after it was an alternative to nothing at all.
  return [
    `Repository discovery asked for ${repositoryKey}, which this run cannot use:`,
    reason === "not_enabled"
      ? `it is not enabled on this deployment. ${enableThemNext(1)} Or name only the repositories to use.`
      : "this deployment holds it but cannot clone it, so no run can use it until that changes. Name only the repositories to use.",
  ].join(" ");
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
  const [refused] = input.decision.about;
  if (!refused || input.subjectKey === null) {
    return { questions: input.decision.questions, ask: null };
  }
  if (refused.reason === "selection") {
    // The model proposed these and was not confident enough to be believed, so
    // the question is a choice among them rather than a refusal of one. Its
    // words are the ones it has said since AIW-147; what is new is that it
    // carries what it named, so the answer settles this subject instead of
    // being dropped for naming no repository (A46).
    return {
      questions: input.decision.questions,
      ask: {
        subjectKey: input.subjectKey,
        askedRepositories: input.decision.about.map((candidate) => ({
          repositoryKey: candidate.repositoryKey,
          askedBecause: candidate.reason,
        })),
      },
    };
  }
  // The validator refuses at the first repository it cannot use, so a refusal
  // is about one repository.
  //
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
  refused: RepositoryDiscoveryAsk,
  excluded: Pick<WorkScopeEntry, "decidedBy" | "decidedAt">,
): string {
  return [
    `${excludedBy(refused.repositoryKey, excluded)}.`,
    `Repository discovery asked for it anyway, because "${theModelsWords(refused.rationale)}".`,
    `Answer with ${refused.repositoryKey} to take that exclusion back and let this run use it,`,
    "or name only the repositories to use.",
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
/**
 * Longest actor label a refusal sentence prints.
 *
 * A DISPLAY BOUND, NOT A VALIDATION RULE, and the distinction is the whole
 * reason it lives here. `workScopeActorSchema` puts no maximum on `actorLabel`
 * and must not grow one: entries are already stored, so a `.max()` added now
 * would make a read of an existing row throw, and a record that cannot be read
 * is worse than a sentence that is long.
 *
 * It is also what makes the sizing claim on MESSAGE_MAX_LENGTH
 * (packages/workflow-graph/failure-message.ts) true rather than nearly true.
 * That bound is measured against three repositories, and the label appears once
 * per repository, so an unbounded label is an unbounded message however few
 * repositories there are.
 *
 * 60 clears every real display name with room to spare: a double-barrelled name
 * plus a team suffix ("Aleksandra Kowalska-Nowakowska (Platform Engineering)")
 * is 57. A label longer than that is cut with a trailing ellipsis rather than
 * silently, because a name shortened without a mark is a different name, and the
 * sentence is telling somebody whose decision they would be revisiting.
 */
const ACTOR_LABEL_MAX_LENGTH = 60;

function actorLabel(actor: WorkScopeActor): string {
  const label = actor.kind === "person" ? actor.actorLabel : `run ${actor.runId}`;
  if (label.length <= ACTOR_LABEL_MAX_LENGTH) return label;
  return `${label.slice(0, ACTOR_LABEL_MAX_LENGTH - 3).trimEnd()}...`;
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
//
// THE CANDIDATES IT NAMES ARE THE ONES THE ANSWER CAN BE RECORDED AGAINST, so
// it takes the asks rather than the proposals. A candidate named here and
// recorded nowhere is a question that comes back every run however it is
// answered, and one recorded here and named nowhere is a decision taken from
// somebody who never saw it.
function candidateClarificationQuestion(asks: RepositoryDiscoveryAsk[]): string {
  const candidates = asks
    .map((ask) => `${ask.repositoryKey} (${ask.rationale})`)
    .join(", ");
  return [
    "Repository discovery was not confident enough to select automatically.",
    "Which repository or repositories should this ticket inspect or modify?",
    "Reply with full provider-scoped paths (for example github:acme/app).",
    `Proposed candidates: ${candidates}.`,
    // WHAT THE ANSWER BINDS, as the which-of-these question says it (A11g):
    // a candidate listed here and left out of the answer is refused to every
    // later guess on this work (`isUnnamedInAnswer`). Only the candidates,
    // because they are the repositories this question puts in front of the
    // person; a path they write beside them binds nothing. No lever, because a
    // question is copied into the agent's prompts and the memory file (rule 7).
    "A proposed candidate you do not name is left out of this work from now on, and no later run takes it on its own.",
  ].join(" ");
}
