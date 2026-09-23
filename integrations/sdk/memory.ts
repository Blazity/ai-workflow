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
 * fits only a store core owns, and it would put the merging in core, away from
 * whatever the engine knows. It is deliberately not "add, update by id, delete
 * by id" either: two runs that both add and nobody reconciles is a memory that
 * silently contradicts itself weeks later.
 *
 * RECONCILING IS THE ADAPTER'S JOB whenever the engine does not do it. Some
 * engines merge what they are given; others only add, and keep an assertion
 * and its refutation side by side, so the next recall answers both. Against an
 * engine like that, the adapter does the merge itself before `observe`
 * answers: it forgets what `refuted` names and does not store a `learned`
 * entry that restates one already held. Passing observations straight through
 * to an add-only engine satisfies these types and breaks the promise above.
 * Ignoring `refuted` is not an option either: the next run is then told both
 * the fact and its refutation, and trusts whichever it reads first.
 *
 * WHAT CORE DOES FOR EVERY PROVIDER, so no adapter has to, and no adapter
 * should do again:
 *
 * - Secrets. Every observation reaches `observe` with every secret this
 *   deployment knows already taken out of its text (the environment's and
 *   those an admin stored in the dashboard, which an integration is never
 *   handed). Text core could not clean is refused before it reaches you. Core
 *   also takes them out of every `rendering` you recall before it reaches a
 *   prompt or a workspace, so a value you stored before it became a known
 *   secret goes no further; `entries` it hands on as you gave them, because
 *   a run quotes one back to retract it. Two silences follow, by design: the
 *   set is read once per step, so a secret added in the middle of a step is
 *   taken out from the next step on; and because `entries` stay as stored, a
 *   value stored before it became a known secret still reaches the model that
 *   distils, which is how a run can name that entry to retract it.
 * - Size in a prompt. Core cuts what it injects to `MEMORY_PROMPT_BUDGET_BYTES`
 *   per scope and a notebook to `MEMORY_NOTEBOOK_MAX_BYTES`, with a marker,
 *   whatever you return.
 * - Time. The calls one step makes through you share a budget of waiting
 *   time; past it core aborts your context's signal and answers `unavailable`
 *   for you (the guide names the number).
 * - Retries. Core NEVER repeats a `recall` or an `observe` that answered, with
 *   any code: the next step or the next run asks again. So the only repeat a
 *   write can suffer is one the adapter makes itself (see `MemoryFailure`).
 * - Who serves. Which provider answers a run, the built-in store included, is
 *   core's decision, made the same way for every run and for the editor.
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
 * ISOLATION FOLLOWS THE CONNECTION, not the deployment. Because the key is the
 * same everywhere, two deployments whose connections point at the same
 * engine project share one memory per subject, exactly as two deployments
 * that share a database share the built-in store. That is intended; an
 * operator who wants separate memories gives each deployment its own engine
 * project (one project per connection is the recommendation). What is never
 * intended is sharing with ANOTHER APPLICATION that uses the same project: an
 * engine usually returns everything a filter does not exclude, so an adapter
 * writes a namespace of its own (the engine's application or agent field, or
 * a metadata key) on every write and requires it on every read, list and
 * delete. Without it a project that also serves a chatbot hands the chatbot's
 * memories to a prompt, the memory screen and an erasure.
 *
 * MATCHED EXACTLY, ALWAYS, and the same holds for a notebook's `name`. Never
 * hand either to an engine call that reads it as a pattern, a prefix or a
 * filter (a glob, a regular expression, a search query, a metadata filter
 * with wildcards). A key that happens to contain `*`, or an empty one, then
 * addresses every subject, and against an engine that deletes by filter, a
 * wildcard delete across all users is one request away. Use the engine's
 * exact-match form or escape the value, and refuse the call when the engine
 * offers neither.
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
 * prompts under separate budgets (`MEMORY_PROMPT_BUDGET_BYTES`) and because a
 * person deletes one without the others. Every one of these words is already
 * written into stored rows, so none of them may be renamed.
 *
 * WHICH OBSERVATION EACH SCOPE RECEIVES, fixed by core: `facts` and `lessons`
 * receive only `items`, a `notebook` receives only a `document`. An adapter
 * may refuse the other combination as `rejected` (the built-in store does);
 * it never has to merge a document into items or split one into entries.
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
       * request's subject key). Opaque to a provider: stored and compared
       * exactly (see `MemorySubject.key`), never parsed, and never shown as a
       * heading.
       */
      readonly name: string;
    };

/** The three words a scope can be, for a caller that iterates or reports. */
export type MemoryScopeKind = MemoryScope["kind"];

/**
 * How much of what providers recall reaches one agent prompt, in UTF-8 bytes
 * of `rendering`, per scope, summed over every subject the prompt carries (the
 * owner's facts and each repository's). Core enforces it where it builds the
 * prompt, whatever a provider returns: a rendering that does not fit what is
 * left is cut and ends with a line saying it was cut, and later renderings of
 * that scope are left out and logged. The cut lands at the last line end that
 * keeps at least half the room, and inside a line when none does (one very
 * long entry). Facts and lessons have a
 * budget each, so a long facts list never starves the lessons beside it.
 *
 * So a provider does not need to be small, only ordered: what core cuts is the
 * end, and what a provider puts first is what survives. Put what nothing else
 * can reproduce first (entries marked `derived`), then what a recent run
 * confirmed. Rendering far past this budget costs your engine the reads and
 * this deployment nothing.
 */
export const MEMORY_PROMPT_BUDGET_BYTES = { facts: 16 * 1024, lessons: 16 * 1024 } as const;

/**
 * The largest notebook core moves between a provider and an agent's
 * workspace, in UTF-8 bytes. Core reads at most this much of the agent's file
 * (a longer one arrives with `sourceTruncated`), and writes at most this much
 * of a recalled notebook into the workspace, cut with a line saying so. A
 * notebook is a file the agent opens, never a prompt section, so the prompt
 * budget above does not apply to it.
 */
export const MEMORY_NOTEBOOK_MAX_BYTES = 256 * 1024;

/**
 * One thing a provider remembers, as a person and a model read it.
 *
 * Core reads `entries` in two places: to tell a distilling model what is
 * already known (so it can quote an entry exactly to refute it, which is why
 * an entry must come back in the words it was stored in), and to know what an
 * owner's facts already said before asking for a repository's (`exclude`).
 */
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

/**
 * What a provider knows about one subject and scope.
 *
 * HOW MUCH TO READ. Enough to render what one prompt carries
 * (`MEMORY_PROMPT_BUDGET_BYTES` for its scope, cut by core past that) and no
 * more: an engine that pages its answers reads pages until the rendering would
 * pass the budget or there are no more pages. For a notebook, everything, up
 * to `MEMORY_NOTEBOOK_MAX_BYTES`.
 *
 * WHAT IS NOT AN ANSWER. A body you cannot read (an HTML error page, an empty
 * 200, JSON without the field you expected) is `ok: false, unavailable`, never
 * `ok: true, held: false`: "held nothing" makes a seed write into a store that
 * is already full and makes a run treat an old committed file as the ticket's
 * notebook.
 */
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
 *
 * ITEMS ARE ALREADY DISTILLED. Core's own model wrote each `learned` entry as
 * one line of at most 200 characters, from the run's material, against what
 * the provider already holds; a `derived` entry was read out of a manifest and
 * says exactly what the manifest says. So storing each item verbatim, one
 * stored memory per item, is the recommended default, and for `derived` it is
 * the only right choice. Passing items through an engine's own extraction
 * model is the adapter's decision, and it has to say why in its README: a
 * second pass costs a model call per observation, may reword or drop an item
 * (so a later `refuted` quoting the original words no longer matches), and
 * applies whatever instructions the engine project carries, which were
 * probably written for a different kind of memory.
 */
export type MemoryObservation =
  | {
      readonly kind: "items";
      /**
       * Asserted by this run. A provider may store, merge or ignore each; it
       * does not store one that restates an entry it already holds for this
       * subject and scope (the same text, by the comparison it dedups with).
       */
      readonly learned: readonly string[];
      /**
       * Observed by this run to be false. A provider forgets what these name.
       * An entry that is both learned and refuted taught nothing and is stored
       * nowhere.
       *
       * Each one quotes an entry `recall` returned, in its words, so against
       * an engine that only adds, forgetting is: list what this subject and
       * scope hold, and delete by id each memory whose text matches, by the
       * same comparison you dedup with. Never by a similarity score or a
       * search ranking, which deletes a neighbour, and never by a filter
       * delete, which cannot say what it removed. `removed` counts the deletes
       * the engine confirmed.
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
      /**
       * Stored WHOLE, REPLACING the previous version: the next recall of this
       * notebook returns exactly this text, not this text joined to the last
       * one and not the last one. Against an engine that only adds, that is an
       * add of the whole text followed by a delete of the previous version.
       *
       * Prefer a write that is done when it answers. The same run reads this
       * notebook back seconds later to distil it, and a write that is only
       * accepted for later makes that read return the previous version.
       */
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
  /**
   * The run that observed this, for the provider's own provenance. NEVER a
   * partition key: an engine that scopes memories by a run or session field
   * would file each run's knowledge where the next run never looks. Store it
   * as metadata, if at all.
   */
  readonly runId: string;
  /**
   * The ticket this subject belongs to, or null when it belongs to none (a
   * repository, an organisation). Core's fact, carried so a person can find
   * everything one ticket left behind and erase it in one place: store it
   * where `MemoryStoreAdapter.list({ ticketKey })` can filter on it.
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
       * NOT a promise that the next recall returns it. An engine may answer
       * an add with an id of work to poll, or with 202 and a task id, so it
       * legitimately accepts work it has not finished. A caller that reads
       * this as read-after-write is wrong about every provider except the
       * built-in one.
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
 * `unavailable`, `contended` and `rejected` are a provider's answers, and
 * core answers `unavailable` too when it will not call the provider: its
 * connection is failing, or it used up the time core gives memory in a step.
 * `no_provider`, `ambiguous`, `unreadable` and `moved` are core's answers
 * about the deployment, produced before any provider is called; a provider
 * never returns one.
 *
 * None of them is "looked and found nothing", which is a successful recall
 * with no entries.
 */
export type MemoryFailure =
  /**
   * The provider could not be reached, threw, did not answer in time, or its
   * connection is failing. Worth trying again on a later step or run, which
   * is when it happens: core never repeats the call that answered this.
   *
   * It is also the answer to a write whose fate you cannot tell (a timeout
   * after the request was sent, a connection reset mid-answer). Core will not
   * resend it, so answering `unavailable` cannot duplicate it; resending it
   * yourself can, against an engine with no idempotency key. So never retry
   * a write that may have landed, and pass `retries` to `ctx.http` only on a
   * write the provider documents as idempotent.
   */
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
   * What an admin loses without it: the memory screen and the `memory.list`,
   * `memory.get` and `memory.forget` tools answer that this deployment's
   * memory cannot be listed here, so a person's request to see or erase what
   * one ticket left behind has to be carried out in the engine's own console.
   * Say so in the integration's README.
   *
   * Core hands it to its admin callers without catching what it throws
   * (`engine/support/memory-runtime.ts`, `wrap`), because it is not a run path
   * and the two halves do not share a failure rule. It does redact what it
   * throws, and its calls spend the same time budget as the two above.
   */
  readonly store?: MemoryStoreAdapter;
}

/**
 * One stored document as the admin half addresses it.
 *
 * `subjectKey` and `docPath` are the pair the memory screen shows and an
 * erasure request names. They are store vocabulary on purpose: this interface
 * is about what a store holds, which is exactly what the run-facing port
 * refuses to be about.
 *
 * THE PAIR IS THE PROVIDER'S OWN. `subjectKey` is the `MemorySubject.key` it
 * was given; `docPath` is whatever string the provider chose for one
 * document. Core never builds a pair: `read` and `forget` receive exactly the
 * pairs this provider's own `list` returned, carried by a person or an MCP
 * client. Which means they arrive as input, and a caller can send anything:
 * match both exactly, refuse a pattern (`*`, an empty string) rather than
 * pass it to an engine that reads it as "every", and answer null or false for
 * any pair `list` could not have produced.
 *
 * For an engine that stores single memories rather than documents, the
 * recommended mapping is one document per subject and scope: `docPath` is the
 * scope's word (`facts`, `lessons`) or `notebook/<name>`; `content` is the
 * rendering `recall` would give; `bytes` its UTF-8 length; `createdAt` the
 * oldest memory's time and `updatedAt` the newest's; `sourceRunId` the newest
 * memory's run id from metadata, or empty; and `forget` deletes every memory
 * under the pair, by id, answering true when there was at least one.
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
 *
 * `read` and `forget` receive exactly the pairs this provider's `list`
 * returned; core never invents one (see `MemoryStoredDocumentRef` for what
 * that asks of you).
 */
export interface MemoryStoreAdapter {
  /**
   * What this provider holds for this deployment, newest first, at most
   * `limit` documents when one is given. With `ticketKey`, only the documents
   * whose observations carried that ticket (`MemoryObserveRequest.ticketKey`),
   * which is how a person erases everything one ticket left behind. An engine
   * that refuses a listing without an entity filter lists under the adapter's
   * own namespace (see `MemorySubject`), never under a wildcard.
   */
  list(options: {
    readonly ticketKey?: string;
    readonly limit?: number;
  }): Promise<MemoryStoreListing>;
  read(ref: MemoryStoredDocumentRef): Promise<MemoryStoredDocument | null>;
  /**
   * False when nothing was there, which is a miss and not a success. True
   * only once what was stored under the pair is gone: an engine that deletes
   * in the background has not answered that yet, so delete by id where it
   * offers that.
   */
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
