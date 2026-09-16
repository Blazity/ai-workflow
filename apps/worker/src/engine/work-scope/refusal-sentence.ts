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
