import {
  workScopeOriginRank,
  type RepositoryKey,
  type TriggerRepositoryPolicy,
  type VcsProviderKind,
  type WorkScope,
  type WorkScopeActor,
  type WorkScopeAskReason,
  type WorkScopeAskedRepository,
  type WorkScopeEditRequest,
  type WorkScopeEntry,
  type WorkScopeEntryState,
  type WorkScopeOrigin,
  type WorkScopeQuestionAnswer,
  type WorkScopeRefusalReason,
  type WorkScopeTrailEvent,
  type WorkScopeUnavailableReason,
  type WorkScopeWritePlan,
} from "@shared/contracts";

// The same workspace bound the expansion protocol enforces
// (repository-discovery/runner.ts). It bounds one run's workspace, never the
// record: a subject may hold more selections than one workspace takes.
const WORKSPACE_REPOSITORIES_MAX = 8;
// Requests beyond this many at once are refused back to the model, never
// turned into a question nobody could record an answer to.
export const REQUEST_REPOSITORIES_MAX = 3;
// What the caller may pass per event. Together these keep every plan inside
// the contract's 16 upserts, 16 deletes and 32 trail events.
const EVENT_KEYS_MAX = 8;
const PLAN_TRAIL_MAX = 32;
const RATIONALE_MAX_LENGTH = 500;

/**
 * How many repositories a delegation may take, and it is the SAME number that
 * made the question get asked.
 *
 * The which-of-these question exists because more than `TEXT_MATCH_AMBIGUITY_LIMIT`
 * repositories were open (`engine/work-scope/context.ts`), so taking more than
 * that on somebody's behalf would work around the very bound the question was
 * raised to respect. Spelled here rather than imported, because `context.ts`
 * imports this module and the import back would close a cycle; the two are
 * pinned to each other by a test.
 */
export const DELEGATION_REPOSITORIES_MAX = 3;

const REQUESTED_RATIONALE = "Requested by the agent.";
const NAMED_RATIONALE = "Named in the answer to a repository question.";
/** Whose request this choice was made at. The name is theirs and the decision
 *  is ours, which is exactly what the origin `delegated` says and what a
 *  `person` origin would get wrong. */
function delegatedRationale(actor: WorkScopeActor): string {
  const who = actor.kind === "person" ? actor.actorLabel : `run ${actor.runId}`;
  return `Chosen by the workflow because ${who} asked it to decide.`;
}
const LEFT_OUT_RATIONALE: Record<Exclude<WorkScopeAskReason, "selection">, string> = {
  not_enabled: "Left out of the answer to a question asked because it was not enabled.",
  unusable: "Left out of the answer to a question asked because it could not be used.",
  outside_policy:
    "Declined in the answer to a question asked because the trigger policy did not include it.",
};

export interface WorkScopeDecisionContext {
  /** null: no record yet, or a subject that carries none. */
  scope: WorkScope | null;
  /** A ticket, a pull request, or a webhook delivery with a resolved subject id. */
  carriesRecord: boolean;
  /** `unusableKeys` null: this path never listed the repositories, so enabled
   *  counts as usable and an `unavailable` `unusable` entry does not expire
   *  here, because nothing observed that it became usable. */
  catalog: { activated: boolean; enabledKeys: RepositoryKey[]; unusableKeys: RepositoryKey[] | null };
  /** The definition pin's providers, null when it names none. */
  pinnedProviders: VcsProviderKind[] | null;
  /** The definition pin's repositories, null when it names none. */
  pinnedKeys: RepositoryKey[] | null;
  /** Resolved. null only for `answered`, `edited` and a subject that carries no
   *  record. */
  policy: TriggerRepositoryPolicy | null;
  /** The candidates of `event_repository_and_related`, empty otherwise. The
   *  relationship graph is a fact about repositories, not about what the
   *  catalog enables, so the caller passes related keys that are not usable
   *  too: a request for one of them is then asked about as `not_enabled` or
   *  `unusable`, whose answer expires, rather than as `outside_policy`. */
  eventRelatedKeys: RepositoryKey[];
  /** What the workspace holds now; null outside a run. */
  attachedKeys: RepositoryKey[] | null;
  /** The subject's trail holds an answer to a selection question. */
  selectionAnswered: boolean;
  /** The repositories a question on this subject NAMED and somebody answered
   *  (`readWorkScopeAnsweredRepositories` in `db/repositories/work-scope.ts`).
   *  Read with the entries, because the two together say what an answer left
   *  unnamed (`isUnnamedInAnswer`). A caller that decides no guess, an edit or an
   *  answer, passes an empty list and says why. */
  answeredRepositoryKeys: readonly RepositoryKey[];
  /** The repositories whose full path a PERSON wrote on this subject AFTER the
   *  answer was decided. The one thing that lets a text match attach a key the
   *  answer left unnamed (`decideDerived`): the ticket's own description raised
   *  that question, so re-reading it decides nothing, while somebody typing the
   *  path afterwards is a new decision and is what the recovery sentence asks
   *  them to do. Empty is the safe reading and the only one a caller that
   *  derives no ticket text needs; a caller that cannot date a match passes it
   *  empty and says why. */
  postAnswerMentionedKeys: readonly RepositoryKey[];
  actor: WorkScopeActor;
  now: string;
}

export type WorkScopeDecisionEvent =
  | { kind: "run_started" }
  | { kind: "resumed"; repositoryKeys: RepositoryKey[] }
  /** An EMPTY `repositoryKeys` is the caller saying the evidence is gone, which
   *  is why it deletes that origin's entries. Stage 4 emits it only when the
   *  matcher found nothing at all, never when it found matches it could not
   *  decide between: those raise `text_ambiguous`. */
  | {
      kind: "derived";
      origin: "workflow_owned_branch" | "ticket_text" | "trigger_policy" | "inferred";
      repositoryKeys: RepositoryKey[];
      /** Repositories this origin's evidence still names and this event does
       *  NOT attach: they are not decided here, and their entries are not
       *  deleted either. The one caller is the ticket text scan, which stops
       *  reading a comment that says no about a repository: the words are still
       *  on the ticket, so what an earlier run derived from them is not
       *  evidence that went away, and deleting it would take a repository off
       *  every later run with nobody's decision behind it. */
      stillNamedKeys?: RepositoryKey[];
      rationale: string;
    }
  | { kind: "text_ambiguous"; matchedKeys: RepositoryKey[] }
  | { kind: "requested"; repositoryKeys: RepositoryKey[] }
  | {
      kind: "answered";
      clarificationId: string;
      asked: WorkScopeAskedRepository[];
      /** As read by readRepositoryAnswer. */
      answer: WorkScopeQuestionAnswer;
    }
  | { kind: "edited"; changes: WorkScopeEditRequest["changes"] };

export interface WorkScopeDecision {
  plan: WorkScopeWritePlan;
  attach: RepositoryKey[];
  ask: WorkScopeAskedRepository[];
  refused: Array<{ repositoryKey: RepositoryKey; reason: WorkScopeRefusalReason }>;
  editRejected: Array<{ repositoryKey: RepositoryKey; reason: "not_enabled" }>;
  /** Refusals `refused` lists that the plan's trail bound left out, so the
   *  caller can say how many more there were instead of dropping them in
   *  silence. */
  trailTruncated: number;
  /**
   * Keys a guess named that an answer on this subject left unnamed, in input
   * order, and present only when there is one.
   *
   * Apart from `refused` because the refusal vocabulary is a contract and has
   * no reason meaning this, and because it writes NO trail line: the trail
   * already holds the question and the answer that explain it, and a remembered
   * routing answer is recomputed on every run, so a line per run would repeat
   * the same fact forever. The caller still says it, keyed, to a person.
   */
  unnamed?: RepositoryKey[];
  /**
   * The matched repositories a which-of-these question did NOT offer, because
   * this work already holds them: the record has them selected, by a run's
   * reading of the ticket, a trigger policy or a branch, and the run start
   * attached them. A reply cannot remove them (`decideAnswered` removes a guess
   * and nothing else), so offering them as choices would put a decision in
   * front of a person that their answer does not make. The caller names them in
   * the question as already taken. `text_ambiguous` only, and only beside an
   * ask.
   */
  alreadyTaken?: RepositoryKey[];
}

/**
 * Did an answer on this subject leave this repository unnamed, with nothing on
 * the record choosing it since?
 *
 * THE ONE RULE for what a guess may not take back. A which-of-these question
 * (`selection`) writes no entry for a repository its answer did not name, by
 * design, so the only trace of that omission is the pair: the key is in the
 * answered set, which holds only keys the question put in front of a person,
 * and the record holds no entry for it. Every other asked reason writes an
 * entry whatever the answer said (`decideAnswered`: `unavailable` for
 * `not_enabled` and `unusable`, `excluded` for `outside_policy`, `selected`
 * `person` for a named key), and that entry governs instead, which is what lets
 * "enable it and start a new run" work for a repository an answer recorded as
 * unavailable.
 *
 * WHAT IT BINDS: guesses, which are a remembered routing answer and the
 * only-accessible shortcut here, and every discovery proposal
 * (`repository-discovery/protocol.ts`). It binds a ticket text match too, for
 * as long as the only text naming the repository is text that predates the
 * answer: a person who writes the full path in a comment afterwards has decided
 * again, and `boundByTheAnswer` is where that one exception is spelled. A
 * workflow-owned branch, a definition pin and a trigger policy are not guesses,
 * and a person's selection writes an entry, so none of those is bound.
 *
 * A GUESS'S OWN ENTRY IS NOT AN ENTRY HERE. An earlier run may have written
 * `selected` `inferred` for the repository before anybody was asked, and read
 * as an entry it would shield the key from this rule forever: the answer writes
 * nothing for a name it left out, so the pair never forms and every later guess
 * takes the repository again. That is the state every subject answered before
 * this rule shipped is in. A guess is also the one entry no person stands
 * behind, and run start already refuses to furnish a workspace from it
 * (`decideRunStart`), so treating it as absent here takes nothing away from
 * anybody. The answer-time removal (`decideAnswered`, reason `selection`) still
 * deletes it, which keeps the record honest rather than merely ignored.
 *
 * ALSO TRUE AFTER AN EDIT REMOVED THE ENTRY. The trail cannot tell an omission
 * from a named repository whose entry a person later removed, and removing an
 * entry does not unmake an answer (the which-of-these question stays silenced
 * for the same reason), so both read as unnamed. The cost of that reading is a
 * guess not taken and a sentence saying so; the other reading would take back
 * an omission somebody made.
 */
export function isUnnamedInAnswer(
  repositoryKey: RepositoryKey,
  answeredRepositoryKeys: readonly RepositoryKey[],
  entries: readonly WorkScopeEntry[],
): boolean {
  if (!answeredRepositoryKeys.includes(repositoryKey)) return false;
  return entries
    .filter((entry) => entry.repositoryKey === repositoryKey)
    .every(isGuessEntry);
}

/** The one entry shape no person stands behind: a repository a run picked for
 *  itself. Every other entry is a decision somebody or something took. */
export function isGuessEntry(entry: WorkScopeEntry): boolean {
  return entry.state === "selected" && entry.origin === "inferred";
}

/**
 * A repository this work already holds for a reason an answer does not undo: a
 * `selected` entry that is not a guess (a person's own, a path written in the
 * ticket, a trigger policy, a workflow-owned branch).
 *
 * One predicate for the two places that must agree on it: the which-of-these
 * question, which names such a repository as kept rather than offering it
 * (`decideTextAmbiguous`), and the reader of the reply, which must never take a
 * no written beside it as a redirect (`keptKeys` in
 * `services/work-scope/from-answer.ts`).
 */
export function isHeldSelection(entry: WorkScopeEntry): boolean {
  return entry.state === "selected" && !isGuessEntry(entry);
}

/**
 * The whole work scope decision in one pure function: given the record, the
 * catalog snapshot the run froze, the trigger policy and one event, it returns
 * the write plan the store applies and what the caller attaches, asks or
 * refuses. Nothing here reads a database, a clock or the network, and every
 * output keeps input order, so a replayed run computes the identical plan.
 *
 * Throws only on a programming error: an answer or an edit on a subject that
 * carries no record, or more keys than the caller may pass.
 */
export function decideWorkScope(
  context: WorkScopeDecisionContext,
  event: WorkScopeDecisionEvent,
): WorkScopeDecision {
  assertDecidable(context, event);
  const facts = readFacts(context);
  const decision = recordDecision(context, facts);
  switch (event.kind) {
    case "run_started":
      decideRunStart(context, facts, decision, null);
      break;
    case "resumed":
      decideRunStart(context, facts, decision, new Set(event.repositoryKeys));
      break;
    case "derived":
      decideDerived(context, facts, decision, event);
      break;
    case "text_ambiguous":
      decideTextAmbiguous(context, facts, decision, event.matchedKeys);
      break;
    case "requested":
      decideRequested(context, facts, decision, event.repositoryKeys);
      break;
    case "answered":
      decideAnswered(context, decision, event);
      break;
    case "edited":
      decideEdited(facts, decision, event.changes);
      break;
  }
  return decision.finish();
}

function assertDecidable(context: WorkScopeDecisionContext, event: WorkScopeDecisionEvent): void {
  if (event.kind === "answered" || event.kind === "edited") {
    if (!context.carriesRecord) {
      throw new Error(
        `decideWorkScope: an ${event.kind} event needs a subject that carries a work scope record.`,
      );
    }
  } else if (context.policy === null && context.carriesRecord) {
    // The caller always has one, the trigger kind default when the node
    // configures none. Treating a missing policy as "no candidates" would
    // start a run with no repositories and look like a product decision. A
    // subject that carries no record is the exception: an approved plan runs
    // from its frozen snapshot, and its trigger may not hold a policy at all.
    throw new Error(`decideWorkScope: a ${event.kind} event needs a resolved trigger policy.`);
  }
  const counts: Array<[string, number]> =
    event.kind === "derived"
      ? [["derived", event.repositoryKeys.length]]
      : event.kind === "text_ambiguous"
        ? [["matched", event.matchedKeys.length]]
        : event.kind === "answered"
          ? [
              ["asked", event.asked.length],
              [
                "named",
                event.answer.kind === "repositories" || event.answer.kind === "delegated"
                  ? event.answer.repositoryKeys.length
                  : 0,
              ],
            ]
          : [];
  for (const [what, count] of counts) {
    if (count > EVENT_KEYS_MAX) {
      throw new Error(
        `decideWorkScope: at most ${EVENT_KEYS_MAX} ${what} keys may be decided at once, got ${count}.`,
      );
    }
  }
}

type Facts = ReturnType<typeof readFacts>;

function readFacts(context: WorkScopeDecisionContext) {
  const enabled = new Set(context.catalog.enabledKeys);
  const unusable =
    context.catalog.unusableKeys === null ? null : new Set(context.catalog.unusableKeys);
  const entries = new Map(
    (context.scope?.entries ?? []).map((entry) => [entry.repositoryKey, entry] as const),
  );
  const isEnabled = (key: RepositoryKey) => enabled.has(key);
  const isUsable = (key: RepositoryKey) =>
    enabled.has(key) && (unusable === null || !unusable.has(key));
  // The definition pin is a capability bound, like the catalog: the run strips
  // anything outside it anyway, and nothing outside it is ever asked about. It
  // names repositories as well as providers, which is why both halves bind.
  const isInPin = (key: RepositoryKey) =>
    (context.pinnedProviders === null ||
      context.pinnedProviders.some((provider) => key.startsWith(`${provider}:`))) &&
    (context.pinnedKeys === null || context.pinnedKeys.includes(key));
  /**
   * Reachable, for a repository arriving under a known origin.
   *
   * ONE ORIGIN IS EXEMPT FROM THE PIN: a workflow owned branch. The run already
   * attaches that repository whatever the pin says, because dropping it strands
   * the open pull request on that branch, so refusing it here would not remove
   * it from the workspace. It would only make the run tell a person that a
   * repository it is standing in is outside what this trigger may take.
   * Everything else, a person's own selection included, stays inside the pin.
   */
  const isReachable = (key: RepositoryKey, origin?: WorkScopeOrigin) =>
    isUsable(key) && (isInPin(key) || origin === "workflow_owned_branch");
  const isCandidate = (key: RepositoryKey): boolean => {
    const candidates = context.policy?.candidates;
    if (!candidates) return false;
    switch (candidates.kind) {
      case "enabled_catalog":
        return isUsable(key);
      case "event_repository_and_related":
        return context.eventRelatedKeys.includes(key);
      case "listed":
        return candidates.repositoryKeys.includes(key);
    }
  };
  /** What the policy would attach if the catalog held the repository: the
   *  candidate set read WITHOUT usability, plus the attach rule. It decides why
   *  a repository that is not usable is asked about or refused, and the two
   *  reasons record different things forever: `not_enabled` records an
   *  `unavailable` entry that expires on the enable, `outside_policy` records
   *  an exclusion that never expires. A key outside the candidate set ONLY
   *  because the catalog does not hold it must therefore never be asked about
   *  as outside the policy. */
  const wouldAttachIfUsable = (key: RepositoryKey): boolean => {
    const candidates = context.policy?.candidates;
    if (!candidates) return false;
    if (context.policy?.expansion === "attach") return true;
    switch (candidates.kind) {
      case "enabled_catalog":
        return true;
      case "event_repository_and_related":
        return context.eventRelatedKeys.includes(key);
      case "listed":
        return candidates.repositoryKeys.includes(key);
    }
  };
  // Only `answered` and `edited` reach this without a policy, and they ignore it.
  const expansion = context.policy?.expansion ?? "never";
  // Only a key that has since become usable expires. Nothing not_enabled
  // expires on a bridge catalog, where every repository answers enabled and an
  // expiry would ask the person a second time; and nothing unusable expires
  // where the path listed no repositories, because there "usable" is an
  // assumption rather than something observed.
  const isExpired = (entry: WorkScopeEntry) =>
    entry.state === "unavailable" &&
    isUsable(entry.repositoryKey) &&
    (entry.unavailableReason === "not_enabled" ? context.catalog.activated : unusable !== null);
  /** The entry a decision reads: an expired entry behaves as if there were none. */
  const liveEntryOf = (key: RepositoryKey): WorkScopeEntry | undefined => {
    const entry = entries.get(key);
    return entry && !isExpired(entry) ? entry : undefined;
  };
  const isUnnamed = (key: RepositoryKey) =>
    isUnnamedInAnswer(key, context.answeredRepositoryKeys, context.scope?.entries ?? []);
  const isMentionedAfterAnswer = (key: RepositoryKey) =>
    context.postAnswerMentionedKeys.includes(key);
  return {
    entries,
    isEnabled,
    isUsable,
    isInPin,
    isReachable,
    isCandidate,
    wouldAttachIfUsable,
    expansion,
    isExpired,
    liveEntryOf,
    isUnnamed,
    isMentionedAfterAnswer,
  };
}

/** A person outranks a default made for machines, and a workflow owned branch
 *  must never strand its open pull request. A delegated choice rides with the
 *  person's: it was made over repositories they were shown, at their request,
 *  so a later run that narrowed its policy may not quietly drop it while
 *  keeping the identical choice they had typed themselves. */
function isExemptOrigin(origin: WorkScopeOrigin): boolean {
  return origin === "person" || origin === "delegated" || origin === "workflow_owned_branch";
}

/**
 * WHICH REPOSITORIES A DELEGATION TAKES, decided by us and never by a model.
 *
 * The rule in one place, read by the decision that writes the entries and by
 * the sentence that tells the person what happened, so the two cannot come to
 * disagree about one reply.
 *
 * Four bounds, each of them a thing a person did not ask for:
 *
 * - THE QUESTION'S OWN ORDER AND NOTHING ELSE. A delegation is an instruction
 *   to choose among what was put in front of them, so the candidates are the
 *   question's, in the order it listed them. No ranking of our own invention:
 *   a preference nobody can see is a decision nobody can argue with.
 * - `named` ONLY. A key the question's words never spelled out is a key nobody
 *   was shown, so it is not part of what they handed over (rule 3).
 * - WHAT THE RUN COULD ACTUALLY USE. `selection` is the one ask reason that
 *   means the run could have taken the repository; `not_enabled`, `unusable`
 *   and `outside_policy` each mean it could not, and choosing one of those on
 *   somebody's behalf would record a decision that cannot be acted on. A
 *   question made entirely of those takes nothing, which is the honest answer:
 *   the run continues without them, exactly as a decline of one would have it
 *   continue, and nothing permanent is written in that person's name.
 * - NOTHING A PERSON ALREADY DECIDED. The question was asked before somebody
 *   selected or excluded one of its repositories themselves (on the panel, or
 *   answering another run's question on the same ticket), and "you decide"
 *   hands over what is still open, not that decision. Such a key is skipped
 *   without counting towards the limit, whatever its state; the store refuses
 *   the overwrite as well (`overwriteAllowed` in `db/repositories/work-scope.ts`),
 *   and this is what keeps the reply from claiming a choice the record did not
 *   take.
 */
export function repositoriesADelegationTakes(
  asked: readonly WorkScopeAskedRepository[],
  entries: readonly WorkScopeEntry[],
): RepositoryKey[] {
  const taken: RepositoryKey[] = [];
  for (const repository of asked) {
    if (repository.named !== true) continue;
    if (repository.askedBecause !== "selection") continue;
    if (isDecidedByAPerson(entries, repository.repositoryKey)) continue;
    if (taken.includes(repository.repositoryKey)) continue;
    taken.push(repository.repositoryKey);
    if (taken.length === DELEGATION_REPOSITORIES_MAX) break;
  }
  return taken;
}

/** Whether a person's own entry holds the key, which a delegated write may
 *  never replace. One predicate for the rule that takes the keys, the write
 *  that records them and the reply that names what was left alone. */
export function isDecidedByAPerson(entries: readonly WorkScopeEntry[], key: RepositoryKey): boolean {
  return entries.some((entry) => entry.repositoryKey === key && entry.origin === "person");
}

/** Allowed: the key is a candidate, or the expansion rule attaches, or the
 *  record already holds it as a selection a policy may not filter. */
function isAllowed(facts: Facts, entry: WorkScopeEntry | undefined, key: RepositoryKey): boolean {
  return facts.isCandidate(key) || facts.expansion === "attach" || isExemptSelection(entry);
}

/** What "allowed" would say if the catalog held the repository. It separates
 *  the two reasons a key sits outside the candidate set, and the separation is
 *  permanent: declined after a `not_enabled` question a key is recorded
 *  `unavailable` and expires on the enable, declined after an `outside_policy`
 *  question it is recorded `excluded` and never does. */
function isAllowedIfUsable(
  facts: Facts,
  entry: WorkScopeEntry | undefined,
  key: RepositoryKey,
): boolean {
  return facts.wouldAttachIfUsable(key) || isExemptSelection(entry);
}

function isExemptSelection(entry: WorkScopeEntry | undefined): boolean {
  return entry?.state === "selected" && isExemptOrigin(entry.origin);
}

/** Why a live entry answers a request without asking anyone, or null when it
 *  does not. */
function blockingReason(entry: WorkScopeEntry | undefined): WorkScopeRefusalReason | null {
  if (entry?.state === "excluded") return "excluded";
  if (entry?.state === "unavailable") return "unavailable";
  return null;
}

/**
 * The keys of `keys` still open to a decision, once each and in input order:
 * reachable, and carrying no live entry that already answers for them (an
 * expired entry answers for nothing).
 *
 * The one definition of "open", read by two callers. The which-of-these
 * question offers exactly these keys, and the run's recorder
 * (`createRunWorkScopeRecorder` in `context.ts`, `decidableKeys`) counts them
 * BEFORE it decides whether there is an ambiguity at all, and narrows the
 * catalog discovery offers by them. A second copy of the rule is how the count
 * and the question would come to disagree about the same repository.
 */
export function decidableWorkScopeKeys(
  context: WorkScopeDecisionContext,
  keys: readonly RepositoryKey[],
): RepositoryKey[] {
  return openKeys(readFacts(context), keys);
}

function openKeys(facts: Facts, keys: readonly RepositoryKey[]): RepositoryKey[] {
  return [...new Set(keys)].filter(
    (key) => facts.isReachable(key) && blockingReason(facts.liveEntryOf(key)) === null,
  );
}

type Recorded =
  | { kind: "upsert"; upsert: WorkScopeWritePlan["upserts"][number]; event: WorkScopeTrailEvent }
  | { kind: "delete"; deletion: WorkScopeWritePlan["deletes"][number]; event: WorkScopeTrailEvent }
  | { kind: "refusal"; event: WorkScopeTrailEvent }
  | { kind: "answer"; event: WorkScopeTrailEvent };

type DecisionRecorder = ReturnType<typeof recordDecision>;

function recordDecision(context: WorkScopeDecisionContext, facts: Facts) {
  const recorded: Recorded[] = [];
  const attach: RepositoryKey[] = [];
  const ask: WorkScopeAskedRepository[] = [];
  const refused: WorkScopeDecision["refused"] = [];
  const editRejected: WorkScopeDecision["editRejected"] = [];
  const unnamed: RepositoryKey[] = [];
  const alreadyTaken: RepositoryKey[] = [];
  const refusedOnce = new Set<string>();
  const attached = new Set(context.attachedKeys ?? []);

  return {
    isAttached: (key: RepositoryKey) => attached.has(key),
    // Counted on the workspace, including what this event already attached.
    hasRoom: () => attached.size < WORKSPACE_REPOSITORIES_MAX,
    attach(key: RepositoryKey) {
      attached.add(key);
      attach.push(key);
    },
    ask(repositoryKey: RepositoryKey, askedBecause: WorkScopeAskReason) {
      ask.push({ repositoryKey, askedBecause });
    },
    refuse(repositoryKey: RepositoryKey, reason: WorkScopeRefusalReason) {
      // One event refuses a repository for a reason once; the same line twice
      // says nothing more and costs a trail row that a refusal elsewhere needs.
      if (refusedOnce.has(`${repositoryKey} ${reason}`)) return;
      refusedOnce.add(`${repositoryKey} ${reason}`);
      refused.push({ repositoryKey, reason });
      recorded.push({ kind: "refusal", event: { kind: "request_refused", repositoryKey, reason } });
    },
    rejectEdit(repositoryKey: RepositoryKey) {
      editRejected.push({ repositoryKey, reason: "not_enabled" });
    },
    /** A guess the answer left unnamed: said to the caller, never to the trail
     *  (see `WorkScopeDecision.unnamed`). */
    leaveUnnamed(repositoryKey: RepositoryKey) {
      if (!unnamed.includes(repositoryKey)) unnamed.push(repositoryKey);
    },
    /** A matched repository the question does not offer because the work
     *  already holds it (see `WorkScopeDecision.alreadyTaken`). */
    keepTaken(repositoryKey: RepositoryKey) {
      if (!alreadyTaken.includes(repositoryKey)) alreadyTaken.push(repositoryKey);
    },
    answered(event: WorkScopeTrailEvent) {
      recorded.push({ kind: "answer", event });
    },
    /** Plans an upsert unless it would change nothing. Precedence is the
     *  store's: a lower origin is planned and the statement keeps the higher
     *  one. */
    write(
      repositoryKey: RepositoryKey,
      fields: {
        state: WorkScopeEntryState;
        unavailableReason?: WorkScopeUnavailableReason;
        origin: WorkScopeOrigin;
        rationale: string;
      },
      clarificationId?: string,
    ) {
      if (!context.carriesRecord) return;
      const rationale = fields.rationale.slice(0, RATIONALE_MAX_LENGTH);
      const existing = facts.entries.get(repositoryKey);
      if (
        existing &&
        existing.state === fields.state &&
        existing.unavailableReason === fields.unavailableReason &&
        existing.origin === fields.origin &&
        existing.rationale === rationale
      ) {
        return;
      }
      const entry: WorkScopeEntry = {
        repositoryKey,
        state: fields.state,
        ...(fields.unavailableReason ? { unavailableReason: fields.unavailableReason } : {}),
        origin: fields.origin,
        rationale,
        decidedBy: context.actor,
        decidedAt: context.now,
      };
      recorded.push({
        kind: "upsert",
        upsert: {
          entry,
          replacesExpired:
            fields.state === "selected" && existing !== undefined && facts.isExpired(existing),
        },
        event: {
          kind: "entry_written",
          entry,
          previousState: existing?.state ?? null,
          ...(clarificationId ? { clarificationId } : {}),
        },
      });
    },
    remove(entry: WorkScopeEntry) {
      if (!context.carriesRecord) return;
      recorded.push({
        kind: "delete",
        deletion: { repositoryKey: entry.repositoryKey, origin: entry.origin },
        event: { kind: "entry_removed", entry, removedBy: context.actor },
      });
    },
    finish(): WorkScopeDecision {
      if (editRejected.length > 0) {
        // One rejected change rejects the whole edit: nothing is written.
        return {
          plan: { upserts: [], deletes: [], trail: [] },
          attach: [],
          ask: [],
          refused: [],
          editRejected,
          trailTruncated: 0,
        };
      }
      // Only refusals can outgrow the trail bound (a run start over a large
      // record). Every write keeps its trail event; refusals fill what is left
      // in order, and `refused` still lists them all.
      let refusalRoom =
        PLAN_TRAIL_MAX - recorded.filter((item) => item.kind !== "refusal").length;
      let trailTruncated = 0;
      const trail: WorkScopeTrailEvent[] = [];
      for (const item of recorded) {
        if (item.kind === "refusal") {
          if (refusalRoom <= 0) {
            trailTruncated += 1;
            continue;
          }
          refusalRoom -= 1;
        }
        trail.push(item.event);
      }
      return {
        plan: {
          upserts: recorded.flatMap((item) => (item.kind === "upsert" ? [item.upsert] : [])),
          deletes: recorded.flatMap((item) => (item.kind === "delete" ? [item.deletion] : [])),
          trail,
        },
        attach,
        ask,
        refused,
        editRejected,
        trailTruncated,
        ...(unnamed.length > 0 ? { unnamed } : {}),
        ...(alreadyTaken.length > 0 ? { alreadyTaken } : {}),
      };
    },
  };
}

function unique(keys: RepositoryKey[]): RepositoryKey[] {
  return [...new Set(keys)];
}

// Plain code unit order, so the walk never depends on the runtime's locale.
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Run start, and a resume after an answer for the keys it names. Walks by
 * origin rank, then key, so a person's entries take the room first. Rank 0 is
 * shared with `delegated`, so inside it a person's own entries go before the
 * choices they delegated: the tie decides overwrites in the store, and it must
 * not hand the last seat to whichever key sorts first.
 */
function decideRunStart(
  context: WorkScopeDecisionContext,
  facts: Facts,
  decision: DecisionRecorder,
  onlyKeys: Set<RepositoryKey> | null,
): void {
  const walk = (context.scope?.entries ?? [])
    .filter((entry) => onlyKeys === null || onlyKeys.has(entry.repositoryKey))
    .sort(
      (left, right) =>
        workScopeOriginRank(left.origin) - workScopeOriginRank(right.origin) ||
        Number(right.origin === "person") - Number(left.origin === "person") ||
        compareKeys(left.repositoryKey, right.repositoryKey),
    );
  for (const entry of walk) {
    const key = entry.repositoryKey;
    // Already in the workspace: attaching it again would count it twice.
    if (decision.isAttached(key)) continue;
    if (entry.state === "selected") {
      // An inference is true about the run that made it, never about the
      // subject: "the only repository this run could reach" was a fact on the
      // day one repository was enabled, and it becomes a lie the moment twenty
      // are. The entry stays in the record as history, visible in the panel and
      // over MCP, but it does not furnish a later run's workspace. Nothing is
      // lost: both signals that write it, the only-accessible shortcut and the
      // remembered routing answer, are recomputed on every run.
      //
      // DELIBERATELY SILENT: no refusal row. The reason dictionary has no
      // reason meaning "we do not inherit a guess", and minting one for a line
      // that would repeat in every run of every subject is noise, not debug.
      // The entry is already visible in the record with its origin, its author
      // and its date, which is all anyone needs to see where it came from. Do
      // not "improve" this into a refusal later.
      if (entry.origin === "inferred") continue;
      if (!facts.isUsable(key)) {
        decision.refuse(key, "outside_catalog");
      } else if (!facts.isReachable(key, entry.origin)) {
        decision.refuse(key, "outside_policy");
      } else if (facts.isCandidate(key) || isExemptOrigin(entry.origin)) {
        if (decision.hasRoom()) decision.attach(key);
        else decision.refuse(key, "workspace_cap");
      } else {
        // A narrow trigger is never widened by what a broader workflow once
        // recorded on the same subject.
        decision.refuse(key, "outside_policy");
      }
      continue;
    }
    // An expired entry does not wait for the model to ask again: it replays
    // the request that raised the question, inside this trigger's policy.
    if (
      facts.isExpired(entry) &&
      facts.isReachable(key) &&
      (facts.isCandidate(key) || facts.expansion === "attach") &&
      decision.hasRoom()
    ) {
      decision.attach(key);
      decision.write(key, {
        state: "selected",
        origin: "inferred",
        rationale: expiredReplacementRationale(entry),
      });
    }
  }
}

function expiredReplacementRationale(previous: WorkScopeEntry): string {
  const who =
    previous.decidedBy.kind === "person"
      ? previous.decidedBy.actorLabel
      : `run ${previous.decidedBy.runId}`;
  const [since, recordedAs] =
    previous.unavailableReason === "unusable"
      ? ["Usable in the catalog since", "unusable"]
      : ["Enabled in the catalog since", "not enabled"];
  const quoted = previous.rationale.length > 0 ? ` ("${previous.rationale}")` : "";
  return `${since} ${who} recorded it as ${recordedAs}${quoted}.`;
}

/**
 * May the answer's omission stop this derived origin from attaching the key?
 *
 * A remembered routing answer and the only-accessible shortcut are guesses, so
 * always. A workflow-owned branch and a trigger policy are not guesses, so
 * never.
 *
 * A TICKET TEXT MATCH IS BOTH, AND THE SOURCE OF THE TEXT DECIDES WHICH. The
 * description and the acceptance criteria are snapshotted per run and are the
 * very words the which-of-these question was asked about, so a later run reading
 * them again is not a new decision: it is this system putting words in the
 * person's mouth, and once an exclusion or a disabled repository drops the match
 * count under the ambiguity limit that is exactly what would happen. A person
 * writing the full path in a comment AFTER the answer is the opposite: a fresh
 * decision, taken on purpose, and the way back the recovery sentence tells them
 * to take (`unnamedRecoveryNotes` in `context.ts`). The caller is what tells the
 * two apart, and a caller that cannot passes no post-answer mention at all.
 */
function boundByTheAnswer(facts: Facts, origin: WorkScopeOrigin, key: RepositoryKey): boolean {
  if (origin === "inferred") return true;
  if (origin === "ticket_text") return !facts.isMentionedAfterAnswer(key);
  return false;
}

function decideDerived(
  context: WorkScopeDecisionContext,
  facts: Facts,
  decision: DecisionRecorder,
  event: Extract<WorkScopeDecisionEvent, { kind: "derived" }>,
): void {
  const keys = unique(event.repositoryKeys);
  for (const key of keys) {
    // Already in the workspace: the run is using it, so no policy test may
    // refuse it here. It still counts as named by this event below, so its own
    // entry of this origin is not deleted for being absent.
    if (decision.isAttached(key)) continue;
    // A guess, and the answer on this subject left this repository unnamed. The
    // origins that are not guesses are never bound: a workflow-owned branch and
    // a trigger policy (`isUnnamedInAnswer`). A ticket text match is bound by
    // the answer unless a person wrote the path after it, which is the one text
    // a match can come from that the answer did not already speak for
    // (`boundByTheAnswer`).
    if (facts.isUnnamed(key) && boundByTheAnswer(facts, event.origin, key)) {
      decision.leaveUnnamed(key);
      continue;
    }
    const entry = facts.liveEntryOf(key);
    const blocked = blockingReason(entry);
    if (blocked) {
      decision.refuse(key, blocked);
    } else if (!facts.isUsable(key)) {
      // A derived key never asks: nobody requested it.
      decision.refuse(key, "outside_catalog");
    } else if (!facts.isReachable(key, event.origin)) {
      decision.refuse(key, "outside_policy");
    } else if (isAllowed(facts, entry, key) || isExemptOrigin(event.origin)) {
      if (decision.hasRoom()) {
        decision.attach(key);
        decision.write(key, { state: "selected", origin: event.origin, rationale: event.rationale });
      } else {
        decision.refuse(key, "workspace_cap");
      }
    } else {
      decision.refuse(key, "outside_policy");
    }
  }
  // The text match and the branch are re-derived on every run, so what they
  // no longer name is dropped; a person who took the key over meanwhile keeps
  // it, because the store deletes only a row still carrying this origin.
  if (event.origin !== "ticket_text" && event.origin !== "workflow_owned_branch") return;
  // Named by the evidence counts as named here, decided or not: the deletion
  // above is for evidence that GOES AWAY, and a repository the caller could
  // still read on the ticket did not.
  const derived = new Set([...keys, ...(event.stillNamedKeys ?? [])]);
  for (const entry of context.scope?.entries ?? []) {
    if (entry.origin === event.origin && !derived.has(entry.repositoryKey)) {
      decision.remove(entry);
    }
  }
}

/**
 * The "which of these" question is asked at most once per subject: never after
 * a person selected a repository the run can reach, never after it was
 * answered. A selection the run cannot act on decides nothing, so it must not
 * silence the only question a person ever hears about this.
 *
 * KNOWN LIMIT, accepted rather than fixed: the two suppressions are scoped
 * differently. Reachability here is pin-scoped, so a narrowly pinned definition
 * can raise the question, while `selectionAnswered` is a subject-wide EXISTS
 * over the trail (`db/repositories/work-scope.ts`), so the answer latches the
 * subject for every workflow, including a broader one that would have offered
 * more repositories. The asymmetry can only cost a question that was answered
 * against a narrower list, which is a cost paid once per subject, and the
 * alternative is asking a person again on a subject they already settled.
 *
 * SECOND KNOWN LIMIT, recorded rather than fixed: an AGENT's edit through the
 * `work_scope.edit` MCP tool silences this question exactly as a person's does.
 * The suppression reads `origin === "person"`, every consumer filters on origin
 * alone, and the client label the tool writes into `decidedBy` is display text
 * that nothing decides on. So an agent that selects a repository takes away the
 * one which-of-these question a person ever hears on that subject. Fixing it
 * honestly needs a durable marker on the entry saying which surface wrote it,
 * which is a contract and a storage change; the same is already true of
 * answering a clarification through MCP. The mitigation in place is narrower
 * than "the agent never reads about the lever": this system never PLACES it in
 * the agent's instruction channel. The recovery sentence naming
 * `work_scope.edit` is kept out of the prompt additions and out of the
 * clarification questions that become the agent's durable memory
 * (`withWorkScopeOutcome` in `engine/pre-sandbox/steps/repo-selection.ts`). It
 * is still posted to the ticket, and a later run reads the ticket's comments,
 * so an agent can meet it there as ticket history; the ruling on that line
 * sits where the questions comment is posted in `engine/agent-workflow.ts`.
 */
function decideTextAmbiguous(
  context: WorkScopeDecisionContext,
  facts: Facts,
  decision: DecisionRecorder,
  matchedKeys: RepositoryKey[],
): void {
  if (!context.carriesRecord) return;
  // A DELEGATION SILENCES THE QUESTION TOO. The person was asked this, answered
  // "you decide", and the run that asked wakes up and runs this very block
  // again against the same ticket: counting only their own named entries here
  // puts the identical question back in front of them seconds after they told
  // us to stop asking. What it does NOT do is bind the repositories it left:
  // those are outside the answered set (a `delegated` answer is not counted
  // there), so the text scan, a guess, a proposal or an agent request may still
  // take them later.
  const personSelected = (context.scope?.entries ?? []).some(
    (entry) =>
      entry.state === "selected" &&
      (entry.origin === "person" || entry.origin === "delegated") &&
      facts.isReachable(entry.repositoryKey),
  );
  if (context.selectionAnswered || personSelected) {
    // SILENCED IS NOT SILENT ABOUT WHAT AN ANSWER LEFT OUT. A repository the
    // ticket names, the run does not hold, and an answer on this work left
    // unnamed is the same fact a derived guess meets (`decideDerived`): said
    // to the caller, keyed, never to the trail. Without it the finished run's
    // comment lists nothing, because the only sentence about these
    // repositories was a paragraph the agent reads (row C10). Only one the run
    // does not hold: the gate over every signal raises this event about
    // repositories already in the workspace, and "started without it" would
    // be false about those. Only one the answer still binds: a path a person
    // wrote after answering is theirs, and the caller says it was kept to the
    // earlier choice instead (C11c).
    for (const key of openKeys(facts, matchedKeys)) {
      if (decision.isAttached(key)) continue;
      if (facts.isUnnamed(key) && boundByTheAnswer(facts, "ticket_text", key)) {
        decision.leaveUnnamed(key);
      }
    }
    return;
  }
  // A repository behind the provider pin may never be offered to a person, and
  // one the record excluded or recorded as unavailable must not be offered as if
  // it were open. The selection counts the matches through the same function
  // BEFORE it raises this event (`decidableWorkScopeKeys`), so a set that
  // collapses to one to three open keys becomes an ordinary `derived`
  // `ticket_text` event rather than a repository nobody ever hears about.
  const open = openKeys(facts, matchedKeys);
  // THE GUARD ABOVE READS A PERSON'S SELECTION ONLY, AND THAT IS NOT THE WHOLE
  // OF WHAT THE WORK ALREADY HOLDS. An earlier run's reading of the ticket, a
  // trigger policy or a workflow-owned branch leaves a `selected` entry the run
  // start attaches, and a reply cannot remove it: the answer deletes a guess and
  // nothing else, by the plan's own decision. Offered as a choice, such a
  // repository would read as one the person can leave out, and leaving it out
  // would change nothing. So it is not offered; the caller names it in the
  // question as already taken. Only what the RECORD holds and this run attached
  // counts: a repository this run's own signals picked moments ago has no
  // entry yet, and asking about exactly those is what the count gate is for.
  const taken = open.filter((key) => {
    if (!decision.isAttached(key)) return false;
    const entry = facts.liveEntryOf(key);
    return entry !== undefined && isHeldSelection(entry);
  });
  const choices = open.filter((key) => !taken.includes(key));
  if (choices.length === 0) return;
  // One choice left is no ambiguity, unless the rest are already taken: then
  // the text still names more than the run may decide between, and the one
  // repository left is a real question.
  if (choices.length < 2 && taken.length === 0) return;
  for (const key of choices) decision.ask(key, "selection");
  for (const key of taken) decision.keepTaken(key);
}

/** First match wins, in this order, for each of the first three keys. */
function decideRequested(
  context: WorkScopeDecisionContext,
  facts: Facts,
  decision: DecisionRecorder,
  repositoryKeys: RepositoryKey[],
): void {
  const keys = unique(repositoryKeys);
  for (const key of keys.slice(0, REQUEST_REPOSITORIES_MAX)) {
    decideRequestedKey(context, facts, decision, key);
  }
  for (const key of keys.slice(REQUEST_REPOSITORIES_MAX)) {
    decision.refuse(key, "request_limit");
  }
}

function decideRequestedKey(
  context: WorkScopeDecisionContext,
  facts: Facts,
  decision: DecisionRecorder,
  key: RepositoryKey,
): void {
  if (decision.isAttached(key)) return;
  if (!facts.isInPin(key)) {
    decision.refuse(key, "outside_policy");
    return;
  }
  // The agent's request is a guess like any other, and asking instead would put
  // a question already answered to the same person. Refused with a reason of its
  // own, so the model and the person can tell it from an exclusion, and the run
  // carries on without it.
  if (facts.isUnnamed(key)) {
    decision.refuse(key, "unnamed_in_answer");
    return;
  }
  const entry = facts.liveEntryOf(key);
  const blocked = blockingReason(entry);
  if (blocked) {
    decision.refuse(key, blocked);
    return;
  }
  // An answer can only change a key nothing has decided, or one another
  // workflow merely inferred.
  const askableEntry = entry === undefined || (entry.state === "selected" && !isExemptSelection(entry));
  const askOnce = facts.expansion === "ask_once" && context.carriesRecord && askableEntry;
  if (!facts.isUsable(key)) {
    if (isAllowedIfUsable(facts, entry, key)) {
      // The catalog alone keeps it out, so the question asked is the one whose
      // answer expires when the catalog changes.
      if (entry === undefined && context.carriesRecord && facts.expansion !== "never") {
        decision.ask(key, facts.isEnabled(key) ? "unusable" : "not_enabled");
      } else {
        decision.refuse(key, "outside_catalog");
      }
    } else if (askOnce && decision.hasRoom()) {
      // This key stays outside the policy whether the catalog holds it or not,
      // so declining it is a decision that may last.
      decision.ask(key, "outside_policy");
    } else {
      decision.refuse(key, "outside_policy");
    }
    return;
  }
  if (!isAllowed(facts, entry, key)) {
    // Asked about once; an answer naming it records a person's selection.
    if (askOnce && decision.hasRoom()) decision.ask(key, "outside_policy");
    else decision.refuse(key, askOnce ? "workspace_cap" : "outside_policy");
    return;
  }
  if (!decision.hasRoom()) {
    decision.refuse(key, "workspace_cap");
    return;
  }
  decision.attach(key);
  decision.write(key, { state: "selected", origin: "inferred", rationale: REQUESTED_RATIONALE });
}

/**
 * Decided once, where the answer arrives, and never against the trigger
 * policy: a person outranks it. What leaving a key out means depends on why it
 * was asked. Asked keys are decided before named ones.
 */
function decideAnswered(
  context: WorkScopeDecisionContext,
  decision: DecisionRecorder,
  event: Extract<WorkScopeDecisionEvent, { kind: "answered" }>,
): void {
  const { clarificationId, answer } = event;
  decision.answered({ kind: "question_answered", clarificationId, answer, answeredBy: context.actor });
  // Both kinds record that an answer arrived and write nothing else. This is a
  // guard rather than an exhaustive switch, so a kind that falls past it reaches
  // the loop below naming no repository, and every repository the question asked
  // about is then written as this person's own decision to leave it out. For
  // "unattributed", whose whole meaning is that the answer is NOT this person's
  // decision, that is the exact inversion of what it says, and no typecheck
  // catches it. Add a kind here, or return it above.
  if (answer.kind === "unrecognised" || answer.kind === "unattributed") return;
  // THE WORKFLOW'S OWN CHOICE, and nothing more. The caller took these keys
  // through `repositoriesADelegationTakes`, and this writes exactly them, as
  // the workflow's decision at this person's request. It writes nothing for a
  // repository it did not take: no exclusion, no unavailable entry, no guess
  // removed. The person judged none of them; the workflow judged the ones it
  // took, so everything else stays open for a later run, which is what makes
  // this different from somebody naming three of five. It also returns before
  // the loop below, which would otherwise read every untaken repository as
  // this person's own silence.
  if (answer.kind === "delegated") {
    for (const key of unique(answer.repositoryKeys)) {
      // The rule above already leaves these out; checked again here because
      // the keys arrive from the caller, and a write the store will refuse
      // must not sit in the plan as if it were taken.
      if (isDecidedByAPerson(context.scope?.entries ?? [], key)) continue;
      decision.write(
        key,
        { state: "selected", origin: "delegated", rationale: delegatedRationale(context.actor) },
        clarificationId,
      );
    }
    return;
  }
  const named = answer.kind === "repositories" ? answer.repositoryKeys : [];
  const askedKeys = new Set<RepositoryKey>();
  for (const asked of event.asked) {
    if (askedKeys.has(asked.repositoryKey)) continue;
    askedKeys.add(asked.repositoryKey);
    if (named.includes(asked.repositoryKey)) {
      decision.write(
        asked.repositoryKey,
        { state: "selected", origin: "person", rationale: NAMED_RATIONALE },
        clarificationId,
      );
      continue;
    }
    // ABSENT MEANS NO, ENFORCED AT THE WRITE.
    //
    // A person has decided about a repository only if they were shown its name
    // or named it themselves. Naming it is the branch above, so everything past
    // this line is silence, and silence in answer to a question that never put
    // this key in front of anybody says nothing about it. The rule was written
    // down in `workScopeAskedRepositorySchema` and enforced only where a later
    // run READS the suppression, in SQL: every producer of an ask happens to
    // spell the key in full today, so the rule held by coincidence. A fourth
    // producer, or somebody editing a key out of one of those sentences,
    // fabricates a person's decision here in silence, and the fabrication is
    // durable and attributed to them by name. So the writer refuses it too, and
    // the cost of the refusal in the honest case is one question asked again.
    if (asked.named !== true) continue;
    switch (asked.askedBecause) {
      // The person could not give it: not a refusal, and it may expire.
      case "not_enabled":
      case "unusable":
        decision.write(
          asked.repositoryKey,
          {
            state: "unavailable",
            unavailableReason: asked.askedBecause,
            origin: "person",
            rationale: LEFT_OUT_RATIONALE[asked.askedBecause],
          },
          clarificationId,
        );
        break;
      // The person could have given it and declined.
      case "outside_policy":
        decision.write(
          asked.repositoryKey,
          { state: "excluded", origin: "person", rationale: LEFT_OUT_RATIONALE.outside_policy },
          clarificationId,
        );
        break;
      // Nothing is WRITTEN: a selected entry or an exclusion would record a
      // stronger decision than leaving a name out of an answer (rule 5), and
      // the omission already binds through the answered set
      // (`isUnnamedInAnswer`).
      //
      // One thing is REMOVED. A guess recorded before the person was asked, a
      // `selected` `inferred` entry, would otherwise go on saying "selected"
      // about a repository they have just not chosen, and its mere presence
      // would read to `isUnnamedInAnswer` as an entry that governs, so the next
      // guess would take it again. Only that origin: a person's own entry, a
      // typed path, a trigger policy and a workflow-owned branch are not
      // guesses, and an answer that left a name out does not overrule them.
      case "selection": {
        const guessed = (context.scope?.entries ?? []).find(
          (entry) =>
            entry.repositoryKey === asked.repositoryKey &&
            entry.state === "selected" &&
            entry.origin === "inferred",
        );
        if (guessed) decision.remove(guessed);
        break;
      }
    }
  }
  for (const key of unique(named)) {
    if (askedKeys.has(key)) continue;
    decision.write(key, { state: "selected", origin: "person", rationale: NAMED_RATIONALE }, clarificationId);
  }
}

/** A person's edit: any enabled catalog repository regardless of the policy,
 *  decided as one change set. */
function decideEdited(
  facts: Facts,
  decision: DecisionRecorder,
  requested: WorkScopeEditRequest["changes"],
): void {
  // One change per repository, the last one the edit names. A remove and a
  // select of one key in one plan would reach the store as a delete and an
  // upsert of the same row in the same statement, where the row's fate is
  // undefined.
  const folded = new Map<RepositoryKey, WorkScopeEditRequest["changes"][number]>();
  for (const change of requested) folded.set(change.repositoryKey, change);
  const changes = [...folded.values()];
  for (const change of changes) {
    if (change.action === "select" && !facts.isEnabled(change.repositoryKey)) {
      decision.rejectEdit(change.repositoryKey);
    }
  }
  for (const change of changes) {
    const rationale = change.rationale ?? "";
    switch (change.action) {
      case "select":
        decision.write(change.repositoryKey, { state: "selected", origin: "person", rationale });
        break;
      case "exclude":
        decision.write(change.repositoryKey, { state: "excluded", origin: "person", rationale });
        break;
      case "remove": {
        // Remove lets the next run decide again; exclude is the sticky one.
        const entry = facts.entries.get(change.repositoryKey);
        if (entry) decision.remove(entry);
        break;
      }
    }
  }
}
