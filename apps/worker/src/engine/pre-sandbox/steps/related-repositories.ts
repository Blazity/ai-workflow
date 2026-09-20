/**
 * WHICH NEIGHBOURS A RUN TAKES WITHOUT ASKING, AND THE CATALOG READ BEHIND IT.
 *
 * Split out of `repo-selection.ts`, which had grown past 2,600 lines: the two
 * decisions here (what the catalog says about every repository this run may
 * describe, and which of the neighbours it takes on its own) are read together,
 * changed together and tested together, and neither one is about selecting the
 * repositories a ticket names.
 *
 * It also holds the two identity helpers the selection and this file share, so
 * a repository is turned into a key and into a selection in exactly one place.
 */
import {
  type RepositoryMetadata,
  type SelectedRepository,
} from "../../../adapters/vcs/repository-directory.js";
import type { PreSandboxRepositoryMap } from "../types.js";
import { WORKSPACE_NARROWING_CEILING } from "../types.js";
import type { RunWorkScopeRecorder } from "../../work-scope/context.js";
import {
  relatedRepositoryKeys,
  relationshipsIntoNeighbourhood,
  relationshipSentence,
  type RepositoryMapFacts,
} from "../../../repository-map/map.js";

/** `provider:path`, lowercased, the one spelling every store and every record
 *  in this run uses. */
export function repositoryKey(
  repo: Pick<RepositoryMetadata, "provider" | "repoPath">,
): string {
  return `${repo.provider}:${repo.repoPath.toLowerCase()}`;
}

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
  const byKey = new Map(rows.map((row) => [row.key, row] as const));
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
  const facts = [...new Set([...byKey.keys(), ...listedByKey.keys()])].sort().map(factsOf);
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
 * an unavailable entry, the definition pin and the trigger's own expansion
 * rule all refuse through `decide`, so nothing here can take a repository a
 * person said no to. And the ACCESS decides: read only, always. Workspace
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
  
  /** The repositories the ticket's or the event's own text names. */
  seedKeys: readonly string[];
  repositoriesByKey: Map<string, RepositoryMetadata>;
}): {
  chosen: SelectedRepository[];
  relatedAttachments: NonNullable<PreSandboxRepositoryMap["relatedAttachments"]>;
} {
  const empty = { chosen: input.chosen, relatedAttachments: [] };
  if (!input.recorder || input.seedKeys.length === 0) return empty;
  const held = new Set(input.chosen.map(repositoryKey));
  const candidates = relatedRepositoryKeys(input.facts, input.seedKeys).filter(
    (key) => !held.has(key) && input.repositoriesByKey.has(key),
  );
  // Deliberately not `.slice(0, RELATED_ATTACH_MAX)`: the first two of a
  // hundred and fifty is a coin toss dressed as a decision.
  if (candidates.length === 0 || candidates.length > RELATED_ATTACH_MAX) return empty;
  if (input.chosen.length + candidates.length > WORKSPACE_NARROWING_CEILING) return empty;
  const via = relationshipsIntoNeighbourhood(input.facts, input.seedKeys);
  const chosen = [...input.chosen];
  const relatedAttachments: NonNullable<PreSandboxRepositoryMap["relatedAttachments"]> = [];
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
    const decision = input.recorder.decide({
      kind: "derived",
      // NOT an origin of its own, and that is a compromise recorded rather than
      // hidden: the four derived origins are frozen in the contract AND in a
      // database CHECK constraint (`work_scope_entries_origin_check`), so a
      // fifth one needs a migration. `trigger_policy` is the honest one of the
      // four: on a ticket trigger every usable repository IS a candidate of the
      // policy, and this rule is what picked this repository out of them. The
      // rationale above carries the precision the origin cannot.
      origin: "trigger_policy",
      repositoryKeys: [key],
      rationale,
    });
    if (decision.attach.length === 0) continue;
    chosen.push(selectedRepository(repository, rationale));
    relatedAttachments.push({
      repositoryKey: key,
      viaRepositoryKey: source.key,
      relationship: source.relationship,
    });
  }
  return { chosen, relatedAttachments };
}
