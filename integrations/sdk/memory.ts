/**
 * The `memory` capability port: what an integration implements so a run can
 * carry what it learned into the next one. One provider is active per
 * deployment, and a deployment that connects none keeps the built-in store
 * that lives in core.
 *
 * TWO INTERFACES, ON PURPOSE.
 *
 * `MemoryAdapter` is the run-facing half: **observations in, rendering out**.
 * Core says "here is what this run learned about this subject" and "tell me
 * what you know about this subject"; the provider decides what to keep, what
 * supersedes what and what to forget. It is deliberately NOT "read the
 * document, merge it and write it back with the version you read": that shape
 * can be implemented by nobody except the built-in store, because a hosted
 * memory engine does the merging itself, and that merging is the product. It
 * is deliberately not "add, update by id, delete by id" either: two runs that
 * both add and nobody reconciles is a memory that silently contradicts itself
 * weeks later.
 *
 * `MemoryStoreAdapter` is the admin half, reached from the memory screen and
 * its MCP tools: list what is there, read one, erase one. A different caller
 * with a different need. It is optional, because an engine with no enumerable
 * store can still serve runs perfectly well; core then tells the person that
 * this deployment's memory cannot be listed here, and never presents an empty
 * list as an empty store.
 *
 * Nothing here names a provider, a table, a document version or a row.
 */

/**
 * What a memory is about, as core addresses it.
 *
 * `key` is core's persisted address for the subject (`ticket:jira:AIW-1`,
 * `repo:github:acme/api`, `org:github:acme`). It is opaque to a provider:
 * compared and stored, never parsed. It is stable across deployments of this
 * product and is the only thing that ties a run to what an earlier run
 * learned, so a provider that rewrites it orphans everything already stored.
 *
 * `label` is the same subject in words, for a heading a person or a model
 * reads (`acme/api`, `acme`). A provider may render it and may ignore it; it
 * is never an address.
 */
export interface MemorySubject {
  readonly key: string;
  readonly label: string;
}

/**
 * Which kind of knowledge, as core's fixed vocabulary.
 *
 * `facts` is what is true about the subject; `lessons` is what went wrong and
 * what worked; `notebook` is the working document an agent keeps for one piece
 * of work and edits itself. They are separate because they are injected into
 * prompts under separate budgets and because a person deletes one without the
 * others. Every one of these words is already written into stored rows, so
 * none of them may be renamed.
 *
 * `notebook` carries a `name` and the other two do not, which is why this is a
 * union rather than three strings: a subject has exactly one set of facts and
 * one set of lessons, and its notebook is named after the piece of work it
 * belongs to. A caller therefore cannot reach a notebook without saying which
 * one, and cannot accidentally address them all as one.
 */
export type MemoryScope =
  | { readonly kind: "facts" }
  | { readonly kind: "lessons" }
  | {
      readonly kind: "notebook";
      /**
       * Core's own name for the piece of work (a ticket identifier, a pull
       * request's subject key). Opaque to a provider: stored and compared,
       * never parsed, and never shown as a heading.
       */
      readonly name: string;
    };

/** The three words a scope can be, for a caller that iterates or reports. */
export type MemoryScopeKind = MemoryScope["kind"];

/** One thing a provider remembers, as a person and a model read it. */
export interface MemoryEntry {
  /**
   * The remembered text, carrying none of the provider's own bookkeeping.
   * Whatever a provider records about who asserted this and when stays inside
   * the provider: it is not knowledge, and a run that saw it would repeat it.
   */
  readonly text: string;
}

export interface MemoryRecallRequest {
  readonly subject: MemorySubject;
  readonly scope: MemoryScope;
  /**
   * Things the caller already has in front of it. A provider leaves matching
   * entries out of both `entries` and `rendering`, so the same knowledge does
   * not reach one prompt twice under two headings. Matching is the provider's
   * own notion of "the same thing said twice", which is the notion it dedups
   * with, so a caller never has to guess it.
   */
  readonly exclude?: readonly string[];
}

export type MemoryRecall =
  | {
      readonly ok: true;
      /**
       * Whether this provider holds anything at all for this subject and
       * scope, before `exclude` and before any rendering.
       *
       * Separate from `entries.length > 0` because they answer different
       * questions: a caller that seeds a subject only when nothing has ever
       * been written needs "has anybody written here", and "it rendered to
       * nothing this time" is not that. Reading one for the other is how a
       * seed overwrites a store somebody else already filled.
       */
      readonly held: boolean;
      readonly entries: readonly MemoryEntry[];
      /**
       * What core injects into a prompt: the provider's own rendering of the
       * entries above, free of its bookkeeping. Empty when there is nothing to
       * say. Core never assembles this itself, because how a provider says
       * what it knows is the provider's business.
       */
      readonly rendering: string;
    }
  | { readonly ok: false; readonly code: MemoryFailure; readonly detail: string };

/**
 * What a run learned. Two shapes, because two things in this product are
 * called memory and they are not the same thing.
 *
 * `items` is distilled knowledge: separate assertions, some of which supersede
 * or disprove what is stored. This is the shape a hosted engine is built for.
 *
 * `document` is a working document the agent itself wrote and the provider
 * stores whole. It has no items to reconcile: the agent is the only writer and
 * the latest version is the truth.
 */
export type MemoryObservation =
  | {
      readonly kind: "items";
      /** Asserted by this run. A provider may store, merge or ignore each. */
      readonly learned: readonly string[];
      /**
       * Observed by this run to be false. A provider forgets what these name.
       * An entry that is both learned and refuted taught nothing and is stored
       * nowhere.
       */
      readonly refuted: readonly string[];
      /**
       * Derived from the subject itself rather than authored by a model, which
       * today means read out of a repository's own manifest.
       *
       * It is retention information a provider genuinely needs: nothing
       * reproduces a derived entry once its run is over, while model prose is
       * re-derived by the next run that looks, so a provider under pressure
       * should give up the prose first. A provider free to ignore it stays
       * correct, just less useful.
       */
      readonly derived?: true;
      /**
       * Write only if the provider holds nothing for this subject and scope.
       * `stored: false` comes back when it already did, and nothing is merged.
       *
       * It exists for a deterministic seed, which is strictly worse than what
       * a real run distils: a seed may create a subject's memory and may never
       * edit what a run wrote into it.
       */
      readonly onlyIfEmpty?: true;
    }
  | {
      readonly kind: "document";
      readonly text: string;
      /**
       * The text is a PREFIX: the caller could not read the whole document, so
       * what follows is missing rather than absent.
       *
       * A provider needs it because it cannot tell a complete document from a
       * cut one by looking, and storing a cut one as complete is how a memory
       * comes to end mid sentence with nothing saying why. The built-in store
       * marks it; a provider that cannot is free to ignore it.
       */
      readonly sourceTruncated?: true;
    };

export interface MemoryObserveRequest {
  readonly subject: MemorySubject;
  readonly scope: MemoryScope;
  /** The run that observed this, for the provider's own provenance. */
  readonly runId: string;
  /**
   * The ticket this subject belongs to, or null when it belongs to none (a
   * repository, an organisation). Core's fact, carried so a person can find
   * everything one ticket left behind and erase it in one place.
   */
  readonly ticketKey: string | null;
  readonly observation: MemoryObservation;
}

export type MemoryWrite =
  | {
      readonly ok: true;
      /**
       * True when the provider took this observation, false when it decided
       * this changed nothing it already holds.
       *
       * NOT a promise that the next recall returns it. Mem0 answers an add
       * with an event id to poll and Zep answers one with 202 and a task id,
       * so an engine legitimately accepts work it has not finished. A caller
       * that reads this as read-after-write is wrong about every provider
       * except the built-in one.
       */
      readonly stored: boolean;
      /** Entries it forgot because this run refuted them. */
      readonly removed: number;
      /** Entries it forgot to stay within what it is willing to hold. */
      readonly dropped: number;
      /** What it holds for this subject and scope afterwards. */
      readonly remaining: number;
    }
  | { readonly ok: false; readonly code: MemoryFailure; readonly detail: string };

/**
 * Why memory could not answer. One union for the whole path, so a caller and
 * the run's record speak one vocabulary.
 *
 * `unavailable`, `contended` and `rejected` are a provider's answers.
 * `no_provider`, `ambiguous`, `unreadable` and `moved` are core's answers
 * about the deployment, produced before any provider is called; a provider
 * never returns one.
 *
 * None of them is "looked and found nothing", which is a successful recall
 * with no entries.
 */
export type MemoryFailure =
  /** The provider could not be reached, or it threw. Worth retrying. */
  | "unavailable"
  /** Another writer kept winning, so this run's observation was not stored. */
  | "contended"
  /** The provider refused what it was given, and retrying will not help. */
  | "rejected"
  /** Core: no integration serves memory and the built-in store is gone too. */
  | "no_provider"
  /** Core: several integrations serve memory and no active one is selected. */
  | "ambiguous"
  /** Core: this deployment's integration settings could not be read. */
  | "unreadable"
  /** Core: the provider this run started with is not the one serving now. */
  | "moved";

/**
 * What a memory provider implements for runs.
 *
 * `recall` AND `observe` NEVER THROW. A failure is an answer, because memory
 * must not be able to change a run's outcome, and because a caller that IS told
 * can record that this run finished without memory instead of looking identical
 * to a run that had nothing stored.
 *
 * The rule stops at those two. `store` below is a different interface with a
 * different caller and a different rule, stated on it.
 */
export interface MemoryAdapter {
  recall(request: MemoryRecallRequest): Promise<MemoryRecall>;
  observe(request: MemoryObserveRequest): Promise<MemoryWrite>;
  /**
   * The admin half, for the memory screen and its MCP tools. Optional: an
   * engine that cannot enumerate what it holds leaves it out and stays fully
   * usable for runs. Core then says so on the screen rather than showing an
   * empty list.
   *
   * Core hands this object to its admin callers unwrapped
   * (`engine/support/memory-runtime.ts`, `wrap`), because it is not a run path
   * and the two halves do not share a failure rule.
   */
  readonly store?: MemoryStoreAdapter;
}

/**
 * One stored document as the admin half addresses it.
 *
 * `subjectKey` and `docPath` are core's persisted address, the same pair the
 * memory screen has always shown and the same pair an erasure request names.
 * They are store vocabulary on purpose: this interface is about what a store
 * holds, which is exactly what the run-facing port refuses to be about.
 */
export interface MemoryStoredDocumentRef {
  readonly subjectKey: string;
  readonly docPath: string;
}

export interface MemoryStoredDocument {
  readonly content: string;
  readonly bytes: number;
  readonly updatedAt: Date;
  /** The run that last wrote it, empty when the provider does not record one. */
  readonly sourceRunId: string;
}

export interface MemoryStoredSummary extends MemoryStoredDocumentRef {
  readonly ticketKey: string | null;
  readonly bytes: number;
  readonly sourceRunId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What a provider implements so a person can see and erase what it holds.
 *
 * A provider may implement it shallowly: an engine that can search but not
 * enumerate answers what it can and core says the listing is partial. What it
 * may not do is answer an empty list for a store it simply cannot read, which
 * is why `list` reports `complete`.
 *
 * These three MAY throw, unlike `recall` and `observe` above. Core catches the
 * throw and turns it into "this could not be read" on the screen and into a
 * retryable error for the MCP tools. Swallowing it yourself and answering an
 * empty list or an absent document tells a person their memory is gone.
 */
export interface MemoryStoreAdapter {
  list(options: {
    readonly ticketKey?: string;
    readonly limit?: number;
  }): Promise<MemoryStoreListing>;
  read(ref: MemoryStoredDocumentRef): Promise<MemoryStoredDocument | null>;
  /** False when nothing was there, which is a miss and not a success. */
  forget(ref: MemoryStoredDocumentRef): Promise<boolean>;
}

export interface MemoryStoreListing {
  readonly documents: readonly MemoryStoredSummary[];
  /**
   * False when this provider cannot promise the list is everything it holds,
   * so a screen says so instead of letting a person read absence as proof.
   */
  readonly complete: boolean;
}
