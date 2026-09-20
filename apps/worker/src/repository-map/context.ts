/**
 * THE ONE PLACE A SEND'S REPOSITORY MAP INPUT IS BUILT.
 *
 * Every repository-working phase describes the same repositories, so every one
 * of them reads this function. It used to be built twice, once in
 * `engine/agent-workflow.ts` for research, implementation and review and once
 * by hand in `engine/blocks/fix-agent/execute.ts`, and the two had already
 * drifted: a repository a question had put in front of a person was
 * `offered_by_question` for research and `catalog` for the fix agent on the
 * same run, which is one run telling a person two stories.
 *
 * BUILT PER SEND, NEVER ONCE PER BLOCK. What a run knows about its
 * repositories changes while the block runs: the planning loop refuses a
 * request in pass one, and pass two must not invite the model to ask for that
 * repository again. A context computed before the first send is frozen at the
 * emptiest moment of the run, which is how the map reached research,
 * implementation and review saying "the repository map was not available" on
 * every real run: the run's own map is only assigned when the workspace is
 * prepared, and that happens after the value had already been read.
 *
 * NO ENGINE IMPORT. The run's facts are described structurally rather than
 * imported as `EngineCtx`, so this module and the prompt composer both sit
 * below the engine instead of beside it. That is what keeps the engine and the
 * composer from importing each other around this file.
 */
import { isUnnamedInAnswer, type RepositoryKey, type WorkScopeEntry, type WorkScopeRefusalReason } from "@shared/contracts";
import { SETTLING_REFUSAL_REASONS, type RepositoryMapContext, type RepositoryMapFacts } from "./map.js";

/** What a run carries about its repositories, as much of it as this needs.
 *  `EngineCtx` satisfies this without knowing the type exists. */
export interface RepositoryMapRunFacts {
  repositoryMap: {
    repositories: readonly RepositoryMapFacts[];
    relationshipsUnreadable?: boolean;
    catalogUnreadable?: boolean;
  } | null;
  workScopeTicketText?: { matchedKeys: readonly RepositoryKey[] } | undefined;
  workScopeAsk?: { askedRepositories: readonly { repositoryKey: string }[] } | undefined;
  workScope?:
    | {
        scope: { entries: readonly WorkScopeEntry[] } | null;
        /** Repositories a question that a person ANSWERED listed. An open
         *  question is not here: it tells us nothing about anybody's intent,
         *  and a repository in one is still genuinely requestable. */
        answeredRepositoryKeys?: readonly string[];
      }
    | undefined;
  repositories: { activated: boolean };
}

/** One repository this run asked for and did not get. */
export interface RunRepositoryRefusal {
  repositoryKey: string;
  reason: WorkScopeRefusalReason;
}

export interface RepositoryMapContextInput {
  /**
   * Whether THIS send can attach a repository. Only a research pass with the
   * expansion still open can; implementation, review, the fix agent and the
   * generic agent have no channel for it, and telling them otherwise buys an
   * output field nobody reads and a pass spent filling it in.
   */
  expansionOpen: boolean;
  /**
   * What the run has refused SO FAR, live. The record's frozen left-out list
   * is the floor and not the whole truth: a refusal made in pass one exists
   * only inside the loop until the run ends.
   */
  leftOut?: readonly { repositoryKey: string; reason: string }[];
  /** The same refusals with their reason, so the map can tell the ones that
   *  settle a repository from the ones that refused only this request. */
  refusals?: readonly RunRepositoryRefusal[];
}

const SETTLING = new Set<string>(SETTLING_REFUSAL_REASONS);

/**
 * What the sends of this run describe: what the run gathered before the
 * sandbox, plus everything it has decided since.
 *
 * Undefined means this run holds no map at all: a journal from before the map
 * existed, or a pre-sandbox configuration with no repository selection. The
 * composer then says the map was not available for this send rather than
 * rendering an empty catalog, which would claim there is nothing to look at.
 */
export function repositoryMapContext(
  facts: RepositoryMapRunFacts,
  input: RepositoryMapContextInput,
): RepositoryMapContext | undefined {
  const map = facts.repositoryMap;
  if (!map) return undefined;
  const refusedKeys = [
    ...new Set(
      (input.refusals ?? [])
        .filter((refusal) => SETTLING.has(refusal.reason))
        .map((refusal) => refusal.repositoryKey),
    ),
  ];
  // A repository a question the person already answered listed, and that
  // nothing on the record has chosen since. The record writes NO ENTRY for a
  // name an answer left out, so without this the map read such a repository
  // off the catalog as `offered`, invited a request, and the run refused the
  // request it had just invited. The predicate is the one in
  // `@shared/contracts` that the rule refusing that request also reads, so the
  // map and the rule cannot disagree about which repositories these are.
  const entries = facts.workScope?.scope?.entries ?? [];
  const answered = facts.workScope?.answeredRepositoryKeys ?? [];
  const unnamedInAnswerKeys = map.repositories
    .map((repository) => repository.key)
    .filter((key) => isUnnamedInAnswer(key, answered, entries));
  return {
    repositories: map.repositories,
    ...(map.relationshipsUnreadable ? { relationshipsUnreadable: true } : {}),
    ...(map.catalogUnreadable ? { silence: "catalog_unreadable" as const } : {}),
    namedKeys: [...(facts.workScopeTicketText?.matchedKeys ?? [])],
    offeredKeys: (facts.workScopeAsk?.askedRepositories ?? []).map((asked) => asked.repositoryKey),
    entries,
    leftOut: input.leftOut ?? [],
    ...(refusedKeys.length > 0 ? { refusedKeys } : {}),
    ...(unnamedInAnswerKeys.length > 0 ? { unnamedInAnswerKeys } : {}),
    catalogActivated: facts.repositories.activated,
    ...(input.expansionOpen ? { expansionOpen: true } : {}),
  };
}
