/**
 * The run's half of the work scope decision: it turns what a run holds into the
 * context the pure decision module reads, and it keeps one event's attachments
 * visible to the next event of the same run.
 *
 * It exists because a run decides the same thing several times from different
 * evidence. The ticket path raises a run start, a workflow-owned branch, a
 * ticket text match and a remembered routing answer; the pull request path
 * raises a run start and two derived events. Every one of them has to see what
 * the ones before it already attached, or the workspace cap would be counted
 * from an empty workspace each time and one repository would be attached twice.
 * The alternative, threading `attachedKeys` by hand through each call site, is
 * the same bookkeeping written four times.
 *
 * Nothing here reads a database, a clock or the network. The caller passes the
 * catalog snapshot, the pin, the policy, the actor and the instant; what comes
 * back is a list of write plans for the caller's own step to apply, the
 * repositories a question named, and sentences a person can read.
 */
import {
  repositoryCatalogKey,
  workScopeWritePlanSchema,
  type RepositoryKey,
  type TriggerRepositoryPolicy,
  type VcsProviderKind,
  type WorkScope,
  type WorkScopeActor,
  type WorkScopeAskedRepository,
  type WorkScopeRefusalReason,
  type WorkScopeWritePlan,
  type WorkflowRepositoryScope,
} from "@shared/contracts";
import {
  decidableWorkScopeKeys,
  decideWorkScope,
  isUnnamedInAnswer,
  type WorkScopeDecision,
  type WorkScopeDecisionContext,
  type WorkScopeDecisionEvent,
} from "./decide.js";
// Both refusal surfaces render from here, so the run start and the mid run
// expansion cannot end up holding different facts about the same repository.
import {
  workScopeCommentSaidNoSentence,
  workScopeRefusalSentence,
  workScopeTicketSaidNoSentence,
  workScopeTooManyOpenSentence,
  workScopeUnnamedSaidNoSentence,
  workScopeUnnamedSentence,
} from "./refusal-sentence.js";

/** What one event may carry. `decideWorkScope` throws above it, so a caller
 *  holding a longer list bounds it rather than killing the run. */
const EVENT_KEYS_MAX = 8;

/**
 * The normalised catalog key the record stores, from the way the engine spells
 * a repository. The engine says `repoPath` and the catalog says `path`; this is
 * the only place in the work scope code that adapts between them, so there is
 * one definition of the key.
 */
export function workScopeRepositoryKey(repository: {
  provider: string;
  repoPath: string;
}): RepositoryKey {
  return repositoryCatalogKey({ provider: repository.provider, path: repository.repoPath });
}

/**
 * The providers a definition pin bounds the run to, or null when it names none.
 *
 * Null rather than an empty list, because the decision module reads null as "no
 * bound" and an empty list would read as "no provider is allowed", which is a
 * pin that stops every run.
 */
export function pinnedProvidersOf(
  scope: WorkflowRepositoryScope | undefined,
): VcsProviderKind[] | null {
  const providers = scope?.providers ?? [];
  return providers.length > 0 ? [...providers] : null;
}

/** The repositories a definition pin bounds the run to, or null when it names
 *  none. Null for the same reason as the providers above. */
export function pinnedKeysOf(
  scope: WorkflowRepositoryScope | undefined,
): RepositoryKey[] | null {
  const repositories = scope?.repositories ?? [];
  return repositories.length > 0 ? repositories.map(workScopeRepositoryKey) : null;
}

/** Everything one run's decisions read, gathered once. */
export interface RunWorkScopeInput {
  subjectKey: string;
  /** The record as this run read it, or null when the subject has none yet. */
  scope: WorkScope | null;
  selectionAnswered: boolean;
  /** The repositories a question on this subject named and somebody answered,
   *  read at the same moment as `scope`: the two together are what a guess may
   *  not take back (`isUnnamedInAnswer` in `decide.ts`), so a copy of one that
   *  is older than the other reads a stale answer as no answer at all. */
  answeredRepositoryKeys: readonly RepositoryKey[];
  /** What this run could read of the ticket, as ONE fact, or null from a caller
   *  that never scanned a ticket. Both halves of the comment door read it: the
   *  binding (`boundByTheAnswer` in `decide.ts` reads
   *  `mentionedAfterAnswerKeys`) and the sentence offering the door
   *  (`commentPathIsTaken`). Two separate inputs could disagree, and the person
   *  would be sent through a door the run then ignores. */
  ticketText: TicketTextReading | null;
  /** `unusableKeys` null means this path never listed the repositories, so
   *  enabled counts as usable there. */
  catalog: WorkScopeDecisionContext["catalog"];
  /** The definition pin. A capability bound, not a policy: nothing is exempt
   *  from it, a person's selection included. */
  repositoryScope?: WorkflowRepositoryScope;
  policy: TriggerRepositoryPolicy;
  /** The candidates of `event_repository_and_related`, empty for every other
   *  candidate set. */
  eventRelatedKeys?: RepositoryKey[];
  actor: WorkScopeActor;
  /** ISO 8601, read by the caller's step so the decision itself has no clock. */
  now: string;
  /** What the workspace already holds when the first event is decided. */
  attachedKeys?: RepositoryKey[];
}

export interface RunWorkScopeRecorder {
  readonly subjectKey: string;
  /** The run every decision of this recorder is attributed to, or null when the
   *  actor is a person rather than a run. */
  readonly runId: string | null;
  /** Decide one event against everything decided before it. */
  decide(event: WorkScopeDecisionEvent): WorkScopeDecision;
  /**
   * The keys of `keys` a person could still be asked about, or a signal could
   * still derive: reachable, and carrying no blocking entry. It is
   * `decidableWorkScopeKeys`, the function a `text_ambiguous` event offers its
   * choices through, exposed because the caller has to apply it BEFORE it counts
   * matches: a set of five matches that collapses to two decidable keys is an
   * ordinary derived event, not an ambiguity.
   */
  decidableKeys(keys: readonly RepositoryKey[]): RepositoryKey[];
  /**
   * The keys of `keys` a question on this subject named and the answer did not
   * take (`isUnnamedInAnswer`), in input order.
   *
   * Apart from `decidableKeys` because the two answer different questions and
   * only one of them binds here. A repository left out of an answer stays
   * DECIDABLE: a full path written in a comment afterwards takes it, and the
   * ticket-text reader depends on that door. What it stops being is something
   * to OFFER, so the only caller is the catalog discovery shows the model
   * (`offerableRepositoryCatalog`): offering it spends a round on a decision
   * somebody already made, and on a question they already answered.
   */
  answerLeftUnnamedKeys(keys: readonly RepositoryKey[]): RepositoryKey[];
  /** At most what one event may carry, in input order. */
  boundEventKeys(keys: readonly RepositoryKey[]): RepositoryKey[];
  /**
   * Would a full path written in a ticket comment about these repositories
   * reach the next run and be taken, as this run's ticket and record stand?
   *
   * Exposed because the surfaces that speak AFTER this step (repository
   * discovery, the expansion loop, the comment a finished run posts) have to
   * offer the same way back this recorder does, and one predicate answering for
   * all of them is what keeps them from telling a person two different things.
   */
  commentPathIsTaken(repositoryKeys: readonly RepositoryKey[]): boolean;
  /** What this recorder was told of the ticket, so a later step can carry the
   *  same reading rather than make a second one. */
  readonly ticketText: TicketTextReading | null;
  /** The write plans the caller's step applies, in the order they were decided. */
  readonly plans: WorkScopeWritePlan[];
  /** Every repository a question named, with the reason it was asked. */
  readonly ask: WorkScopeAskedRepository[];
  /** Matched repositories a question left out of its choices because this work
   *  already holds them (`WorkScopeDecision.alreadyTaken`), for the question to
   *  name as taken. */
  readonly alreadyTaken: RepositoryKey[];
  /** One sentence per refusal, for the text a person reads. */
  readonly notes: string[];
  /**
   * The same refusals, each still carrying the repository it is about.
   *
   * `notes` is the flat text channel: a halt message, a prompt addition, one
   * paragraph. This is the keyed one, for the surface that renders a line per
   * repository (the analysis comment a finished run posts), where a sentence
   * with no key attached cannot be lined up with the repositories the run did
   * open. Only decided refusals appear here; a caller's own `note()` and the
   * trail-bound line name no repository and stay in `notes` alone.
   */
  readonly leftOut: Array<{ repositoryKey: RepositoryKey; reason: string }>;
  /**
   * Sentences addressed to a PERSON and to nobody else: at most the one saying
   * an exclusion can be taken back.
   *
   * Apart from `notes` because the two have different readers. A refusal
   * sentence is a fact about this run's workspace, so a caller may hand it to
   * the model as well; this one tells a human they can change their mind, which
   * an agent has no use for and which would leave the two holding different
   * facts about what the run may touch. Put it where a person reads, the run's
   * status reason and the ticket comment, and nowhere else.
   */
  readonly recoveryNotes: string[];
  /** Say something the decision itself could not: a caller that found evidence
   *  it could not act on owes a person the reason, and an empty scope with no
   *  sentence behind it is the failure this record exists to end. */
  note(sentence: string): void;
  /**
   * Say that this run did not take a repository a person asked for in a way no
   * event carries: a path written after an answer, for a repository the text
   * scan never saw because the run cannot open it, or a path written in a
   * comment the run did not read at all. The refusal's own sentence,
   * on the refusal's two channels (flat and keyed), and nothing on the trail,
   * because nothing about the work was decided.
   *
   * Once per repository, and on BOTH channels, which is stricter than a
   * decided refusal. A decision may refuse one repository for two different
   * reasons, and both sentences are facts worth the paragraph; this is only
   * ever a second sentence about a repository something this run already said
   * it left out, and the flat paragraph would then say the same repository
   * twice for one reason the person did not act on.
   *
   * WHY IT CANNOT OPEN IT DECIDES WHAT ELSE A PERSON IS TOLD, in the recovery
   * notes and nowhere the agent reads, because each of these is a way to bring
   * a repository back (rule 7). Not enabled on an activated catalog: somebody
   * can enable it. Enabled but unusable: nobody can, until the catalog can
   * serve it. Outside the workflow's pin: not until the pin changes. Not listed
   * on a catalog that was never activated: nothing counts as disabled there,
   * so there is nothing to tell them to do, and nothing is said beyond the
   * sentence itself. Named in a comment that also says no: the run can open it,
   * and what stands between them is the comment, so the way back is a comment
   * that names only what to work on.
   */
  leaveOut(repositoryKey: RepositoryKey, reason: UnopenableReason): void;
  /** What the workspace holds after every event decided so far. */
  readonly attachedKeys: RepositoryKey[];
}

export function createRunWorkScopeRecorder(input: RunWorkScopeInput): RunWorkScopeRecorder {
  const attached: RepositoryKey[] = [...(input.attachedKeys ?? [])];
  const plans: WorkScopeWritePlan[] = [];
  const ask: WorkScopeAskedRepository[] = [];
  const alreadyTaken: RepositoryKey[] = [];
  const notes: string[] = [];
  const leftOut: Array<{ repositoryKey: RepositoryKey; reason: string }> = [];
  const recoveryNotes: string[] = [];
  // Kept apart from the notes above, which are said once for the whole run
  // and guarded on being empty: a repository this run could not open has a
  // remedy of its own, and saying it first must not silence the way back.
  const unopenableNotes: string[] = [];
  const pinnedProviders = pinnedProvidersOf(input.repositoryScope);
  const pinnedKeys = pinnedKeysOf(input.repositoryScope);
  const entries = new Map(
    (input.scope?.entries ?? []).map((entry) => [entry.repositoryKey, entry] as const),
  );
  // What every decision of this recorder is taken against, the workspace as it
  // stands included. Built in one place so the count `decidableKeys` makes and
  // the event `decide` then raises cannot read two different contexts.
  const decisionContext = (): WorkScopeDecisionContext => ({
    scope: input.scope,
    // A run that reads a record is a run whose subject carries one: the run
    // start step freezes the scope only for a subject that does.
    carriesRecord: true,
    catalog: input.catalog,
    pinnedProviders,
    pinnedKeys,
    policy: input.policy,
    eventRelatedKeys: input.eventRelatedKeys ?? [],
    attachedKeys: [...attached],
    selectionAnswered: input.selectionAnswered,
    answeredRepositoryKeys: input.answeredRepositoryKeys,
    postAnswerMentionedKeys: input.ticketText?.mentionedAfterAnswerKeys ?? [],
    actor: input.actor,
    now: input.now,
  });
  /** Would a full path written in a comment about these repositories be read
   *  and taken by the next run? All three conditions of `TicketTextReading`,
   *  with the open matches counted against the record as it stands when the
   *  question is asked, so a repository decided in between changes the answer.
   *
   *  COUNTED WITH THE REPOSITORIES IT OFFERS. A path the person writes joins the
   *  ticket's text, so the next run counts what the ticket names now AND the
   *  repositories this sentence tells them to write: three open matches and one
   *  more written is four, which that run asks about instead of taking. */
  const commentPathIsTaken = (repositoryKeys: readonly RepositoryKey[]): boolean => {
    const reading = input.ticketText;
    if (reading === null) return false;
    if (!repositoryKeys.every((key) => reading.datableKeys.includes(key))) return false;
    return aCommentPathIsTaken(
      decidableWorkScopeKeys(decisionContext(), [...reading.matchedKeys, ...repositoryKeys]),
    );
  };

  return {
    subjectKey: input.subjectKey,
    runId: input.actor.kind === "run" ? input.actor.runId : null,
    note(sentence) {
      notes.push(sentence);
    },
    leaveOut(repositoryKey, reason) {
      if (leftOut.some((left) => left.repositoryKey === repositoryKey)) return;
      const sentence =
        reason === "too_many_open"
          ? workScopeTooManyOpenSentence(repositoryKey)
          : reason === "ticket_says_no"
          ? workScopeTicketSaidNoSentence(repositoryKey)
          : reason === "comment_says_no"
          ? // The richer sentence where it is true. A repository an answer on
            // this work already spoke for is left where the answer put it, and
            // the comment is why nothing moved it; a repository nobody was ever
            // asked about has no answer to name, and the comment is the whole
            // story.
            (input.ticketText?.saidNoAfterAnswerKeys ?? []).includes(repositoryKey)
            ? workScopeUnnamedSaidNoSentence(repositoryKey)
            : workScopeCommentSaidNoSentence(repositoryKey)
          : workScopeRefusalSentence(
              // The frozen entry rides along already, so the exclusion names its
              // author and its date exactly as the decided refusal does. That is
              // the point of routing it through here: a person reading
              // "somebody excluded this on the 3rd" knows whose decision to
              // revisit, and "it was left out" does not.
              { repositoryKey, reason: REFUSAL_OF[reason] },
              "run_start",
              entries.get(repositoryKey),
            );
      notes.push(sentence);
      leftOut.push({ repositoryKey, reason: sentence });
      // AN EXCLUSION'S WAY BACK IS COMPOSED, NOT FIXED, because what a person
      // can do about it depends on what the deployment still holds: the promise
      // that the list can be changed is withheld for a repository the catalog no
      // longer enables, and the caveats about a repository it cannot serve or a
      // pin that excludes it are added where they are true
      // (`exclusionRecoveryNotes`). It is the same composition the decided
      // refusal uses, off the same bounds, so the two cannot drift.
      const remedies =
        reason === "excluded"
          ? exclusionRecoveryNotes([repositoryKey], {
              enabledKeys: input.catalog.enabledKeys,
              unusableKeys: input.catalog.unusableKeys,
              pinnedProviders,
              pinnedKeys,
            })
          : [unopenableRemedy(repositoryKey, reason)].filter(
              (remedy): remedy is string => remedy !== null,
            );
      // Deduped on the sentence, because the exclusion's own note is generic:
      // two excluded repositories owe a person one "it is not final", not two.
      for (const remedy of remedies) {
        if (!unopenableNotes.includes(remedy)) unopenableNotes.push(remedy);
      }
    },
    get plans() {
      return plans;
    },
    get alreadyTaken() {
      return alreadyTaken;
    },
    get ask() {
      return ask;
    },
    get notes() {
      return notes;
    },
    get leftOut() {
      return leftOut;
    },
    get recoveryNotes() {
      return unopenableNotes.length === 0 ? recoveryNotes : [...recoveryNotes, ...unopenableNotes];
    },
    get attachedKeys() {
      return [...attached];
    },
    boundEventKeys(keys) {
      return [...new Set(keys)].slice(0, EVENT_KEYS_MAX);
    },
    decidableKeys(keys) {
      return decidableWorkScopeKeys(decisionContext(), keys);
    },
    answerLeftUnnamedKeys(keys) {
      return [...new Set(keys)].filter((key) =>
        isUnnamedInAnswer(key, input.answeredRepositoryKeys, input.scope?.entries ?? []),
      );
    },
    commentPathIsTaken(repositoryKeys) {
      return commentPathIsTaken(repositoryKeys);
    },
    get ticketText() {
      return input.ticketText;
    },
    decide(event) {
      const decision = decideWorkScope(decisionContext(), event);
      // Parsed, not trusted. The plan is about to be spelled into one SQL
      // statement as jsonb, where a shape the contract refuses would land as a
      // row nothing can read back rather than as an error anyone sees.
      const parsed = workScopeWritePlanSchema.safeParse(decision.plan);
      if (!parsed.success) {
        throw new Error(
          `work scope plan for a ${event.kind} event does not match the contract: ${parsed.error.message}`,
        );
      }
      if (
        parsed.data.upserts.length > 0 ||
        parsed.data.deletes.length > 0 ||
        parsed.data.trail.length > 0
      ) {
        plans.push(parsed.data);
      }
      for (const key of decision.attach) {
        if (!attached.includes(key)) attached.push(key);
      }
      ask.push(...decision.ask);
      for (const key of decision.alreadyTaken ?? []) {
        if (!alreadyTaken.includes(key)) alreadyTaken.push(key);
      }
      for (const refusal of decision.refused) {
        // The frozen entry, where the record holds one: it is what lets the run
        // start sentence name who excluded a repository and when, which until
        // now only the expansion sentence could say about the same repository.
        const sentence = workScopeRefusalSentence(
          refusal,
          "run_start",
          entries.get(refusal.repositoryKey),
        );
        notes.push(sentence);
        // The same sentence twice on purpose, once flat and once keyed. The two
        // go to surfaces that render differently (one paragraph, one line per
        // repository), and composing the sentence twice is how they would drift.
        if (!leftOut.some((left) => left.repositoryKey === refusal.repositoryKey)) {
          leftOut.push({ repositoryKey: refusal.repositoryKey, reason: sentence });
        }
      }
      // A guess the answer left unnamed is left out as audibly as a refusal:
      // the same two channels, one flat and one keyed, and no trail line
      // (`WorkScopeDecision.unnamed`).
      const unnamed = decision.unnamed ?? [];
      for (const repositoryKey of unnamed) {
        // A person wrote about it after the answer, and what they wrote says
        // no: the ordinary sentence would read as if nobody had written a word.
        const sentence = (input.ticketText?.saidNoAfterAnswerKeys ?? []).includes(repositoryKey)
          ? workScopeUnnamedSaidNoSentence(repositoryKey)
          : workScopeUnnamedSentence(repositoryKey, "run_start");
        notes.push(sentence);
        if (!leftOut.some((left) => left.repositoryKey === repositoryKey)) {
          leftOut.push({ repositoryKey, reason: sentence });
        }
      }
      // What a person decided themselves, an exclusion or an omission from an
      // answer, is what a person can take back, and until this sentence existed
      // nothing said so: the run died and the only way anybody found was a new
      // ticket. Said once however many repositories were left out, because
      // repeating it under each of them drowns the sentences naming them.
      if (recoveryNotes.length === 0) {
        const unnamedHere = [
          ...unnamed,
          ...decision.refused
            .filter((refusal) => refusal.reason === "unnamed_in_answer")
            .map((refusal) => refusal.repositoryKey),
        ];
        recoveryNotes.push(
          ...unnamedRecoveryNotes(
            unnamedHere,
            // Decided here rather than handed in, so the sentence and the rule
            // that binds the repository read one fact: the reading of the ticket
            // this recorder holds, as it stands at the moment it says it.
            commentPathIsTaken(unnamedHere),
          ),
          ...exclusionRecoveryNotes(
            decision.refused
              .filter((refusal) => refusal.reason === "excluded")
              .map((refusal) => refusal.repositoryKey),
            {
              enabledKeys: input.catalog.enabledKeys,
              unusableKeys: input.catalog.unusableKeys,
              // The pin this run is bound by, not a second reading of it: these
              // are the same two values every decision above was taken against.
              pinnedProviders,
              pinnedKeys,
            },
          ),
          // AND WHEN THE QUESTION IS STILL BEING ASKED. A which-of-these answer
          // binds every later guess on this work, so the person deciding it is
          // owed the way back BEFORE they answer, not on the run that refuses
          // something afterwards. The question itself says what an omission
          // costs and names no lever, because a question is copied into the
          // agent's prompts and the memory file; this sentence rides the ticket
          // comment beside it and nowhere else (rule 7).
          ...(unnamed.length === 0 &&
          decision.refused.length === 0 &&
          decision.ask.some((asked) => asked.askedBecause === "selection")
            ? [ASKING_RECOVERY_NOTE]
            : []),
        );
      }
      // Said out loud rather than dropped: the trail bound is the only place a
      // refusal can go missing, and a person reading why a repository is absent
      // must not be told a shorter list than the run actually refused.
      if (decision.trailTruncated > 0) {
        notes.push(`and ${decision.trailTruncated} more`);
      }
      return decision;
    },
  };
}

/**
 * Take the pending repository ask off the run context, if there is one.
 *
 * TAKE, not read. The ask belongs to the one question that raised it: a later
 * block in the same run asking about something else must not inherit
 * repositories from a question already put, or a person answering "yes" to a
 * design question would silently settle a repository selection nobody showed
 * them. The clearing is the whole point, which is why it lives here with a test
 * rather than as two lines inside a workflow closure no test can reach.
 */
export function consumeWorkScopeAsk<Ask>(carrier: { workScopeAsk?: Ask }): Ask | undefined {
  const ask = carrier.workScopeAsk;
  carrier.workScopeAsk = undefined;
  return ask;
}

/** The way back from a person's exclusion, in the same place the exclusion is
 *  reported: a person who reads why the run started without a repository reads
 *  here that the choice is theirs to change, and what to do to change it.
 *
 *  It names the two edit surfaces THIS delivery ships, the work scope API
 *  (`PATCH /api/v1/work-scope`) and the `work_scope.edit` tool, and not a
 *  screen. Both halves of that matter. A way back a reader cannot take today is
 *  not a way back, so the sentence has to name a lever that exists now; and the
 *  dashboard panel is not in this delivery, so naming one would send the reader
 *  to a page that is not there. The panel is what replaces these two names with
 *  a link on the day it ships. */
/** What a person is told beside the which-of-these question, before they answer
 *  it: that the list they send is the whole of it, and where the repositories
 *  they leave out can be put back. The same two levers the other notes name,
 *  because they are the two this delivery ships. */
const ASKING_RECOVERY_NOTE =
  "A repository you leave out of this answer is not final: this work's repository list can be changed through the work scope API or the work_scope.edit tool, and the next run starts from the changed list.";

const EXCLUSION_RECOVERY_NOTE =
  "Excluding a repository is not final: this work's repository list can be changed through the work scope API or the work_scope.edit tool, and the next run starts from the changed list.";

/**
 * What a run read of the ticket, everything the comment door depends on.
 *
 * The door is a person writing a repository's full path in a comment after
 * answering, and the next run taking it. That works only when three things all
 * hold, and each is a field here: the run scanned the ticket at all (this value
 * is not null), it can tell a person's comment from our own and place it after
 * the answer that named the repository (`datableKeys`), and the ticket does not
 * already name more open repositories than a run may decide between
 * (`matchedKeys`, counted by `commentPathIsTaken`).
 */
export interface TicketTextReading {
  /** Every repository whose full path the ticket's text names, as scanned. */
  matchedKeys: readonly RepositoryKey[];
  /** The answered repositories a comment about could be dated: the bot's own
   *  account is known, so our questions are not read as a person's words, and
   *  the newest answer that named the repository has an instant. Empty when
   *  either is missing, which offers the record alone. */
  datableKeys: readonly RepositoryKey[];
  /** The repositories whose full path a PERSON wrote after the newest answer
   *  that named them, where the newest such comment does not say no. The one
   *  text that may still attach a key an answer left unnamed; always a subset
   *  of `datableKeys`. */
  mentionedAfterAnswerKeys: readonly RepositoryKey[];
  /** The repositories whose newest comment after that answer names them AND
   *  says no, so it was not read as naming them. Kept apart so the line a run
   *  writes about such a repository can say why a comment the person wrote went
   *  unread. Absent means none; always disjoint from `mentionedAfterAnswerKeys`. */
  saidNoAfterAnswerKeys?: readonly RepositoryKey[];
}

/** Why a run did not take a repository a person named in the ticket: it cannot
 *  open it, or it did not read the comment the path was written in. */
type UnopenableReason =
  | "not_enabled"
  | "not_listed"
  | "unusable"
  | "outside_pin"
  | "excluded"
  | "comment_says_no"
  | "ticket_says_no"
  | "too_many_open";

/**
 * Which refusal each unopenable reason IS, for the reasons that render one.
 *
 * A MAP, BECAUSE THE CHAIN OF TERNARIES IT REPLACES GUESSED. It tested two
 * reasons by name and sent everything else down the `outside_catalog` arm, so
 * `unusable` arrived silently as "is not on the repository catalog this run may
 * use": false about a repository that is enabled and sitting on the Repositories
 * page, contradicted by the very next sentence in the same comment, and durable,
 * because the refusal half reaches the agent's prompt and the memory file. A
 * test can spell out a false sentence and stay green, so the compiler is where
 * this belongs: a new reason with no entry here does not build.
 *
 * The three reasons missing from this map are the ones with a sentence of their
 * own above (`too_many_open`, `ticket_says_no`, `comment_says_no`), and leaving
 * them out is what makes their absence a type error rather than a fallthrough.
 */
const REFUSAL_OF: Record<
  Exclude<UnopenableReason, "too_many_open" | "ticket_says_no" | "comment_says_no">,
  WorkScopeRefusalReason
> = {
  not_enabled: "outside_catalog",
  not_listed: "outside_catalog",
  unusable: "unusable",
  outside_pin: "outside_policy",
  excluded: "excluded",
};

/** What a person can do about a repository this run could not open, or null
 *  where nothing they do changes it (`leaveOut`). */
function unopenableRemedy(repositoryKey: RepositoryKey, reason: UnopenableReason): string | null {
  switch (reason) {
    case "not_enabled":
      return `${repositoryKey} is not enabled on the Repositories page. Somebody with access to that page can enable it, and until then no run can use it.`;
    case "unusable":
      return `The catalog cannot serve ${repositoryKey} at the moment, so no run can use it until it can.`;
    case "outside_pin":
      return `The workflow that runs this work is limited to a fixed set of repositories, which does not include ${repositoryKey}, so no run of it can use that repository until that limit changes.`;
    // The way back is a second comment, so this one says what such a comment
    // has to look like. Both levers, because the comment is the slower of the
    // two and a person who would rather change the list outright should not
    // have to guess that they may.
    case "comment_says_no":
      return `A ticket comment brings a repository into this work only when it says no about none of them. To bring ${repositoryKey} in, write a comment naming only the repositories to work on, or change this work's repository list through the work scope API or the work_scope.edit tool.`;
    // The ticket's own words are read a phrase at a time, so the way back is a
    // phrase of their own: editing the one that keeps us out is the slowest of
    // the three, and it is left out rather than offered, because a description
    // is written for people and rewriting it to steer a run is the tail wagging
    // the dog.
    case "ticket_says_no":
      return `A phrase that asks for a repository to be left alone does not bring it into this work. To use ${repositoryKey}, write a comment naming only the repositories to work on, or change this work's repository list through the work scope API or the work_scope.edit tool.`;
    // AND THE ONE CASE WHERE WRITING ANYTHING ON THE TICKET IS THE WRONG MOVE,
    // said in as many words so nobody keeps trying it. They wrote the path our
    // own sentence asked them for; on a ticket naming this many repositories
    // the next run reads it and still takes none of them, and it does not ask
    // again once this work carries an answer. Only the list moves this.
    case "too_many_open":
      return `Writing a path in a comment does not bring ${repositoryKey} into this work while this ticket names more than ${TEXT_MATCH_AMBIGUITY_LIMIT} repositories nobody has decided about: a run takes none of them from the ticket's text, and it does not ask which to start from once this work carries an answer. Select it in this work's repository list, through the work scope API or the work_scope.edit tool.`;
    case "not_listed":
      return null;
    // Composed by the caller from `exclusionRecoveryNotes`, because an
    // exclusion's way back is filtered by what the deployment can still serve
    // and by the pin. A fixed sentence here would promise a person a list they
    // can change for a repository no run could take afterwards.
    case "excluded":
      return null;
  }
}

/** More than this many open repositories named in the ticket text is the
 *  ambiguity the which-of-these question asks about. Here because two rules
 *  read it: the selection that asks (`selectRepositoriesFromMetadata`) and the
 *  remedy that has to know when a path written in a comment is not taken
 *  (`aCommentPathIsTaken`). */
export const TEXT_MATCH_AMBIGUITY_LIMIT = 3;

/**
 * Is a full repository path written in a ticket comment a way back that works?
 *
 * ONE PREDICATE, AND IT IS THE ONE THE RUN DECIDES ON. A comment reaches the
 * next run's text scan, and that scan derives nothing while more than
 * `TEXT_MATCH_AMBIGUITY_LIMIT` open matches stand: it asks which of them to
 * start from instead. So the honest reading is the count of OPEN matches, the
 * same count `selectRepositoriesFromMetadata` gates the question on, taken as
 * this run sees it rather than from what some older question happened to ask
 * about. A question asked about five, of which two have since become unusable,
 * leaves three open and the text IS read again; telling that person the door is
 * shut would be false, and it is what sending them to the record alone would
 * say.
 *
 * Counted AFTER `decidableWorkScopeKeys`, because a match the record already
 * decided is not an open choice and never counted towards the ambiguity.
 *
 * A caller with no scan of the ticket passes null and gets false: under-offering
 * a route that would have worked costs a reader one extra step, while offering
 * one that is shut is the dead end rule 6 forbids.
 */
function aCommentPathIsTaken(openTextMatchKeys: readonly RepositoryKey[] | null): boolean {
  if (openTextMatchKeys === null) return false;
  return new Set(openTextMatchKeys).size <= TEXT_MATCH_AMBIGUITY_LIMIT;
}

/** How the which-of-these question about the ticket's text opens. One source,
 *  because a surface with no run behind it recognises the question by it
 *  (`commentPathAfterAnUnrecordedAnswer`). */
export const TEXT_AMBIGUITY_QUESTION_OPENING = `More than ${TEXT_MATCH_AMBIGUITY_LIMIT} repositories match this ticket.`;

/**
 * How a question NAMES the repositories it shows as already part of this work.
 *
 * One source, for the same reason as the opening above: the surface that reads
 * an answer has to know whether the person was shown any, and the ask reason
 * cannot tell it. Every ask on a question raised by repository discovery is
 * stamped `selection` too, so a reader keying on that told people their answer
 * had been about repositories a question had never listed. This sentence is
 * written by exactly one builder (`selectionQuestion` in
 * `engine/pre-sandbox/steps/repo-selection.ts`), so its presence is the fact.
 */
export const KEPT_REPOSITORIES_SENTENCE_OPENING =
  "Already part of this work, and kept whatever you reply:";

/** Did this question show the person repositories it said were kept whatever
 *  they reply? */
export function questionShowedKeptRepositories(questions: readonly string[]): boolean {
  return questions.some((question) => question.includes(KEPT_REPOSITORIES_SENTENCE_OPENING));
}

/** What an "answer not recorded" comment may say about writing a path in a
 *  comment: that the route is shut for a reason it can name, or nothing at
 *  all, because nothing on that surface proves it open. */
export type UnrecordedAnswerCommentPath = "too_many_open" | "unproven";

/**
 * What the comment posted about an answer that recorded nothing may say about
 * sending the person to write a path in a ticket comment.
 *
 * WE MAY UNDER-PROMISE, NEVER OVER-PROMISE, AND THIS SURFACE CAN PROVE NOTHING
 * OPEN. It runs when an answer arrives, with no run behind it, no scan of the
 * ticket and no provider listing, so it cannot count the ticket's open matches
 * the way a run does (`commentPathIsTaken`). Whether a written path is taken is
 * that count, so the comment route is never offered from here:
 *
 * - The which-of-these question about the ticket's text is raised only while
 *   more than three open repositories stand, and an answer that recorded
 *   nothing changes none of them, so the route is shut for a reason the
 *   sentence can name: "too_many_open".
 * - Every other question, the one repository discovery asks included: nothing
 *   here proves the route either way, and the sentence names only routes that
 *   work whatever the ticket says: "unproven". A discovery question once
 *   counted its own list with the work's answered set and offered the comment
 *   within three; the ticket could name four more open repositories besides,
 *   and the path went nowhere (joint gate round 3, R8).
 *
 * The question is recognised by its opening, which the code that asks it
 * writes from the same constant. That is a reading of rendered text, and a copy
 * edit that stopped using the constant would fall into "unproven", which
 * under-promises; the durable carrier would be the question's kind stored on
 * the clarification row, which is a data model change and an open row.
 */
export function commentPathAfterAnUnrecordedAnswer(input: {
  questions: readonly string[];
}): UnrecordedAnswerCommentPath {
  return input.questions.some((question) => question.includes(TEXT_AMBIGUITY_QUESTION_OPENING))
    ? "too_many_open"
    : "unproven";
}

/**
 * The way back from a repository an answer left unnamed, for the person alone.
 *
 * Only doors that open, chosen by case (`commentPathIsTaken` on the recorder).
 * The record edit always works. A full path written in a ticket comment works
 * when the ticket's text is still read, and the next run then takes it as a
 * person naming the repository rather than as a guess (rule 3 of
 * `docs/product/repository-record-behaviour.md`); where it is not read, the
 * sentence does not mention it at all.
 *
 * Kept out of the agent's instruction channel for the reason the exclusion note
 * is: it names a lever (rule 7).
 */
export function unnamedRecoveryNotes(
  unnamedKeys: readonly RepositoryKey[],
  commentPathIsTaken: boolean,
): string[] {
  // THE EXAMPLE IS THE LOWEST KEY, NOT THE FIRST ONE HANDED IN. Callers arrive
  // with whatever order the thing that refused happened to use: a model's
  // request order, a discovery proposal, the record's own list. Reading
  // `unnamedKeys[0]` made this sentence a function of that order rather than of
  // the work, so two runs on one record, refused in a different order, showed a
  // different repository as the example. It is a fact about the subject; it
  // reads the same every time.
  const [first] = [...unnamedKeys].sort();
  if (first === undefined) return [];
  return [
    commentPathIsTaken
      ? `Leaving a repository out of an answer is not final: this work's repository list can be changed through the work scope API or the work_scope.edit tool, or the repository's full path can be written in a ticket comment, as ${first}, and the next run reads both.`
      : "Leaving a repository out of an answer is not final: this work's repository list can be changed through the work scope API or the work_scope.edit tool, and the next run starts from the changed list.",
  ];
}

/** The second fact, when the listing carries it. A repository that is excluded
 *  AND cannot be served today is two facts, and a reader given only the first
 *  changes the list and waits for a run that still leaves it out.
 *
 *  It carries the action as well, because this is the channel a way back
 *  belongs in. The refusal sentence itself says none: it reaches the model too,
 *  and a screen to click is addressed to a person alone. */
function catalogCannotServeNote(keys: readonly RepositoryKey[]): string {
  const them = keys.length === 1 ? "that repository" : "those repositories";
  // NOT "enable it on the Repositories page". The keys this sentence is written
  // about come from `unusableKeys`, which is a SUBSET of the enabled ones, so
  // that advice sent a person to a page where they found the repository already
  // switched on, and cost them a round to learn that what has to change is the
  // repository itself, not the catalog.
  return `The catalog cannot serve ${keys.join(", ")} at the moment, so changing the list brings ${them} back only once the catalog can. ${keys.length === 1 ? "It is enabled here already" : "They are enabled here already"}: what the provider offers for ${them} is what has to change.`;
}

/** The third fact, and the same shape as the second. A definition pin is a
 *  capability bound nothing is exempt from, a person's own selection included,
 *  so a repository outside it comes back to the list and is refused again for a
 *  different reason.
 *
 *  Exported for the expansion loop's own account of what it could not use
 *  (`repository-discovery/runner.ts`), which owes a person this same sentence
 *  about the same bound. A second spelling there was already drifting in the
 *  one way that matters: it did not say that changing the repository list is
 *  the thing that will not help. */
export function outsidePinNote(keys: readonly RepositoryKey[]): string {
  return `The workflow that runs this work is limited to a fixed set of repositories, which does not include ${keys.join(", ")}, so changing the list brings ${keys.length === 1 ? "that repository" : "those repositories"} back only once that limit changes.`;
}

/**
 * What a person reads when a repository they excluded was left out: that the
 * exclusion can be taken back, and, where the caller knows of one, what else
 * stands in the way of it actually coming back.
 *
 * Every true sentence rather than one true sentence and a silence. The recovery
 * sentence is said for any excluded repository the catalog still holds, because
 * taking the exclusion back is the part a person controls. The other two are
 * added only on evidence: a path that listed nothing knows nothing about
 * usability, and a caller that holds no pin is a caller nothing is pinned for.
 *
 * WHY THE OTHER TWO EXIST AT ALL. `blockingReason` answers `excluded` before
 * either test, so a repository that is excluded AND unusable, or excluded AND
 * outside the pin, is refused as excluded and reads as a plain "somebody
 * decided this". Promise recovery on that alone and a person takes the
 * exclusion back, starts a run, and is refused again for a reason nobody
 * mentioned. Each dimension the caller can see gets its own sentence.
 *
 * Exported because three paths reach a person with the same fact and must reach
 * them with the same words: the recorder below, the discovery decision in
 * `agent-workflow`, and the failing-run sentence in
 * `repository-discovery/protocol.ts`.
 */
export function exclusionRecoveryNotes(
  excludedKeys: readonly RepositoryKey[],
  bounds: {
    /** Null where this path holds no catalog it can answer from, so it filters
     *  nothing. The recovery sentence promises that the LIST can be changed and
     *  that the next run starts from the changed one, which is true whether or
     *  not the caller can see the catalog; what a catalog buys is the right to
     *  withhold it from a repository the deployment no longer holds at all. */
    enabledKeys: readonly RepositoryKey[] | null;
    /** Null where this path never listed the repositories, so it knows nothing
     *  about usability and says nothing about it. */
    unusableKeys: readonly RepositoryKey[] | null;
    /** The definition pin, spelled as `decide.ts` reads it: null for no bound.
     *  Absent means the caller holds no pin, which is the same answer. */
    pinnedProviders?: readonly VcsProviderKind[] | null;
    pinnedKeys?: readonly RepositoryKey[] | null;
  },
): string[] {
  const enabled = bounds.enabledKeys === null ? null : new Set(bounds.enabledKeys);
  const recoverable = [...new Set(excludedKeys)].filter(
    (key) => enabled === null || enabled.has(key),
  );
  if (recoverable.length === 0) return [];
  const unusable = bounds.unusableKeys === null ? null : new Set(bounds.unusableKeys);
  const unservable = unusable === null ? [] : recoverable.filter((key) => unusable.has(key));
  const providers = bounds.pinnedProviders ?? null;
  const keys = bounds.pinnedKeys ?? null;
  const outsidePin = recoverable.filter(
    (key) =>
      (providers !== null && !providers.some((provider) => key.startsWith(`${provider}:`))) ||
      (keys !== null && !keys.includes(key)),
  );
  return [
    EXCLUSION_RECOVERY_NOTE,
    ...(unservable.length > 0 ? [catalogCannotServeNote(unservable)] : []),
    ...(outsidePin.length > 0 ? [outsidePinNote(outsidePin)] : []),
  ];
}
