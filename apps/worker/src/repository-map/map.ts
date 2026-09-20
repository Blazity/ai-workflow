/**
 * THE REPOSITORY MAP: the one description of the repositories a send works on.
 *
 * Every agent that touches repositories reads the text this file renders, and
 * the structured entries beside it are the SAME PASS over the SAME input, so a
 * briefing records what the agent was actually told rather than a second
 * reading of the catalog. Two renderings of one fact is how the old "Selected
 * repositories" lists drifted apart, and a recorder fed by a second pass would
 * faithfully record the drift.
 *
 * WHAT THE MAP IS FOR. An agent used to be handed the repositories somebody had
 * selected and nothing else: not what they are for, not how they relate, not
 * which of the others it may ask for and which are settled. It spent passes
 * working out that one repository is the frontend of another, and it asked
 * again and again for repositories a person had excluded or nobody had enabled,
 * because nothing had ever told it they were closed. On production that cost a
 * planning run eleven minutes and then the run died. So the map states, once and
 * up front: what is attached and what may be written, what is related and may be
 * requested, and what is settled and may NOT be requested, each with its reason.
 *
 * BOUNDED BY CONSTRUCTION, AND BOUNDED BY WHAT IS LEFT. A catalog description
 * may hold 20,000 characters, a repository may carry an unbounded number of
 * relationships, and the compiler cuts a prompt section at 200,000 characters
 * FROM THE END, where our own `platform` rules sit. So an unbounded map does
 * not grow the prompt, it silently deletes our rules, and nothing turns red.
 * Every entry is bounded and the number of full entries is bounded; on top of
 * that the CALLER passes the room the rest of its prompt leaves
 * (`maxLength`), because a map bounded only against itself still pushes the
 * Resolution Check off the end of a 191,000 character ticket. A map that
 * cannot afford its own frame shrinks to one sentence carrying the count, so
 * "why did it not look at my repository" always has an answer in the prompt.
 *
 * The budget is spent in the order a model gets things wrong: the workspace
 * first, because a model that does not know where it is cannot start; the
 * settled repositories next, ONE LINE EACH and never dropped in silence,
 * because those are the ones it asks for again and again; then the
 * neighbourhood, which keeps a floor of its own so a hundred exclusions cannot
 * starve the thing this map exists for; then the rest of the catalog.
 *
 * DETERMINISTIC. The same record and the same catalog render byte-identical
 * text. The ranking is total: no tie is left to object key order or to a
 * database order with no ORDER BY. A briefing is evidence, and evidence that
 * reorders itself proves nothing; the Workflow DevKit replay depends on it too.
 *
 * WHAT IT NEVER CLAIMS. A catalog it could not read, a relationship list it
 * could not read and a send whose run predates the map are three different
 * silences, and each says so in the prompt. A map that renders nothing is a
 * positive claim that there is nothing, which is the failure this file exists
 * to end.
 */
import {
  REPOSITORY_RELATIONSHIP_KINDS,
  workScopeUnnamedWhy,
  type RepositoryKey,
  type RepositoryRelationshipKind,
  type WorkScopeEntry,
  type WorkScopeRefusalReason,
} from "@shared/contracts";
import {
  concatPromptParts,
  joinPromptParts,
  type EffectivePromptPart,
  type EffectivePromptPartOrigin,
} from "@shared/prompts";

/**
 * How a repository may be used by this send.
 *
 * The first three are usable; every other one carries a reason, because "you
 * may not touch this" with no why is the sentence that sends a model back to
 * ask and a person to the wrong screen.
 *
 * `disabled` and `unusable` are deliberately two values, the same distinction
 * the work scope contract keeps between `outside_catalog` and `unusable`:
 * somebody switched a repository off here, and the provider offered nothing we
 * could check out, are different facts with different remedies, and telling an
 * operator the second when the first is true sends them to a page where they
 * find the switch already on.
 *
 * These slugs are `REPOSITORY_STATES` in `@shared/agent-visibility`, spelled
 * here rather than imported: this module is reachable from the workflow
 * isolate, which may not pull a package with a runtime zod dependency into its
 * bundle. `map.vocabulary.test.ts` holds the two lists equal.
 */
export const REPOSITORY_MAP_STATES = [
  "write",
  "read_only",
  "offered",
  "excluded",
  "disabled",
  "not_enabled",
  "unusable",
  "outside_catalog",
  "refused",
] as const;
export type RepositoryMapState = (typeof REPOSITORY_MAP_STATES)[number];

/**
 * The refusals that SETTLE a repository for the rest of the run.
 *
 * A repository this run already refused must stop reading "you may request
 * it", or the next pass asks for it again and the run pays for the same answer
 * twice: that is the eleven minute planning failure, one pass later. But not
 * every refusal is final. `workspace_cap` and `request_limit` refuse THIS
 * request, not the repository: the model asked for four at once, or the
 * workspace was full at that instant, and asking again with a shorter list is
 * exactly the behaviour we want. Telling it "do not request it" there would
 * close a door the run left open, which is the same lie pointing the other way.
 */
export const SETTLING_REFUSAL_REASONS: readonly WorkScopeRefusalReason[] = [
  "outside_catalog",
  "outside_policy",
  "unusable",
  "excluded",
  "unavailable",
  "rounds_exhausted",
  "unnamed_in_answer",
];

/** The states a send may act on. Everything else is settled. */
export const USABLE_REPOSITORY_MAP_STATES = ["write", "read_only", "offered"] as const;

/** Why a repository is in the map at all. `REPOSITORY_INCLUSION_CAUSES` in
 *  `@shared/agent-visibility`, spelled here for the reason above. */
export const REPOSITORY_MAP_CAUSES = [
  "named",
  "event_repository",
  "attached",
  "related",
  "offered_by_question",
  "chosen_by_workflow",
  "work_scope_entry",
  "catalog",
] as const;
export type RepositoryMapCause = (typeof REPOSITORY_MAP_CAUSES)[number];

/** Whether the map gave a repository its full entry or one line. */
export type RepositoryMapRendering = "full" | "line";

/** Whose words the description is. */
export type RepositoryMapDescriptionSource = "catalog" | "provider" | "none";

/** One relationship as the catalog holds it, from the owner's side. */
export interface RepositoryMapRelationship {
  kind: RepositoryRelationshipKind | string;
  /** The repository at the other end. */
  targetKey: RepositoryKey;
  /** `outgoing`: this repository recorded it, and the catalog's own sentence
   *  reads forwards. `incoming`: the other end recorded it, and the sentence is
   *  the inverse one. */
  direction: "outgoing" | "incoming";
  note?: string;
}

/** One repository as this run knows it, before the map decides anything. */
export interface RepositoryMapFacts {
  key: RepositoryKey;
  /** What an operator wrote on the Repositories page. Their words win. */
  catalogDescription?: string;
  /** The provider's own listing text, used only where the operator wrote none
   *  and then labelled as the provider's, so nobody mistakes a listing blurb
   *  for a description somebody here decided on. */
  providerDescription?: string;
  relationships?: readonly RepositoryMapRelationship[];
  /** Relationships the operator recorded whose other end is no longer a
   *  catalog row, so they cannot be named. Counted and said out loud: an
   *  operator's own statement we can no longer resolve is still worth telling
   *  the agent about, and dropping it teaches the agent that the neighbourhood
   *  is smaller than it is. */
  unknownRelationshipCount?: number;
  /** Whether the catalog holds an ENABLED row for it. Undefined where this path
   *  never read the catalog, which says nothing rather than "no". */
  enabled?: boolean;
  /** Whether the provider can actually serve it (a default branch exists).
   *  Undefined where this path never listed the repositories. */
  usable?: boolean;
}

/** A repository this send already has in the workspace. */
export interface RepositoryMapAttachment {
  key: RepositoryKey;
  /** Where it is checked out, when the caller holds a trusted manifest. */
  localPath?: string;
  /** `write` only where the manifest says so. A caller with no manifest passes
   *  nothing, and every attached repository then reads as write, which is what
   *  the prompt said before a manifest existed. */
  access?: "write" | "read_only";
  /** The one line the selection recorded about why this repository is here. */
  rationale?: string;
}

/** What the run could not find out, so the map says it instead of implying a
 *  fact it does not hold. */
export type RepositoryMapSilence =
  /** This send's run predates the map, or the step that gathers it returned
   *  nothing: we do not know what the catalog holds. */
  | "not_recorded"
  /** The catalog read failed on this run. */
  | "catalog_unreadable";

/** Everything about the repositories EXCEPT the workspace, which the prompt
 *  composer alone knows (the checkout paths and the manifest's access). Split
 *  so the run hands one object down and nobody has to assemble two. */
export type RepositoryMapContext = Omit<RepositoryMapInput, "attached">;

export interface RepositoryMapInput {
  /** Every repository this run may know about. Absent (rather than empty) is a
   *  legitimate input and is what `silence` explains. */
  repositories?: readonly RepositoryMapFacts[];
  attached: readonly RepositoryMapAttachment[];
  /** Repositories whose full path the ticket's or the event's text names. */
  namedKeys?: readonly RepositoryKey[];
  /** The repository the event happened on, for a pull request or push trigger. */
  eventRepositoryKeys?: readonly RepositoryKey[];
  /** Repositories a question on this work put in front of a person. */
  offeredKeys?: readonly RepositoryKey[];
  /** The record as this send saw it. */
  entries?: readonly WorkScopeEntry[];
  /** The refusals the record already composed, keyed. A repository named here
   *  reads the record's own sentence rather than a second one written here.
   *  LIVE, not frozen at run start: the refusals a run makes in pass one are
   *  what pass two must not be invited to repeat. */
  leftOut?: readonly { repositoryKey: string; reason: string }[];
  /** The repositories this run refused for a reason that settles them
   *  (`SETTLING_REFUSAL_REASONS`). A key here can never read "you may request
   *  it", whatever the catalog says about it. */
  refusedKeys?: readonly RepositoryKey[];
  /**
   * Repositories a question ALREADY ANSWERED on this work listed, and that
   * nothing on the record has chosen since (`isUnnamedInAnswer` in
   * `@shared/contracts`, the one reading of it).
   *
   * THE DOOR IS ALREADY SHUT, SO THE MAP SAYS SO ON THE FIRST PASS. The record
   * writes nothing for a name an answer left out, so without this the map read
   * the repository off the catalog as `offered`, told the model it might
   * request it, and the run refused the request it had just invited. That cost
   * a corrective pass on every planning run over such a subject, and the model
   * was doing exactly what the prompt asked.
   */
  unnamedInAnswerKeys?: readonly RepositoryKey[];
  /**
   * Whether THIS SEND can actually attach a repository.
   *
   * Only the research pass has a channel for it, and only while the expansion
   * is open. Implementation, review, the fix agent and the generic agent have
   * none, so telling them "you may request it" invites an output nothing reads
   * and a pass spent asking. Absent reads as closed, which is the safe way
   * round: a send that cannot request is told it cannot.
   */
  expansionOpen?: boolean;
  /** Whether the catalog decides access at all. On the bridge it does not, so
   *  nothing is reported as "nobody enabled it". */
  catalogActivated?: boolean;
  /** What this run could not find out about the catalog as a whole. */
  silence?: RepositoryMapSilence;
  /** True when the relationship read failed. Rendering nothing would be a
   *  positive claim that these repositories are unrelated, which is the one
   *  thing the map must never say by accident. */
  relationshipsUnreadable?: boolean;
}

/** One repository as the map describes it. The field names are
 *  `AgentBriefingRepository`'s on purpose: a recorder takes this as data. */
export interface RepositoryMapEntry {
  key: RepositoryKey;
  description: { source: RepositoryMapDescriptionSource; text: string };
  /** The map never renders catalog rules: they are a prompt section of their
   *  own, and a 20,000 character document repeated per repository is how a
   *  prompt loses everything after it. Always null, and kept so the briefing's
   *  repository shape is filled from one place. */
  rules: string | null;
  relationships: Array<{
    kind: string;
    target: RepositoryKey;
    /** Relative to THIS repository: `outgoing` means it recorded the
     *  relationship, `incoming` means the other end did. The sentence reads the
     *  other way round for an incoming one, and reading it forwards says the
     *  opposite of what the operator recorded. */
    direction: "outgoing" | "incoming";
    note?: string;
  }>;
  /** Every relationship the catalog holds for it, including ones not rendered
   *  and the ones whose other end we can no longer name. */
  relationshipCount: number;
  /** How many of `relationshipCount` point at a repository that is no longer a
   *  catalog row. */
  unknownRelationshipCount: number;
  state: RepositoryMapState;
  /** Present for every state outside `USABLE_REPOSITORY_MAP_STATES`. */
  reason?: string;
  inclusion: {
    cause: RepositoryMapCause;
    via?: { key: RepositoryKey; relationship: string; direction: "outgoing" | "incoming" };
  };
  rendering: RepositoryMapRendering;
  /** The record's entry, where there is one, so a briefing can show who decided
   *  and when without a second read. */
  workScopeEntry: WorkScopeEntry | null;
  /** Where the repository is checked out, what may be done to it, and the one
   *  line the selection recorded about why it is here. */
  workspace?: { localPath?: string; access: "write" | "read_only"; rationale?: string };
}

export interface RepositoryMap {
  /** The prompt text, as named parts. Our own rules are `platform`. */
  parts: EffectivePromptPart[];
  /** The same bytes, joined. */
  text: string;
  /** The repositories the map described, in the order it described them. */
  repositories: RepositoryMapEntry[];
  /** Catalog repositories the map summarized as a count instead of listing. */
  unlistedCount: number;
  /** Their keys, so a briefing can say which ones they were. */
  unlistedKeys: RepositoryKey[];
  /** What the map could not say, in the same words the prompt used, for the
   *  structured record: a reader that sees no relationships must be able to
   *  tell "none recorded" from "we could not read them". */
  notes: string[];
}

/** The whole map, so it can never crowd out the rules that follow it. 16,000 of
 *  the 200,000 characters a section may hold: a large map is still under a
 *  tenth of the budget, and what it gives up first is the tail of the catalog,
 *  which becomes a count and an invitation to ask by name rather than a fact
 *  that is lost. */
const MAP_TEXT_MAX_LENGTH = 16_000;
/** Full entries, however large the neighbourhood is. One repository may be
 *  wired to the whole catalog, and 150 full entries would be the map alone
 *  eating the prompt. Past this the neighbours fall to one-line entries and
 *  then to the count, and the map says how many. */
const MAP_FULL_ENTRIES_MAX = 24;
/** Per repository. An operator may type 20,000 characters; the map is an index,
 *  and the whole description reaches the agent in the repository rules section
 *  of the same prompt. */
const MAP_DESCRIPTION_MAX_LENGTH = 240;
/** Per repository, on a full entry. A hub repository can carry dozens. */
const MAP_RELATIONSHIPS_PER_ENTRY = 8;
/** A reason is a sentence somebody reads; anything longer is a document. */
const MAP_REASON_MAX_LENGTH = 400;
/** The Decision Trail's own bound on a `map_shown` text
 *  (`WORK_SCOPE_MAP_TEXT_MAX_LENGTH`). The trail line is a SUMMARY of the same
 *  build, never a second map. */
const MAP_TRAIL_TEXT_MAX_LENGTH = 1600;

const RELATIONSHIP_VOCABULARY = new Map(
  REPOSITORY_RELATIONSHIP_KINDS.map((entry) => [entry.kind, entry] as const),
);

const RELATIONSHIPS_UNREADABLE_NOTE =
  "The repository relationships could not be read for this run, so no repository below lists any. Do not read that as these repositories being unrelated.";
const CATALOG_UNREADABLE_NOTE =
  "The repository catalog could not be read for this run, so this map describes the workspace and nothing else.";
const MAP_NOT_RECORDED_NOTE =
  "The repository map was not available for this send, so this prompt describes the workspace and nothing else.";

/**
 * The repositories one hop from `seedKeys` along the catalog's relationships.
 *
 * ONE HOP, because a relationship is a claim about a pair and nothing more: a
 * frontend's backend is the ticket's business, that backend's deployer is not,
 * and two hops through a hub repository reaches half the catalog. The pull
 * request trigger's `event_repository_and_related` candidate set reads exactly
 * this, so what the map calls related and what that policy may take without
 * asking are the same set.
 *
 * Undirected: a relationship makes both ends neighbours whichever side of it the
 * operator happened to record.
 */
export function relatedRepositoryKeys(
  repositories: readonly RepositoryMapFacts[],
  seedKeys: readonly RepositoryKey[],
): RepositoryKey[] {
  const seeds = new Set(seedKeys);
  const found = new Set<RepositoryKey>();
  for (const repository of repositories) {
    for (const relationship of repository.relationships ?? []) {
      if (seeds.has(repository.key) && !seeds.has(relationship.targetKey)) {
        found.add(relationship.targetKey);
      }
      if (seeds.has(relationship.targetKey) && !seeds.has(repository.key)) {
        found.add(repository.key);
      }
    }
  }
  return [...found].sort(compareKeys);
}

/**
 * Which repository of the neighbourhood reaches each other one, and through
 * which relationship: the sentence a person reads in the Decision Trail when a
 * run takes a neighbour, and the `via` a briefing records.
 *
 * Exported because the code that DECIDES to take a neighbour and the map that
 * DESCRIBES why it is there must name the same source repository and the same
 * relationship, or the trail and the prompt tell a person two stories.
 */
export function relationshipsIntoNeighbourhood(
  repositories: readonly RepositoryMapFacts[],
  seedKeys: readonly RepositoryKey[],
): Map<RepositoryKey, RepositoryMapVia> {
  const seeds = new Set(seedKeys);
  const via = new Map<RepositoryKey, RepositoryMapVia>();
  const consider = (target: RepositoryKey, found: RepositoryMapVia) => {
    if (seeds.has(target)) return;
    const held = via.get(target);
    // The first seed in key order wins, so the sentence is the same on every run.
    if (
      held &&
      (compareKeys(held.key, found.key) < 0 ||
        (held.key === found.key && compareKeys(held.relationship, found.relationship) <= 0))
    ) {
      return;
    }
    via.set(target, found);
  };
  const ordered = [...repositories].sort((left, right) => compareKeys(left.key, right.key));
  for (const repository of ordered) {
    const relationships = [...(repository.relationships ?? [])].sort(compareRelationships);
    for (const relationship of relationships) {
      // `direction` is recorded relative to the repository the edge hangs on,
      // so reaching the same edge from the other end flips it. Rendering it
      // unflipped says the opposite of what the operator recorded: "the API
      // holds tests for the e2e suite" where the e2e suite tests the API.
      if (seeds.has(repository.key)) {
        consider(relationship.targetKey, {
          key: repository.key,
          relationship: relationship.kind,
          direction: relationship.direction,
        });
      }
      if (seeds.has(relationship.targetKey)) {
        consider(repository.key, {
          key: relationship.targetKey,
          relationship: relationship.kind,
          direction: relationship.direction === "outgoing" ? "incoming" : "outgoing",
        });
      }
    }
  }
  return via;
}

/** Which repository of the neighbourhood reaches this one, through which
 *  relationship, and from which side of it. */
export interface RepositoryMapVia {
  key: RepositoryKey;
  relationship: string;
  direction: "outgoing" | "incoming";
}

/**
 * The map, as text for the model and as entries for the record of what it read.
 *
 * Pure: no clock, no database, no network. Everything it says comes from the
 * inputs, which is what lets a briefing store the same facts from the same
 * call, in one pass.
 */
export function buildRepositoryMap(
  input: RepositoryMapInput,
  options?: {
    /**
     * The room the REST of the caller's prompt leaves for this map.
     *
     * The composer knows what else it is sending and the map does not, so the
     * one number the map cannot work out for itself is passed in. Absent means
     * "as much as the map allows itself", which is what a unit test wants and
     * what a small prompt gets anyway.
     */
    maxLength?: number;
  },
): RepositoryMap {
  const catalogKnown = input.repositories !== undefined;
  const expansionOpen = input.expansionOpen === true;
  const catalogUnreadable = input.silence === "catalog_unreadable";
  const refused = new Set(input.refusedKeys ?? []);
  const unnamed = new Set(input.unnamedInAnswerKeys ?? []);
  const facts = new Map<RepositoryKey, RepositoryMapFacts>();
  for (const repository of input.repositories ?? []) {
    if (!facts.has(repository.key)) facts.set(repository.key, repository);
  }
  const attached = new Map<RepositoryKey, RepositoryMapAttachment>();
  for (const attachment of input.attached) {
    if (!attached.has(attachment.key)) attached.set(attachment.key, attachment);
  }
  const entries = new Map<RepositoryKey, WorkScopeEntry>();
  for (const entry of input.entries ?? []) {
    if (!entries.has(entry.repositoryKey)) entries.set(entry.repositoryKey, entry);
  }
  const leftOut = new Map<string, string>();
  for (const refusal of input.leftOut ?? []) {
    if (!leftOut.has(refusal.repositoryKey)) leftOut.set(refusal.repositoryKey, refusal.reason);
  }
  const named = new Set(input.namedKeys ?? []);
  const eventRepositories = new Set(input.eventRepositoryKeys ?? []);
  const offered = new Set(input.offeredKeys ?? []);

  // The neighbourhood: what the work names or holds, and what one relationship
  // away from that. Computed before the states, because being in it is what
  // earns a full entry.
  const seeds = new Set<RepositoryKey>([...attached.keys(), ...named, ...eventRepositories]);
  const via = relationshipsIntoNeighbourhood([...facts.values()], [...seeds]);

  // Every key anything knows about, so a repository the record names but the
  // catalog no longer holds is still described rather than silently dropped.
  const keys = [
    ...new Set<RepositoryKey>([
      ...facts.keys(),
      ...attached.keys(),
      ...entries.keys(),
      ...named,
      ...eventRepositories,
      ...offered,
      ...refused,
      ...via.keys(),
    ]),
  ].sort(compareKeys);

  const describe = (key: RepositoryKey): RepositoryMapEntry => {
    const repository = facts.get(key);
    const entry = entries.get(key) ?? null;
    const attachment = attached.get(key);
    const relationships = oneEdgeOnce([...(repository?.relationships ?? [])].sort(compareRelationships));
    const state = stateOf({
      attachment,
      entry,
      repository,
      catalogKnown,
      catalogActivated: input.catalogActivated === true,
      refused: refused.has(key) || unnamed.has(key),
    });
    const described: RepositoryMapEntry = {
      key,
      description: descriptionOf(repository),
      rules: null,
      relationships: relationships.slice(0, MAP_RELATIONSHIPS_PER_ENTRY).map(renderedRelationship),
      relationshipCount: relationships.length + (repository?.unknownRelationshipCount ?? 0),
      unknownRelationshipCount: repository?.unknownRelationshipCount ?? 0,
      state,
      inclusion: causeOf({ key, entry, attachment, named, eventRepositories, offered, via }),
      // Replaced below, once the budget has decided who gets a full entry.
      rendering: "line",
      workScopeEntry: entry,
    };
    const reason = reasonOf(state, { key, entry, leftOut, repository, unnamed: unnamed.has(key) });
    if (reason !== null) described.reason = reason;
    if (attachment) {
      described.workspace = {
        ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
        access: attachment.access ?? "write",
        ...(attachment.rationale ? { rationale: attachment.rationale } : {}),
      };
    }
    return described;
  };
  const described = keys.map(describe);

  const byKey = new Map(described.map((entry) => [entry.key, entry] as const));
  const grouped: Record<MapGroup, RepositoryMapEntry[]> = {
    workspace: [],
    related: [],
    settled: [],
    rest: [],
  };
  for (const entry of described) {
    grouped[groupOf(entry, attached, seeds, via)].push(entry);
  }
  // Ranked inside each group by key alone, so the order is total and two runs
  // on the same record render the same bytes.
  for (const group of Object.values(grouped)) group.sort(compareEntries);

  // WHAT THIS MAP COULD NOT SAY GOES FIRST, not last. A sentence saying the
  // relationships could not be read is useless under a list a model has
  // already read as complete, and the note about a failed catalog read has to
  // reach it before the descriptions it qualifies.
  const notes = [
    ...(input.silence === "not_recorded" ? [MAP_NOT_RECORDED_NOTE] : []),
    ...(catalogUnreadable ? [CATALOG_UNREADABLE_NOTE] : []),
    ...(input.relationshipsUnreadable === true ? [RELATIONSHIPS_UNREADABLE_NOTE] : []),
  ];

  // THE BUDGET. Two numbers bound this map: its own ceiling, and whatever the
  // caller's prompt leaves. The smaller wins, because a map that respects only
  // its own ceiling still deletes the rules at the end of a 191,000 character
  // ticket, and nothing turns red when it does.
  const budget = Math.min(options?.maxLength ?? MAP_TEXT_MAX_LENGTH, MAP_TEXT_MAX_LENGTH);
  const rules = groupRules(expansionOpen);
  const renderContext: RenderContext = { expansionOpen, catalogUnreadable, unnamed };
  // The frame is paid for before any entry is, and measured rather than
  // guessed: the section heading, every group heading, every rule, the notes
  // themselves and room for the two closing sentences. Charging entries alone
  // let a map of full entries overrun the bound by the whole frame, which is
  // exactly the "bounded by hope" this is meant not to be.
  const frame =
    MAP_SECTION_HEADING.length +
    sumLengths(Object.values(GROUP_HEADINGS)) +
    sumLengths(Object.values(rules)) +
    sumLengths(notes) +
    notes.length +
    MAP_CLOSING_RESERVE;
  const shown: Record<MapGroup, RepositoryMapEntry[]> = {
    workspace: [],
    related: [],
    settled: [],
    rest: [],
  };
  const hidden: RepositoryMapEntry[] = [];
  const hiddenSettled: RepositoryMapEntry[] = [];
  let remaining = budget - frame;
  {
    let fullEntriesLeft = MAP_FULL_ENTRIES_MAX;
    // The neighbourhood keeps a floor of its own. It is the point of this map,
    // and without a floor a ticket carrying ninety exclusions spends the whole
    // budget saying "do not request it" and never gets to the backend the
    // agent actually needs. Never more than the neighbourhood would spend, so
    // a run with no neighbours does not hold money back for nobody.
    const relatedCost = sumLengths(
      grouped.related.map((entry) => renderEntry(entry, "full", byKey, renderContext)),
    );
    const relatedFloor = Math.min(MAP_RELATED_FLOOR, relatedCost);
    const spend = (
      name: MapGroup,
      rendering: (entry: RepositoryMapEntry) => RepositoryMapRendering,
      ceiling: number,
      overflow: RepositoryMapEntry[],
      /** A group the budget may not refuse. Only the workspace is one. */
      required = false,
    ) => {
      for (const entry of grouped[name]) {
        const how = rendering(entry);
        const text = renderEntry(entry, how, byKey, renderContext);
        if (!required && text.length > Math.min(remaining, ceiling)) {
          overflow.push(entry);
          continue;
        }
        remaining -= text.length;
        ceiling -= text.length;
        if (how === "full") fullEntriesLeft -= 1;
        entry.rendering = how;
        shown[name].push(entry);
      }
    };
    // THE WORKSPACE IS NOT NEGOTIABLE, whatever the budget says. A model
    // standing in a checkout it was not told about is the one failure no later
    // sentence can repair, and this list is what the prompt carried before
    // this map existed: a ticket large enough to fill the section on its own
    // must not take it away, or the map is a regression on exactly the runs
    // that need it most. It falls to one line each when there is no room, and
    // the groups below are then skipped.
    spend(
      "workspace",
      () => (fullEntriesLeft > 0 && remaining > 0 ? "full" : "line"),
      Number.POSITIVE_INFINITY,
      hidden,
      true,
    );
    if (remaining > 0) {
      // A SETTLED REPOSITORY IS A LINE, AND IT IS NEVER DROPPED IN SILENCE.
      // One line each, so ninety of them cost what ninety lines cost rather
      // than ninety full entries; and what does not fit leaves through its OWN
      // closing sentence, because the catalog's ("ask for one by its exact
      // provider:path") is an invitation, and extending that invitation to a
      // repository a person excluded is how the run pays a pass to be told no.
      spend("settled", () => "line", remaining - relatedFloor, hiddenSettled);
      // The neighbourhood, in full while there are full entries to give. A
      // related repository with no "why it is here" and no relationship
      // sentence is a bare key, which is what the agent had before this map
      // existed.
      spend("related", () => (fullEntriesLeft > 0 ? "full" : "line"), remaining, hidden);
      spend("rest", () => "line", remaining, hidden);
    }
  }

  const parts = renderParts({
    shown,
    byKey,
    rules,
    renderContext,
    unlistedCount: hidden.length,
    unlistedSettledCount: hiddenSettled.length,
    notes,
    // Everything the map knows of, so a map that cannot afford even its frame
    // still tells the agent how many repositories it is not seeing.
    totalCount: described.length,
    budget,
  });
  const listed = [...shown.workspace, ...shown.related, ...shown.settled, ...shown.rest];
  return {
    parts,
    text: joinPromptParts(parts),
    repositories: listed,
    unlistedCount: hidden.length + hiddenSettled.length,
    unlistedKeys: [...hidden, ...hiddenSettled].map((entry) => entry.key).sort(compareKeys),
    notes,
  };
}

function sumLengths(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + text.length, 0);
}

/**
 * The Decision Trail's line about the map: the same build, summarized.
 *
 * A SUMMARY AND A RECORD, NOT TWO MAPS. The trail's `map_shown` text is bounded
 * at 1600 characters by the contract, far below what a map costs, so the trail
 * cannot carry the map and must not try: it carries the keys and the state each
 * one was shown in, derived from the entries the prompt was built from, so a
 * person reading the trail and a person reading the briefing can never be shown
 * two different maps of one send.
 */
export function repositoryMapTrailSummary(map: RepositoryMap): {
  text: string;
  repositoryKeys: RepositoryKey[];
} {
  const shown: RepositoryKey[] = [];
  const lines: string[] = [];
  let used = 0;
  for (const entry of map.repositories) {
    const line = `${entry.key}: ${entry.state}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > MAP_TRAIL_TEXT_MAX_LENGTH - TRAIL_TAIL_RESERVE) break;
    lines.push(line);
    used += cost;
    shown.push(entry.key);
  }
  const left = map.repositories.length - lines.length + map.unlistedCount;
  if (left > 0) lines.push(`and ${left} more`);
  return { text: lines.join("\n").slice(0, MAP_TRAIL_TEXT_MAX_LENGTH), repositoryKeys: shown };
}

/** Room for the "and N more" line, whatever N turns out to be. */
const TRAIL_TAIL_RESERVE = 24;

/** Room for the two closing lines: the catalog's "N further repositories" and
 *  the settled group's "N more were already decided". Measured against the
 *  longest either can be, which is the wording plus a count. */
const MAP_CLOSING_RESERVE = 320;

/** The section's own heading, charged to the frame like everything else. */
const MAP_SECTION_HEADING = "\n## Repositories\n\n";

/** What the settled group may not spend, so the neighbourhood always fits.
 *  Enough for a handful of full entries, which is what "an obvious backend"
 *  looks like; a run with a smaller neighbourhood reserves only what that
 *  neighbourhood costs. */
const MAP_RELATED_FLOOR = 4_000;

type MapGroup = "workspace" | "related" | "settled" | "rest";

function groupOf(
  entry: RepositoryMapEntry,
  attached: Map<RepositoryKey, RepositoryMapAttachment>,
  seeds: Set<RepositoryKey>,
  via: Map<RepositoryKey, unknown>,
): MapGroup {
  if (attached.has(entry.key)) return "workspace";
  if (!isUsableState(entry.state)) return "settled";
  if (seeds.has(entry.key) || via.has(entry.key) || entry.workScopeEntry !== null) return "related";
  return "rest";
}

const PLATFORM: EffectivePromptPartOrigin = { kind: "platform" };
const CATALOG: EffectivePromptPartOrigin = { kind: "repository_catalog" };

const GROUP_HEADINGS: Record<MapGroup, string> = {
  workspace: "### In the workspace\n\n",
  related: "### Related to this work, not in the workspace\n\n",
  settled: "### Already decided, do not request these\n\n",
  rest: "### Also in the catalog\n\n",
};

/**
 * Our own rules about the map, said once, where the model reads the map. Each
 * is a rule rather than a fact, which is why they are `platform` parts.
 *
 * THE NEIGHBOURHOOD'S RULE DEPENDS ON THE SEND. Only the research pass can
 * attach a repository, and only while the expansion is open; implementation,
 * review, the fix agent and the generic agent have no channel for it at all.
 * "You may request it", told to a send that cannot, buys an output field
 * nothing reads and a pass spent writing it.
 */
function groupRules(expansionOpen: boolean): Record<MapGroup, string> {
  return {
    workspace:
      "Only a repository marked (write) may be changed. A repository marked (read only) is context: read it, never change it.\n\n",
    related: expansionOpen
      ? "These are not checked out. Search the workspace first, and request one of these only when you can name the logic you could not find.\n\n"
      : "These are not checked out, and this phase cannot attach them. They are here so you know what the workspace sits next to: do not request one, and do not treat its code as readable. Where the work truly needs one, say which and why in your output.\n\n",
    settled:
      "Each of these was already decided for this work, and the reason is on its line. Do not request one: the request is refused, the run pays a pass for it, and nothing changes.\n\n",
    rest: expansionOpen
      ? "One line each. Ask for one by its exact provider:path when you can name what you need from it.\n\n"
      : "One line each, so you know they exist. This phase cannot attach any of them.\n\n",
  };
}

function renderParts(input: {
  shown: Record<MapGroup, RepositoryMapEntry[]>;
  byKey: Map<RepositoryKey, RepositoryMapEntry>;
  rules: Record<MapGroup, string>;
  renderContext: RenderContext;
  unlistedCount: number;
  unlistedSettledCount: number;
  notes: string[];
  totalCount: number;
  budget: number;
}): EffectivePromptPart[] {
  const groups = (["workspace", "related", "settled", "rest"] as const).flatMap(
    (name): Array<readonly EffectivePromptPart[]> => {
      const entries = input.shown[name];
      if (entries.length === 0) return [];
      return [
        [
          part(`repository-map-${name}`, groupTitle(name), CATALOG, GROUP_HEADINGS[name]),
          part(
            `repository-map-${name}-rule`,
            `${groupTitle(name)}: the rule`,
            PLATFORM,
            input.rules[name],
          ),
          ...entries.map((entry, index) =>
            part(
              `repository-map-${name}:${index + 1}`,
              `Repository ${entry.key}`,
              { kind: "repository_catalog", ref: entry.key },
              renderEntry(entry, entry.rendering, input.byKey, input.renderContext),
            ),
          ),
        ],
      ];
    },
  );
  const tail = [
    ...(input.unlistedCount > 0
      ? [
          part(
            "repository-map-unlisted",
            "Repositories not listed",
            CATALOG,
            `${input.unlistedCount} further ${input.unlistedCount === 1 ? "repository is" : "repositories are"} in the catalog and not listed here. Ask for one by its exact provider:path.\n`,
          ),
        ]
      : []),
    // A SEPARATE SENTENCE, BECAUSE THE OTHER ONE IS AN INVITATION. A settled
    // repository that fell off the end used to be counted in with the catalog
    // and advertised as requestable, so the run paid a pass to be told no
    // about the very repository a person had excluded.
    ...(input.unlistedSettledCount > 0
      ? [
          part(
            "repository-map-unlisted-settled",
            "Repositories already decided and not listed",
            PLATFORM,
            `${input.unlistedSettledCount} further ${input.unlistedSettledCount === 1 ? "repository was" : "repositories were"} already decided for this work and did not fit here. They were left out, refused or are unavailable: do not request them.\n`,
          ),
        ]
      : []),
  ];
  const noteParts = input.notes.map((note, index) =>
    part(`repository-map-note:${index + 1}`, "What this map could not say", CATALOG, `${note}\n`),
  );
  if (groups.length === 0 && tail.length === 0) {
    // NOT NOTHING. A prompt so large that the map cannot afford even its frame
    // is exactly the prompt where somebody later asks why the agent never
    // looked at their repository, so the count survives when the list cannot.
    if (noteParts.length > 0) {
      const minimal = concatPromptParts([
        part("repository-map", "Repository map", CATALOG, MAP_SECTION_HEADING),
        noteParts,
        "\n",
      ]);
      return joinPromptParts(minimal).length <= input.budget ? minimal : [];
    }
    if (input.totalCount === 0) return [];
    const counted = concatPromptParts([
      part("repository-map", "Repository map", CATALOG, MAP_SECTION_HEADING),
      part(
        "repository-map-unlisted",
        "Repositories not listed",
        CATALOG,
        `${input.totalCount} ${input.totalCount === 1 ? "repository is" : "repositories are"} in scope for this work, and this prompt had no room to describe them. Ask for one by its exact provider:path.\n`,
      ),
      "\n",
    ]);
    return joinPromptParts(counted).length <= input.budget ? counted : [];
  }
  return concatPromptParts([
    part("repository-map", "Repository map", CATALOG, MAP_SECTION_HEADING),
    ...(noteParts.length > 0 ? [noteParts, "\n"] : []),
    ...groups.flatMap((group, index) => (index === 0 ? [group] : ["\n", group])),
    ...(tail.length > 0 ? ["\n", tail] : []),
    "\n",
  ]);
}

function groupTitle(name: MapGroup): string {
  switch (name) {
    case "workspace":
      return "Repositories in the workspace";
    case "related":
      return "Related repositories";
    case "settled":
      return "Repositories already decided";
    case "rest":
      return "The rest of the catalog";
  }
}

/**
 * One repository's lines.
 *
 * A full entry says where it is and what may be done to it, why it is here, what
 * it is in the operator's words, and how it relates to the rest. A line entry
 * says the key, the state where it is not the group's own, and the first clause
 * of the description: enough for a model to decide whether to ask for it by
 * name, and enough for a settled repository to keep its "do not request".
 */
function renderEntry(
  entry: RepositoryMapEntry,
  rendering: RepositoryMapRendering,
  byKey: Map<RepositoryKey, RepositoryMapEntry>,
  context: RenderContext,
): string {
  if (rendering === "line") {
    const state =
      entry.workspace || entry.state === "offered"
        ? ""
        : ` - ${statePhrase(entry.state, context.expansionOpen, context.unnamed.has(entry.key))}`;
    const reason = !isUsableState(entry.state) && entry.reason ? `: ${entry.reason}` : "";
    const summary = entry.description.text.length > 0 ? ` - ${entry.description.text}` : "";
    return `- \`${entry.key}\`${state}${reason}${summary}\n`;
  }
  const lines: string[] = [`- \`${entry.key}\`${headline(entry, context)}`];
  const why = causeSentence(entry);
  if (why) lines.push(`  Why it is here: ${why}`);
  if (entry.description.text.length > 0) {
    lines.push(
      `  What it is: ${entry.description.text}${descriptionCredit(entry.description.source, context)}`,
    );
  }
  if (entry.relationships.length > 0) {
    lines.push(
      `  How it relates: ${entry.relationships
        .map((relationship) => relationshipClause(relationship, byKey))
        .join(" ")}`,
    );
  }
  const rest =
    entry.relationshipCount - entry.relationships.length - entry.unknownRelationshipCount;
  if (rest > 0) {
    lines.push(
      `  ${rest} further ${rest === 1 ? "relationship is" : "relationships are"} recorded and not shown here.`,
    );
  }
  if (entry.unknownRelationshipCount > 0) {
    lines.push(
      `  ${entry.unknownRelationshipCount} recorded ${entry.unknownRelationshipCount === 1 ? "relationship points" : "relationships point"} at a repository that is no longer in the catalog, so we cannot name ${entry.unknownRelationshipCount === 1 ? "it" : "them"}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** What the wording of one entry depends on besides the entry itself. */
interface RenderContext {
  expansionOpen: boolean;
  catalogUnreadable: boolean;
  /** Repositories shut by an answer rather than by a request this run made.
   *  Both are `refused`, and the clause that stops the request differs: one
   *  says the run already said no, the other that a person's answer did. */
  unnamed: ReadonlySet<RepositoryKey>;
}

/** What follows the key on a full entry: where it is, and what may be done. */
function headline(entry: RepositoryMapEntry, context: RenderContext): string {
  if (entry.workspace) {
    const where = entry.workspace.localPath ? ` at \`${entry.workspace.localPath}\`` : "";
    return `${where} (${entry.workspace.access === "read_only" ? "read only" : "write"})`;
  }
  return ` - ${statePhrase(entry.state, context.expansionOpen, context.unnamed.has(entry.key))}${entry.reason ? `: ${entry.reason}` : ""}`;
}

/**
 * How each state reads to a model.
 *
 * "Do not request it" is said in as many words on every settled state, because
 * a model told only that something is unavailable asks about it again, and the
 * run pays a pass for every one of those. `offered` is the one state that
 * reads differently per send: it is the only one that invites an action, and
 * three of the four sends that see this map have no way to take it.
 */
function statePhrase(
  state: RepositoryMapState,
  expansionOpen: boolean,
  unnamed: boolean,
): string {
  if (state === "offered") {
    return expansionOpen
      ? "not in the workspace; you may request it"
      : "not in the workspace, and this phase cannot attach it";
  }
  // Both are `refused`, and saying "this run already refused a request for it"
  // before any request was made would be false on the pass that matters most.
  if (state === "refused" && unnamed) return UNNAMED_STATE_PHRASE;
  return SETTLED_STATE_PHRASES[state];
}

/**
 * A question on this work has been answered, this repository is not selected on
 * it, and a request would be refused.
 *
 * "NOT SELECTED", never "the answer did not name it". The same fact is true of
 * a repository somebody DID name and whose entry a person later removed, and
 * there that clause would be false; the canonical sentence beside it takes the
 * same care (`workScopeUnnamedWhy`).
 *
 * It claims nothing about permanence either. An answer is not an exclusion, and
 * the way back belongs in the person's channel and never in the prompt the
 * system signs (rule 7 and D4 of
 * `docs/product/repository-record-behaviour.md`), so this stops the request
 * without closing the door in words.
 */
const UNNAMED_STATE_PHRASE = "not selected on this work, do not request it";

const SETTLED_STATE_PHRASES: Record<Exclude<RepositoryMapState, "offered">, string> = {
  write: "in the workspace, may be changed",
  read_only: "in the workspace, read only",
  excluded: "a person left it out of this work, do not request it",
  disabled: "switched off in the repository catalog, do not request it",
  not_enabled: "nobody has enabled it, do not request it",
  unusable: "enabled here, but the provider offers nothing to check out, do not request it",
  outside_catalog: "outside the catalog this run may use, do not request it",
  refused: "this run already refused a request for it, do not request it again",
};

function descriptionCredit(
  source: RepositoryMapDescriptionSource,
  context: RenderContext,
): string {
  // WHOSE WORDS THEY ARE, ON THE LINE ITSELF. An operator who wrote a
  // description must be able to find their own sentence in a briefing, and the
  // provider's listing blurb must never be mistaken for a decision made here.
  //
  // "Nobody here wrote a description" IS A CLAIM ABOUT THE CATALOG, and a run
  // that could not read the catalog has no business making it: the operator
  // who wrote three paragraphs on the Repositories page would read it as their
  // work having vanished. On that run the credit says what actually happened.
  switch (source) {
    case "catalog":
      return "";
    case "provider":
      return context.catalogUnreadable
        ? " (the provider's own listing text; the catalog could not be read on this run, so we cannot tell whether somebody wrote a description here)"
        : " (the provider's own listing text; nobody here wrote a description)";
    case "none":
      return "";
  }
}

function causeSentence(entry: RepositoryMapEntry): string | null {
  // THE SELECTION'S OWN SENTENCE WINS FOR A REPOSITORY IT PUT IN THE WORKSPACE.
  // It is the line the prompt carried before the map existed, it is written for
  // this repository on this run, and it is more specific than any cause the map
  // can derive. The derived cause stays in the structured entry either way.
  if (entry.workspace?.rationale) return entry.workspace.rationale;
  const via = entry.inclusion.via;
  switch (entry.inclusion.cause) {
    case "named":
      return "the ticket names it.";
    case "event_repository":
      return "the event that started this run happened on it.";
    case "attached":
      return "it was attached to this work.";
    case "related":
      return via
        ? `\`${via.key}\` ${relationshipSentence(via.relationship, via.direction, entry.key)}`
        : "a relationship from a repository of this work reaches it.";
    case "offered_by_question":
      return "a question about this work named it.";
    case "chosen_by_workflow":
      return "somebody asked the workflow to choose, and it chose this one.";
    case "work_scope_entry":
      // IN PROSE, NOT AS A SLUG. "(person)" at the end of a sentence is our
      // database vocabulary leaking into the one line a model and a person
      // both read; and an origin a future migration adds falls back to the
      // plain sentence instead of printing a word nobody outside the schema
      // has seen.
      return entry.workScopeEntry
        ? (ORIGIN_SENTENCES[entry.workScopeEntry.origin] ?? RECORD_ENTRY_SENTENCE)
        : RECORD_ENTRY_SENTENCE;
    case "catalog":
      return null;
  }
}

/** How the record's own origins read in a sentence somebody says out loud. */
const RECORD_ENTRY_SENTENCE = "this work's repository record holds an entry for it.";
const ORIGIN_SENTENCES: Record<string, string> = {
  person: "a person put it on this work.",
  delegated: "somebody handed the choice to the workflow, and it chose this one.",
  workflow_owned_branch: "this work's own branch already exists in it.",
  ticket_text: "the ticket names it.",
  trigger_policy: "the trigger that started this work takes it in.",
  related_repository:
    "the repository catalog relates it to a repository this work names, so an earlier decision on this work took it in.",
  inferred: "an earlier run on this work worked out that it belongs here.",
};

function relationshipClause(
  relationship: {
    kind: string;
    target: RepositoryKey;
    direction: "outgoing" | "incoming";
    note?: string;
  },
  byKey: Map<RepositoryKey, RepositoryMapEntry>,
): string {
  // A RELATIONSHIP POINTING AT A REPOSITORY WE CANNOT SEE IS STILL THE
  // OPERATOR'S OWN STATEMENT. The catalog read drops an edge whose target row
  // is gone, and the row may also simply be outside this run's catalog; either
  // way, dropping the line teaches a model that the neighbourhood is smaller
  // than it is, so the edge is rendered and the gap is named.
  const unknown = byKey.has(relationship.target)
    ? ""
    : " (we do not know this repository on this run)";
  const note = relationship.note ? ` (${relationship.note})` : "";
  // The qualifiers belong inside the sentence, not after its full stop.
  const sentence = relationshipSentence(
    relationship.kind,
    relationship.direction,
    relationship.target,
  ).replace(/\.$/, "");
  return `It ${sentence}${unknown}${note}.`;
}

/**
 * The catalog's own sentence for a relationship, read from the side that
 * matters and with the other repository spelled in.
 *
 * DIRECTION IS NOT DECORATION. The catalog stores one edge and two sentences
 * for it, and an `incoming` edge read forwards says the opposite of what the
 * operator recorded: "the API holds tests for the e2e suite" where the e2e
 * suite holds tests for the API. A model acting on the wrong one looks in the
 * wrong repository.
 *
 * An unknown kind reads as itself rather than disappearing: the worker and the
 * dashboard deploy separately, and a kind added on one side must not blank a
 * line on the other.
 */
export function relationshipSentence(
  kind: string,
  direction: "outgoing" | "incoming",
  otherKey: string,
): string {
  const definition = RELATIONSHIP_VOCABULARY.get(kind as RepositoryRelationshipKind);
  const other = `\`${otherKey}\``;
  if (!definition) {
    return direction === "outgoing"
      ? `is recorded as \`${kind}\` of ${other}.`
      : `is recorded as the other end of \`${kind}\` from ${other}.`;
  }
  if (direction === "outgoing" || definition.symmetric) {
    return `${definition.sentence.replace("{target}", other)}.`;
  }
  // A symmetric kind's inverse sentence is written with `{target}`, which is
  // why both tokens are substituted here: one of them is always absent.
  return `${definition.inverseSentence.replace("{source}", other).replace("{target}", other)}.`;
}

function descriptionOf(
  repository: RepositoryMapFacts | undefined,
): RepositoryMapEntry["description"] {
  // THE OPERATOR'S WORDS WIN. Somebody typed a description on the Repositories
  // page for exactly this moment, and until now every agent read the provider's
  // listing blurb instead.
  const catalog = summarize(repository?.catalogDescription ?? "");
  if (catalog.length > 0) return { source: "catalog", text: catalog };
  const provider = summarize(repository?.providerDescription ?? "");
  if (provider.length > 0) return { source: "provider", text: provider };
  return { source: "none", text: "" };
}

/**
 * The operator's description as the map may carry it.
 *
 * WHOLE WHERE IT FITS. Somebody wrote it for this moment, and a paragraph of
 * two short sentences is not something to summarize. Only a description past
 * the bound is shortened, to its first sentence where that fits and otherwise
 * to a word boundary, and it always says it was shortened: a model shown half a
 * paragraph with no marker reads it as the whole thing the operator meant.
 */
function summarize(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAP_DESCRIPTION_MAX_LENGTH) return collapsed;
  const sentence = /^.*?[.!?](?=\s|$)/.exec(collapsed)?.[0] ?? collapsed;
  if (sentence.length <= MAP_DESCRIPTION_MAX_LENGTH) {
    return `${sentence} (first sentence of a longer description)`;
  }
  const head = sentence.slice(0, MAP_DESCRIPTION_MAX_LENGTH);
  const boundary = head.lastIndexOf(" ");
  return `${(boundary > 0 ? head.slice(0, boundary) : head).trimEnd()}... (shortened)`;
}

function stateOf(input: {
  attachment: RepositoryMapAttachment | undefined;
  entry: WorkScopeEntry | null;
  repository: RepositoryMapFacts | undefined;
  catalogKnown: boolean;
  catalogActivated: boolean;
  /** Refused by this run for a reason that settles it, or shut by an answer
   *  that did not name it. The LAST thing consulted: where the record or the
   *  catalog already says why a repository is closed, that sentence is the one
   *  a person can act on. */
  refused: boolean;
}): RepositoryMapState {
  // The workspace answers first: a repository that is checked out is usable
  // whatever else is true of it, and telling a model otherwise about a
  // repository it is standing in is the contradiction that makes it ask.
  if (input.attachment) {
    return input.attachment.access === "read_only" ? "read_only" : "write";
  }
  if (input.entry?.state === "excluded") return "excluded";
  if (input.entry?.state === "unavailable") {
    return input.entry.unavailableReason === "unusable" ? "unusable" : "not_enabled";
  }
  const open = input.refused ? "refused" : "offered";
  if (input.repository === undefined) {
    // Named somewhere and absent from everything this run listed. Only said
    // where the run actually read a catalog, so a run that could not read one
    // never reports a repository as missing on evidence it does not have.
    return input.catalogKnown ? "outside_catalog" : open;
  }
  // SWITCHED OFF IS ASKED BEFORE UNUSABLE. A repository nobody enabled offers
  // no default branch either, so asking the provider first told an operator
  // their provider was broken and sent them looking at a repository whose
  // switch was simply off.
  if (input.repository.enabled === false && input.catalogActivated) return "disabled";
  if (input.repository.usable === false) return "unusable";
  return open;
}

function reasonOf(
  state: RepositoryMapState,
  context: {
    key: RepositoryKey;
    entry: WorkScopeEntry | null;
    leftOut: Map<string, string>;
    repository: RepositoryMapFacts | undefined;
    /** Shut by an answer rather than by a request this run made. */
    unnamed: boolean;
  },
): string | null {
  if (isUsableState(state)) return null;
  // The record's own sentence where there is one, so a person reading the
  // briefing and a person reading the ticket comment read the same words, and
  // an exclusion still names who decided it and when.
  const recorded = context.leftOut.get(context.key);
  if (recorded) return clamp(recorded);
  switch (state) {
    case "excluded":
      return clamp(`Somebody left ${context.key} out of this work.`);
    case "disabled":
      return clamp(`${context.key} is switched off on the Repositories page.`);
    case "not_enabled":
      return clamp(`Nobody has enabled ${context.key} on the Repositories page.`);
    case "unusable":
      return clamp(
        `${context.key} is enabled here, and the provider offers nothing this run could check out for it.`,
      );
    case "outside_catalog":
      return clamp(`${context.key} is not in the catalog this run may use.`);
    case "refused":
      return clamp(
        context.unnamed
          ? `${workScopeUnnamedWhy(context.key)}.`
          : `This run already refused a request for ${context.key}.`,
      );
    default:
      return null;
  }
}

function causeOf(input: {
  key: RepositoryKey;
  entry: WorkScopeEntry | null;
  attachment: RepositoryMapAttachment | undefined;
  named: Set<RepositoryKey>;
  eventRepositories: Set<RepositoryKey>;
  offered: Set<RepositoryKey>;
  via: Map<RepositoryKey, RepositoryMapVia>;
}): RepositoryMapEntry["inclusion"] {
  // THE RECORD'S OWN ORIGIN COMES FIRST, never a guess from what else happens
  // to be in scope. The entry says how the repository got in; a cause derived
  // from the absence of another cause is how a workflow's own choice ends up
  // reported as a person's decision. Where the record says nothing, only facts
  // the caller stated explicitly decide, and `catalog` is the honest last word.
  const origin = input.entry?.origin;
  if (origin === "delegated") return { cause: "chosen_by_workflow" };
  if (origin === "ticket_text") return { cause: "named" };
  const via = input.via.get(input.key);
  // The origin says it outright, so the cause holds even where this run can no
  // longer name the relationship that brought it in.
  if (origin === "related_repository") return via ? { cause: "related", via } : { cause: "related" };
  if (origin === "trigger_policy" && via) return { cause: "related", via };
  if (input.named.has(input.key)) return { cause: "named" };
  if (input.eventRepositories.has(input.key)) return { cause: "event_repository" };
  if (input.offered.has(input.key)) return { cause: "offered_by_question" };
  if (origin !== undefined) return { cause: "work_scope_entry" };
  if (via) return { cause: "related", via };
  if (input.attachment) return { cause: "attached" };
  return { cause: "catalog" };
}

/** One relationship as the map carries it: the catalog's own fields, and the
 *  note only where the operator wrote one. */
/**
 * One edge, listed once, from this repository's point of view.
 *
 * The catalog stores a relationship on the row whose operator recorded it, and
 * the map reader returns every edge TOUCHING a repository: the ones it wrote
 * down as `outgoing`, and the ones its neighbours wrote down about it as
 * `incoming`. That is what lets an agent standing in a repository nobody ever
 * described read the edges its neighbours recorded.
 *
 * TWO OPERATORS CAN RECORD THE SAME FACT. Each writes it on their own page, so
 * the catalog holds two rows, and this repository then sees the pair as its own
 * `outgoing` edge and its neighbour's `incoming` one. For a symmetric kind the
 * two render the SAME sentence, so the prompt said "It is related to `x`. It is
 * related to `x`." and `relationshipCount` said two edges where there is one
 * fact. A kind with a side keeps both, because "A is the backend for B" and "B
 * is the backend for A" are two different claims and an agent that sees only
 * one of them cannot tell that the catalog contradicts itself.
 *
 * The survivor of a symmetric pair is the `outgoing` one: this repository's own
 * operator did record it, and saying so is true and more useful than crediting
 * the other end.
 */
function oneEdgeOnce(
  relationships: readonly RepositoryMapRelationship[],
): RepositoryMapRelationship[] {
  const kept = new Map<string, RepositoryMapRelationship>();
  for (const relationship of relationships) {
    const symmetric = RELATIONSHIP_VOCABULARY.get(
      relationship.kind as RepositoryRelationshipKind,
    )?.symmetric;
    const identity = symmetric
      ? `${relationship.kind}|${relationship.targetKey}`
      : `${relationship.kind}|${relationship.targetKey}|${relationship.direction}`;
    const held = kept.get(identity);
    if (held && (held.direction === "outgoing" || relationship.direction !== "outgoing")) continue;
    kept.set(identity, relationship);
  }
  return [...kept.values()];
}

function renderedRelationship(
  relationship: RepositoryMapRelationship,
): RepositoryMapEntry["relationships"][number] {
  return {
    kind: relationship.kind,
    target: relationship.targetKey,
    direction: relationship.direction,
    ...(relationship.note ? { note: relationship.note } : {}),
  };
}

function isUsableState(state: RepositoryMapState): boolean {
  return (USABLE_REPOSITORY_MAP_STATES as readonly string[]).includes(state);
}

function clamp(sentence: string): string {
  const collapsed = sentence.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAP_REASON_MAX_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAP_REASON_MAX_LENGTH - 3)}...`;
}

/** Inside a group the order is the one a reader can predict, the key: an attach
 *  order is not a fact the map holds, and a ranking nobody can reproduce is
 *  what makes two briefings of one record look like two records. */
function compareEntries(left: RepositoryMapEntry, right: RepositoryMapEntry): number {
  return compareKeys(left.key, right.key);
}

function compareRelationships(
  left: RepositoryMapRelationship,
  right: RepositoryMapRelationship,
): number {
  return (
    compareKeys(left.targetKey, right.targetKey) ||
    compareKeys(left.kind, right.kind) ||
    compareKeys(left.direction, right.direction)
  );
}

/** Plain code unit order, so the ranking never depends on the runtime's locale. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function part(
  id: string,
  title: string,
  origin: EffectivePromptPartOrigin,
  content: string,
): EffectivePromptPart {
  return { id, title, content, origin };
}
