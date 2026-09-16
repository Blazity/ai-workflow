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
  type WorkScopeEntry,
  type WorkScopeWritePlan,
  type WorkflowRepositoryScope,
} from "@shared/contracts";
import {
  decideWorkScope,
  type WorkScopeDecision,
  type WorkScopeDecisionContext,
  type WorkScopeDecisionEvent,
} from "./decide.js";
// Both refusal surfaces render from here, so the run start and the mid run
// expansion cannot end up holding different facts about the same repository.
import { workScopeRefusalSentence } from "./refusal-sentence.js";

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
   * still derive: reachable, and carrying no blocking entry. The same filter
   * `decideWorkScope` applies to a `text_ambiguous` event, exposed because the
   * caller has to apply it BEFORE it counts matches: a set of five matches that
   * collapses to two decidable keys is an ordinary derived event, not an
   * ambiguity.
   */
  decidableKeys(keys: readonly RepositoryKey[]): RepositoryKey[];
  /** At most what one event may carry, in input order. */
  boundEventKeys(keys: readonly RepositoryKey[]): RepositoryKey[];
  /** The write plans the caller's step applies, in the order they were decided. */
  readonly plans: WorkScopeWritePlan[];
  /** Every repository a question named, with the reason it was asked. */
  readonly ask: WorkScopeAskedRepository[];
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
  /** What the workspace holds after every event decided so far. */
  readonly attachedKeys: RepositoryKey[];
}

export function createRunWorkScopeRecorder(input: RunWorkScopeInput): RunWorkScopeRecorder {
  const attached: RepositoryKey[] = [...(input.attachedKeys ?? [])];
  const plans: WorkScopeWritePlan[] = [];
  const ask: WorkScopeAskedRepository[] = [];
  const notes: string[] = [];
  const leftOut: Array<{ repositoryKey: RepositoryKey; reason: string }> = [];
  const recoveryNotes: string[] = [];
  const pinnedProviders = pinnedProvidersOf(input.repositoryScope);
  const pinnedKeys = pinnedKeysOf(input.repositoryScope);
  const entries = new Map(
    (input.scope?.entries ?? []).map((entry) => [entry.repositoryKey, entry] as const),
  );
  const enabled = new Set(input.catalog.enabledKeys);
  const unusable =
    input.catalog.unusableKeys === null ? null : new Set(input.catalog.unusableKeys);

  // The same three rules `decide.ts` reads facts by. They are restated rather
  // than exported from there because they answer a question the decision itself
  // never asks: how many of these matches are still open. The tests below pin
  // both spellings to the same answers.
  const isUsable = (key: RepositoryKey) =>
    enabled.has(key) && (unusable === null || !unusable.has(key));
  const isInPin = (key: RepositoryKey) =>
    (pinnedProviders === null ||
      pinnedProviders.some((provider) => key.startsWith(`${provider}:`))) &&
    (pinnedKeys === null || pinnedKeys.includes(key));
  const isExpired = (entry: WorkScopeEntry) =>
    entry.state === "unavailable" &&
    isUsable(entry.repositoryKey) &&
    (entry.unavailableReason === "not_enabled" ? input.catalog.activated : unusable !== null);

  return {
    subjectKey: input.subjectKey,
    runId: input.actor.kind === "run" ? input.actor.runId : null,
    note(sentence) {
      notes.push(sentence);
    },
    get plans() {
      return plans;
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
      return recoveryNotes;
    },
    get attachedKeys() {
      return [...attached];
    },
    boundEventKeys(keys) {
      return [...new Set(keys)].slice(0, EVENT_KEYS_MAX);
    },
    decidableKeys(keys) {
      return [...new Set(keys)].filter((key) => {
        if (!isUsable(key) || !isInPin(key)) return false;
        const entry = entries.get(key);
        if (!entry || isExpired(entry)) return true;
        return entry.state !== "excluded" && entry.state !== "unavailable";
      });
    },
    decide(event) {
      const decision = decideWorkScope(
        {
          scope: input.scope,
          // A run that reads a record is a run whose subject carries one: the
          // run start step freezes the scope only for a subject that does.
          carriesRecord: true,
          catalog: input.catalog,
          pinnedProviders,
          pinnedKeys,
          policy: input.policy,
          eventRelatedKeys: input.eventRelatedKeys ?? [],
          attachedKeys: [...attached],
          selectionAnswered: input.selectionAnswered,
          actor: input.actor,
          now: input.now,
        },
        event,
      );
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
      // The one refusal a person made themselves is the one a person can take
      // back, and until this sentence existed nothing said so: the run died and
      // the only way anybody found was a new ticket. Said once however many
      // repositories were refused, because repeating it under each of them
      // drowns the sentences naming them.
      if (recoveryNotes.length === 0) {
        recoveryNotes.push(
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
 *  here that the choice is theirs to change. It names a list rather than a
 *  screen, so it stays true until the panel ships and gains a link then. */
const EXCLUSION_RECOVERY_NOTE =
  "Excluding a repository is not final: this work's repository list can be changed, and the next run starts from the changed list.";

/** The second fact, when the listing carries it. A repository that is excluded
 *  AND cannot be served today is two facts, and a reader given only the first
 *  changes the list and waits for a run that still leaves it out.
 *
 *  It carries the action as well, because this is the channel a way back
 *  belongs in. The refusal sentence itself says none: it reaches the model too,
 *  and a screen to click is addressed to a person alone. */
function catalogCannotServeNote(keys: readonly RepositoryKey[]): string {
  const them = keys.length === 1 ? "that repository" : "those repositories";
  return `The catalog cannot serve ${keys.join(", ")} at the moment, so changing the list brings ${them} back only once the catalog can. Enable ${keys.length === 1 ? "it" : "them"} on the Repositories page.`;
}

/** The third fact, and the same shape as the second. A definition pin is a
 *  capability bound nothing is exempt from, a person's own selection included,
 *  so a repository outside it comes back to the list and is refused again for a
 *  different reason. */
function outsidePinNote(keys: readonly RepositoryKey[]): string {
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
