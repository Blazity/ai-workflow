/**
 * The run's half of the work scope decision: it turns what a run holds into the
 * context the pure decision module reads, and it keeps one event's attachments
 * visible to the next event of the same run.
 *
 * It exists because a run decides the same thing several times from different
 * evidence. The ticket path raises a run start, a workflow-owned branch, a
 * ticket text match and a remembered routing answer; the pull request path
 * raises a run start and two derived events. Every one of them has to see what
 * the ones before it already attached, or the eight repository workspace would
 * be counted from an empty workspace each time and one repository would be
 * attached twice. The alternative, threading `attachedKeys` by hand through
 * each call site, is the same bookkeeping written four times.
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
  type WorkScopeRefusalReason,
  type WorkScopeWritePlan,
  type WorkflowRepositoryScope,
} from "@shared/contracts";
import {
  decideWorkScope,
  type WorkScopeDecision,
  type WorkScopeDecisionContext,
  type WorkScopeDecisionEvent,
} from "./decide.js";

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
        notes.push(refusalNote(refusal.repositoryKey, refusal.reason));
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

/** Why a repository the run knows about is not in its workspace, in one
 *  sentence, because that sentence is what reaches a ticket comment and a run's
 *  status reason. */
function refusalNote(repositoryKey: RepositoryKey, reason: WorkScopeRefusalReason): string {
  switch (reason) {
    case "outside_catalog":
      return `${repositoryKey} is recorded on this work, but the repository catalog did not offer it to this run, so the run started without it.`;
    case "outside_policy":
      return `${repositoryKey} is outside the repositories this trigger may take, so the run started without it.`;
    case "excluded":
      return `${repositoryKey} was excluded on this work, so the run started without it.`;
    case "unavailable":
      return `${repositoryKey} is recorded as unavailable on this work, so the run started without it.`;
    case "workspace_cap":
      return `${repositoryKey} did not fit this run's eight repository workspace.`;
    case "request_limit":
      return `${repositoryKey} was refused because more than three repositories were requested at once.`;
    case "rounds_exhausted":
      return `${repositoryKey} was refused because this run has used up its expansion rounds.`;
  }
}
