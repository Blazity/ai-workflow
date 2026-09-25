/**
 * WHICH NEIGHBOURS A RUN TAKES WITHOUT ASKING, AND THE CATALOG READ BEHIND IT.
 *
 * Split out of `repo-selection.ts`, which had grown past 2,600 lines: the two
 * decisions here (what the catalog says about every repository this run may
 * describe, and which of the neighbours it takes on its own) are read together,
 * changed together and tested together, and neither one is about selecting the
 * repositories a ticket names.
 *
 * It also holds the selection helper the selection and this file share, so a
 * repository is turned into a selection in exactly one place. Its key is
 * `repositoryKey` in `engine/support/repository-access.ts`, like everywhere else.
 */
import {
  type RepositoryMetadata,
  type SelectedRepository,
} from "../../../adapters/vcs/repository-directory.js";
import type { PreSandboxRepositoryMap } from "../types.js";
import { WORKSPACE_NARROWING_CEILING } from "../types.js";
import { repositoryKey } from "../../support/repository-access.js";
import type { RunWorkScopeRecorder } from "../../work-scope/context.js";
import {
  relatedRepositoryKeys,
  relationshipsIntoNeighbourhood,
  relationshipSentence,
  type RepositoryMapFacts,
} from "../../../repository-map/map.js";

/** One repository as the selection hands it on. Access is not on this shape:
 *  it belongs to the workspace input, and `prepare-workspace` sets it from
 *  `relatedAttachments`. */
export function selectedRepository(
  repo: RepositoryMetadata,
  selectedRationale: string,
): SelectedRepository {
  return {
    provider: repo.provider,
    repoPath: repo.repoPath,
    defaultBranch: repo.defaultBranch,
    selectedRationale,
  };
}

/**
 * At most this many related repositories are taken without anybody being asked.
 *
 * A NEIGHBOURHOOD IS NOT A BUDGET. One repository may be wired to the whole
 * catalog, a workspace holds eight repositories at most
 * (`sandbox/repo-workspace.ts`), and every one of them is a clone on the
 * critical path before the agent starts. Two is the number that covers the
 * shape this exists for, a ticket naming a frontend whose backend it obviously
 * needs, without turning a hub repository into a ten-repository checkout
 * nobody asked for. The rest are in the map as repositories the agent may
 * request by name, which costs one pass instead of ten clones.
 */
const RELATED_ATTACH_MAX = 2;

const RELATED_ENTRY_RATIONALE_MAX_LENGTH = 200;

/** What one read of the catalog profiles produced, and the field the step
 *  result carries it in. */
interface RepositoryMapCatalog {
  facts: RepositoryMapFacts[];
  relationshipsUnreadable: boolean;
  catalogUnreadable: boolean;
  result: { repositoryMap: PreSandboxRepositoryMap };
}

/** One catalog row as the map reader returns it. Structural rather than
 *  imported, so this module still pulls in nothing from `db/`. */
export interface RepositoryMapCatalogRow {
  key: string;
  enabled: boolean;
  description: string;
  relationships: ReadonlyArray<{
    kind: string;
    targetKey: string;
    direction: "outgoing" | "incoming";
    note?: string | null;
  }>;
  unknownRelationshipCount: number;
}

/**
 * The catalog rows as the map reads them.
 *
 * BOTH ENDS OF EVERY EDGE ARRIVE HERE ALREADY. The catalog stores a
 * relationship once, on the row whose operator recorded it, but
 * `listRepositoryCatalogMapRows` returns it to BOTH repositories in one
 * statement: `outgoing` to the end that wrote it down and `incoming` to the
 * other one. So a repository whose operator never opened its own page still
 * gets the edges its neighbours recorded about it, and `relationshipCount`
 * counts every edge touching it rather than only the ones it owns. Nothing
 * here mirrors anything: a second copy made on this side could drift from the
 * first, and there would be two places to get the side of an edge wrong.
 *
 * Extracted from `loadRepositoryMapCatalog` so the promise above is reachable
 * from a test: the query, this mapping and `buildRepositoryMap` are the three
 * steps between an operator typing a relationship and an agent reading it, and
 * only the first and the last were observable before.
 */
export function repositoryMapFacts(input: {
  rows: readonly RepositoryMapCatalogRow[];
  /** Everything the providers offered, for the labelled fallback description
   *  and for usability. */
  listed: readonly RepositoryMetadata[];
  enabledKeys: readonly string[];
  catalogActivated: boolean;
}): RepositoryMapFacts[] {
  const byKey = new Map(input.rows.map((row) => [row.key, row] as const));
  const listedByKey = new Map(input.listed.map((repo) => [repositoryKey(repo), repo] as const));
  const enabled = new Set(input.enabledKeys);
  /** One repository as the map reads it: the operator's words where they wrote
   *  any, the provider's listing text as a labelled fallback, and only the
   *  facts this run actually observed. */
  const factsOf = (key: string): RepositoryMapFacts => {
    const row = byKey.get(key);
    const listedRepository = listedByKey.get(key);
    const described: RepositoryMapFacts = { key };
    if (row && row.description.trim().length > 0) described.catalogDescription = row.description;
    if (listedRepository && listedRepository.description.trim().length > 0) {
      described.providerDescription = listedRepository.description;
    }
    if (row) {
      described.relationships = row.relationships.map((relationship) => ({
        kind: relationship.kind,
        targetKey: relationship.targetKey,
        direction: relationship.direction,
        ...(relationship.note ? { note: relationship.note } : {}),
      }));
      described.unknownRelationshipCount = row.unknownRelationshipCount;
      // A row answers for itself; without one, the run's own enabled list is
      // the only evidence, and on a bridge there is none at all.
      described.enabled = row.enabled;
    } else if (input.catalogActivated) {
      described.enabled = enabled.has(key);
    }
    if (listedRepository) {
      described.usable = listedRepository.defaultBranch.trim().length > 0;
    }
    return described;
  };
  return [...new Set([...byKey.keys(), ...listedByKey.keys()])].sort().map(factsOf);
}

/**
 * The operator's descriptions and the catalog's relationships, for every
 * repository this run may have to describe.
 *
 * A FAILED READ IS SAID OUT LOUD, NOT SWALLOWED. Continuing with no
 * relationships renders, as a map, the positive claim that these repositories
 * are unrelated, which is worse than the silence it replaced: an agent told
 * that stops looking. So the failure travels as a fact and the prompt carries a
 * sentence about it.
 */
export async function loadRepositoryMapCatalog(input: {
  keys: readonly string[];
  /** Everything the providers offered, in and out of the catalog, so the
   *  provider's listing text is available as a labelled fallback and usability
   *  is known. */
  listed: readonly RepositoryMetadata[];
  enabledKeys: readonly string[];
  catalogActivated: boolean;
}): Promise<RepositoryMapCatalog> {
  const keys = [...new Set(input.keys)];
  let rows: Awaited<
    ReturnType<typeof import("../../../db/repositories/repository-catalog.js")["listConnectedRepositoryCatalogMapRows"]>
  > = [];
  let relationshipsUnreadable = false;
  let catalogUnreadable = false;
  try {
    const { listConnectedRepositoryCatalogMapRows } = await import(
      "../../../db/repositories/repository-catalog.js"
    );
    rows = await listConnectedRepositoryCatalogMapRows(keys);
  } catch (error) {
    // THE READ FAILED, SO EVERY FACT IT WOULD HAVE CARRIED IS MISSING, not
    // just the relationships: the operator's descriptions came from the same
    // rows. The map says so above its groups and stops crediting the provider
    // with being the only one who ever wrote anything.
    catalogUnreadable = true;
    relationshipsUnreadable = true;
    const { logger } = await import("../../../infra/logger.js");
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "repository_map_catalog_unreadable",
    );
  }
  const facts = repositoryMapFacts({
    rows,
    listed: input.listed,
    enabledKeys: input.enabledKeys,
    catalogActivated: input.catalogActivated,
  });
  return {
    facts,
    relationshipsUnreadable,
    catalogUnreadable,
    result: {
      repositoryMap: {
        repositories: facts,
        ...(relationshipsUnreadable ? { relationshipsUnreadable: true } : {}),
        ...(catalogUnreadable ? { catalogUnreadable: true } : {}),
      },
    },
  };
}

/**
 * The repositories one relationship away from what the ticket or the event
 * names, taken without asking anybody.
 *
 * WHY THIS EXISTS. An operator wrote in the catalog that A is the frontend for
 * B. A ticket names A. Until now the run opened A alone, and the agent either
 * spent passes working out that B was where the logic lived or asked a person a
 * question the catalog had already answered.
 *
 * ALL OF THE NEIGHBOURHOOD OR NONE OF IT. The shape this exists for is a
 * frontend whose backend the catalog names: a neighbourhood of one or two,
 * where taking it is obviously right. A hub repository has a hundred and fifty
 * neighbours, and taking the first two of those is picking by alphabet, on the
 * critical path, at a clone each. So a neighbourhood larger than
 * `RELATED_ATTACH_MAX` is left whole in the map, where the agent can ask for
 * the one it needs by name.
 *
 * AND NEVER PAST THE WORKSPACE CEILING. More than
 * `WORKSPACE_NARROWING_CEILING` repositories in the workspace makes
 * `prepare-workspace` stop and ask a person which are essential. A run that
 * needed no question must not be handed one because this took two neighbours
 * nobody asked about: asking is the most expensive thing a run does to
 * somebody, and removing a question is the whole point of this feature.
 *
 * THE OTHER GUARDS ARE SOMEBODY'S DECISION. The record decides: an exclusion,
 * an unavailable entry and the definition pin all refuse through `decide`, so
 * nothing here can take a repository a person said no to.
 *
 * THE EXPANSION RULE IS NOT ONE OF THOSE GUARDS, whatever this comment used to
 * claim. `isAllowed` is `isCandidate(key) || expansion === "attach" || ...`
 * (`work-scope/decide.ts`), and under the `enabled_catalog` policy a webhook
 * defaults to, `isCandidate` is just "enabled and usable". So under that
 * policy every enabled repository is a candidate and an `ask_once` rule
 * refuses no neighbour at all. That is deliberate, and it is the feature:
 * a neighbour costs nobody a question, it arrives read only, the Decision
 * Trail says which relationship brought it, and the workspace ceiling bounds
 * how many can arrive. Under a narrower policy (`listed`,
 * `event_repository_and_related`) a neighbour outside the candidate set is
 * refused, which is why this reads as a guard until you check it.
 *
 * And the ACCESS decides: read only, always. Workspace
 * access defaults to write, so a neighbour taken on the strength of a
 * relationship nobody was asked about would silently widen what the run may
 * commit to. Write comes from the plan's write repositories or from a person,
 * never from an edge in a catalog.
 *
 * `access` is not on `SelectedRepository`, it is on the workspace input, so
 * the one place that can set it is `prepare-workspace`, from the
 * `relatedAttachments` below. `prepare-workspace.test.ts` asserts the checkout
 * this produces is read only, so deleting that mapping turns a test red rather
 * than quietly handing the run write access to a repository nobody chose.
 */
export function takeRelatedRepositories(input: {
  chosen: SelectedRepository[];
  recorder: RunWorkScopeRecorder | null;
  facts: readonly RepositoryMapFacts[];
  /**
   * Whether this run actually READ the two things the sweep below decides on:
   * the catalog relationships, and the ticket's own words.
   *
   * A failed catalog read looks exactly like an operator deleting every
   * relationship, and a path that read no ticket looks exactly like a ticket
   * that names nothing. Acting on either would take repositories off the
   * record on the strength of evidence this run never saw, so the caller says
   * whether it saw it rather than letting an empty array speak for it.
   */
  evidenceReadable: boolean;
  /** The repositories the ticket's or the event's own text names. */
  seedKeys: readonly string[];
  repositoriesByKey: Map<string, RepositoryMetadata>;
}): {
  chosen: SelectedRepository[];
  relatedAttachments: NonNullable<PreSandboxRepositoryMap["relatedAttachments"]>;
  /** Repositories a previous run took because of a relationship the operator
   *  has since deleted. Removed from the record, and taken back out of this
   *  run's workspace. */
  droppedKeys: string[];
} {
  const empty = { chosen: input.chosen, relatedAttachments: [], droppedKeys: [] };
  if (!input.recorder || !input.evidenceReadable) return empty;
  const held = new Set(input.chosen.map(repositoryKey));
  // THE EVIDENCE, whether or not this run acts on it: every repository the
  // catalog relates to one this work names, plus the named ones themselves. An
  // entry of this origin outside it is one whose reason has gone away.
  const neighbourhood = relatedRepositoryKeys(input.facts, input.seedKeys);
  const stillNamedKeys = [...new Set([...neighbourhood, ...input.seedKeys])];
  const offered = neighbourhood.filter(
    (key) => !held.has(key) && input.repositoriesByKey.has(key),
  );
  // WHAT THIS RUN TAKES. Deliberately not `.slice(0, RELATED_ATTACH_MAX)`: the
  // first two of a hundred and fifty is a coin toss dressed as a decision. A
  // neighbourhood it declines is still evidence, which is why the sweep reads
  // `stillNamedKeys` and not this.
  const candidates =
    offered.length > 0 &&
    offered.length <= RELATED_ATTACH_MAX &&
    input.chosen.length + offered.length <= WORKSPACE_NARROWING_CEILING
      ? offered
      : [];
  const via = relationshipsIntoNeighbourhood(input.facts, input.seedKeys);
  const chosen = [...input.chosen];
  const relatedAttachments: NonNullable<PreSandboxRepositoryMap["relatedAttachments"]> = [];
  const droppedKeys = new Set<string>();
  /** One decision, and the entries it swept. Called for every candidate, and
   *  once with no candidate at all, so a run that takes nothing still tells
   *  the record what the catalog no longer relates. */
  const decide = (key: string | null, rationale: string) => {
    const decision = input.recorder!.decide({
      kind: "derived",
      // ITS OWN ORIGIN, so the Decision Trail sends a person to the catalog
      // relationship that decided this and not to a trigger that says nothing
      // about relationships. It is also what makes the re-derivation safe:
      // only entries this origin wrote are checked back against the catalog,
      // so nothing decided another way is re-examined against a catalog it did
      // not come from.
      origin: "related_repository",
      repositoryKeys: key === null ? [] : [key],
      stillNamedKeys,
      rationale,
    });
    for (const deletion of decision.plan.deletes) droppedKeys.add(deletion.repositoryKey);
    return decision;
  };
  for (const key of candidates) {
    const source = via.get(key);
    const repository = input.repositoriesByKey.get(key);
    if (!source || !repository) continue;
    // The rationale a person reads in the Decision Trail, naming the repository
    // and the relationship this came through: the same two facts the map shows
    // the agent, so the trail and the prompt cannot tell two stories.
    const rationale = `Related to ${source.key}, which this work names: ${source.key} ${relationshipSentence(source.relationship, source.direction, key)}`.slice(
      0,
      RELATED_ENTRY_RATIONALE_MAX_LENGTH,
    );
    const decision = decide(key, rationale);
    if (decision.attach.length === 0) continue;
    chosen.push(selectedRepository(repository, rationale));
    relatedAttachments.push({
      repositoryKey: key,
      viaRepositoryKey: source.key,
      relationship: source.relationship,
    });
  }
  // THE SWEEP STILL HAPPENS WHEN NOTHING IS TAKEN, which is the case that
  // matters: the operator deleted the relationship, so there is no candidate
  // to carry the event, and without this call the entry that relationship
  // wrote would re-attach the repository on every run from now on.
  if (candidates.length === 0) decide(null, NO_RELATIONSHIP_RATIONALE);
  return {
    // Off the record AND out of this run's workspace. Leaving it checked out
    // for one more run would have the agent working in a repository the
    // trail has just said we took away.
    chosen: chosen.filter((repository) => !droppedKeys.has(repositoryKey(repository))),
    relatedAttachments: relatedAttachments.filter(
      (attachment) => !droppedKeys.has(attachment.repositoryKey),
    ),
    droppedKeys: [...droppedKeys],
  };
}

/** The rationale of an event that attaches nothing. It writes no entry, so
 *  nobody reads it; the contract wants a string and this says what happened. */
const NO_RELATIONSHIP_RATIONALE =
  "The catalog relates no further repository to what this work names.";
