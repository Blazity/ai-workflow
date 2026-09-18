/**
 * One repository, one refusal, one set of facts, whichever surface asks.
 *
 * A run refuses a repository in two places. The run start refuses what the
 * record already held (`work-scope/context.ts`), and the expansion loop refuses
 * what the model asked for mid run (`repository-discovery/runner.ts`). Until
 * this module existed each place composed its own sentence from its own switch,
 * and the two drifted on FACTS rather than on phrasing: only one named who
 * excluded a repository and when, and one spelled the workspace cap as a word
 * while the other interpolated the constant, so changing the constant made one
 * of them lie.
 *
 * So a sentence is built from two parts and a surface may vary exactly one of
 * them:
 *
 * - WHY the repository is not in the workspace. Identical on both surfaces,
 *   because it is a fact about the repository and not about who is reading.
 * - The CONSEQUENCE, which is the one part a surface owns: a run start says the
 *   run started without it, an expansion says it is not attached.
 *
 * WHAT IS DELIBERATELY NOT HERE: the way back. A refusal sentence reaches the
 * model as well as a person, and a way back is addressed to a person alone. It
 * has a better home than a clause per reason, in `context.ts`
 * (`EXCLUSION_RECOVERY_NOTE`, `catalogCannotServeNote`, `outsidePinNote`,
 * assembled by `exclusionRecoveryNotes`), which reaches the ticket comment and
 * the run's status reason and not the agent's instruction channel, and which
 * says what a per-reason clause cannot: that a repository can be excluded AND
 * unservable at once, so a person who changes the list is not left waiting for
 * a run that still leaves it out. Nothing that renders a sentence here may
 * append a remedy, and `refusal-sentence.test.ts` proves no rendered sentence
 * carries one.
 *
 * Adding a member to `WorkScopeRefusalReason` without a clause is a type error
 * here, and the test also proves at runtime that every member renders a why and
 * that the two surfaces differ in the consequence alone.
 *
 * Engine tier: contracts and engine siblings only. Nothing here reads a
 * database, a clock or the network.
 */
import type {
  RepositoryKey,
  WorkScopeActor,
  WorkScopeRefusalReason,
} from "@shared/contracts";
import { REQUEST_REPOSITORIES_MAX } from "./decide.js";

/**
 * The most repositories one run's workspace holds.
 *
 * It lives here because the sentence that reports the cap is the reason the
 * number ever gets written down for a person to read, and a second spelling of
 * it is the defect this module exists to end. `repository-discovery/runner.ts`
 * imports it for the questions it asks about the same limit.
 */
export const MAX_WORKSPACE_REPOSITORIES = 8;

/** Which of the two refusals is being written. The ONLY thing a surface may
 *  vary, and it varies the consequence clause and nothing else. */
export type WorkScopeRefusalSurface = "run_start" | "expansion";

/** What the record holds about a decision somebody made, where it holds one.
 *  A `WorkScopeEntry` satisfies it, so a caller hands its entry straight in. */
export interface WorkScopeRefusalDecision {
  decidedBy: WorkScopeActor;
  decidedAt: string;
}

/** One repository the run did not take, and why it did not. */
export interface WorkScopeRefusal {
  repositoryKey: RepositoryKey;
  reason: WorkScopeRefusalReason;
}

/** The sentence, before it is joined, so a test can hold the parts apart and a
 *  caller that renders a list can too. */
export interface WorkScopeRefusalParts {
  why: string;
  consequence: string;
}

/** Who decided, as a sentence names them. */
function actorLabel(actor: WorkScopeActor): string {
  return actor.kind === "person" ? actor.actorLabel : `run ${actor.runId}`;
}

/**
 * The day, as a sentence says it. The record stores an instant, and a reader
 * given "2026-09-10T08:30:00.000Z" in a sentence about a person's decision gets
 * precision nobody needs and nothing anybody can act on. Anything that is not
 * an ISO instant is left exactly as it is rather than guessed at.
 */
function plainDate(decidedAt: string): string {
  return /^\d{4}-\d{2}-\d{2}T/u.test(decidedAt) ? decidedAt.slice(0, 10) : decidedAt;
}

/**
 * Why this repository is not in the workspace, one clause per reason.
 *
 * A `Record` rather than a switch, so a member added to the contract without a
 * clause here does not compile. Every clause is true on both surfaces, which is
 * why `outside_catalog` does not claim the repository is recorded on the work:
 * on the expansion path it is a repository the model just named, and the record
 * may never have heard of it.
 *
 * Every number is interpolated from the constant that enforces it. Spelling one
 * as a word is how the run start came to promise a cap the run does not
 * enforce.
 */
const WHY: Record<
  WorkScopeRefusalReason,
  (repositoryKey: RepositoryKey, decision: WorkScopeRefusalDecision | undefined) => string
> = {
  outside_catalog: (repositoryKey) =>
    `${repositoryKey} is not on the repository catalog this run may use`,
  outside_policy: (repositoryKey) =>
    `${repositoryKey} is outside the repositories the workflow that runs this work may take`,
  // WHAT WE RECEIVED, NOT WHAT THE REPOSITORY IS. Three things produce this and
  // only two are about the repository: it is archived, it has no default branch
  // (an empty repository), or the token cannot read its code, which is how
  // GitLab withholds `default_branch` (`Ability.allowed?(:read_code)` on its
  // BasicProjectDetails entity). "Offered no default branch for it" is true in
  // all three; "the repository is empty" would be a guess in the third, and the
  // person would go looking for a fault that is ours.
  unusable: (repositoryKey) =>
    `${repositoryKey} is enabled here, and this run could not check it out: the provider listed it as archived, or offered no default branch for it`,
  // Named, when the record holds the entry. A reader told only "no" has to
  // guess whose decision to revisit, and a widened trigger policy does not
  // reach back into a subject somebody already answered about (A32).
  excluded: (repositoryKey, decision) =>
    decision
      ? `${repositoryKey} was excluded on this work by ${actorLabel(decision.decidedBy)} on ${plainDate(decision.decidedAt)}`
      : `${repositoryKey} was excluded on this work`,
  unavailable: (repositoryKey) => `${repositoryKey} is recorded as unavailable on this work`,
  workspace_cap: (repositoryKey) =>
    `${repositoryKey} does not fit this run's ${MAX_WORKSPACE_REPOSITORIES} repository workspace`,
  request_limit: (repositoryKey) =>
    `${repositoryKey} was past the ${REQUEST_REPOSITORIES_MAX} repositories a single request may name`,
  rounds_exhausted: (repositoryKey) =>
    `${repositoryKey} was asked for after this run had used up its repository expansion rounds`,
  // The one clause that is not written here: a guess refused in a derived
  // event carries no contract reason, and the two must read the same.
  unnamed_in_answer: (repositoryKey) => workScopeUnnamedWhy(repositoryKey),
};

/** The one part a surface owns. */
const CONSEQUENCE: Record<WorkScopeRefusalSurface, string> = {
  run_start: "so the run started without it",
  expansion: "so it is not attached",
};

/** The two parts, for a caller or a test that wants them apart. */
export function workScopeRefusalParts(
  refusal: WorkScopeRefusal,
  surface: WorkScopeRefusalSurface,
  decision?: WorkScopeRefusalDecision,
): WorkScopeRefusalParts {
  return {
    why: WHY[refusal.reason](refusal.repositoryKey, decision),
    consequence: CONSEQUENCE[surface],
  };
}

/**
 * The sentence a person, and on both surfaces the model, actually reads.
 *
 * `repository-discovery/runner.ts` and `work-scope/context.ts` both render from
 * here, which is the whole point: a fact one surface carries is a fact the
 * other carries too. It states what happened and stops there; what a person can
 * do about it travels the person's channel, never this one.
 */
export function workScopeRefusalSentence(
  refusal: WorkScopeRefusal,
  surface: WorkScopeRefusalSurface,
  decision?: WorkScopeRefusalDecision,
): string {
  const parts = workScopeRefusalParts(refusal, surface, decision);
  return `${parts.why}, ${parts.consequence}.`;
}

/**
 * Why a guess did not take a repository an answer left unnamed
 * (`isUnnamedInAnswer` in `decide.ts`).
 *
 * `WHY.unnamed_in_answer` renders from here, which is how the agent's refused
 * request and a guess refused before any request say the same thing. The
 * derived guesses cannot use the contract reason themselves: a refusal there
 * writes a trail line, and those write none (`WorkScopeDecision.unnamed`).
 *
 * It names neither who answered nor when. The run holds the answered set as
 * keys alone, and a sentence that guessed at a name or a day would be a
 * fabrication about a person. It does not say "did not name it" either: the
 * same fact is true of a repository somebody named and whose entry a person
 * later removed, and there that clause would be false. What stays true in both
 * cases is what it says.
 */
export function workScopeUnnamedWhy(repositoryKey: RepositoryKey): string {
  return `${repositoryKey} was listed in a repository question already answered on this work and is not selected on it`;
}

/**
 * The unnamed repository a person DID write about after the answer, in a comment
 * that also says no, so the comment was not read as naming it.
 *
 * Run start only: it is the pre-sandbox that reads the ticket's comments. It
 * names no way back, because this sentence reaches the agent's prompt too
 * (rule 7); the way back rides the recovery note beside it.
 */
export function workScopeUnnamedSaidNoSentence(repositoryKey: RepositoryKey): string {
  return `${workScopeUnnamedWhy(repositoryKey)}, and the newest comment written after that answer that names it also says no, so the run did not read that comment as naming it and started without it.`;
}

/**
 * A repository named in a ticket comment the run did not read, because that
 * comment also says no about a repository.
 *
 * The comment is read whole, so this sentence says a repository was named in
 * one and nothing more: which of the paths in it the person meant to refuse is
 * exactly what the reader cannot tell, and a sentence that guessed would tell
 * the person they said something they did not.
 *
 * Run start only, and it names no way back (rule 7): this sentence reaches the
 * agent's prompt, and the way back rides the recovery note beside it.
 */
export function workScopeCommentSaidNoSentence(repositoryKey: RepositoryKey): string {
  return `${repositoryKey} is named in a ticket comment that also says no about a repository, so the run read nothing from that comment and started without it.`;
}

/**
 * The repository the ticket's own words name only where they say no.
 *
 * "Do NOT touch github:acme/api, it is frozen." used to attach api and say
 * nothing at all, so the run worked in the one repository the ticket had told
 * it to leave alone. The ticket is read a sentence at a time, and a repository
 * whose every mention sits in a sentence that says no is not taken from the
 * ticket; this is the run saying so. It names no way back (rule 7).
 */
export function workScopeTicketSaidNoSentence(repositoryKey: RepositoryKey): string {
  return `${repositoryKey} is named in this ticket only where its text says no about a repository, so the run did not take it from the ticket and started without it.`;
}

/**
 * The repository a person wrote the path of after answering, on a ticket that
 * names more repositories than one run chooses between.
 *
 * The run took nothing from the ticket's text, and it did not ask which to
 * start from either, because this work already carries an answer to that
 * question. Both halves are here, because either one alone reads as a run that
 * simply ignored what somebody wrote.
 *
 * Run start only, and it names no way back (rule 7): that rides the recovery
 * note, which is the one channel that may say writing another comment will not
 * help.
 */
export function workScopeTooManyOpenSentence(repositoryKey: RepositoryKey): string {
  return `${repositoryKey} is named in a ticket comment written after the answer on this work, and this run did not take it: the ticket names more repositories this work has not decided than one run chooses between, so the run took none of them from its text, and the question about which to start from was already answered here.`;
}

/** The unnamed repository as a sentence, with the surface's consequence. */
export function workScopeUnnamedSentence(
  repositoryKey: RepositoryKey,
  surface: WorkScopeRefusalSurface,
): string {
  return `${workScopeUnnamedWhy(repositoryKey)}, ${CONSEQUENCE[surface]}.`;
}
