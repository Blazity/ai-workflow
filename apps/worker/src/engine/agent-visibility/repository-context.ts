/**
 * Which repositories a send put in front of the model, and why.
 *
 * Built from THE EXACT OBJECTS THE RENDERERS USED for that send, never read
 * back from the catalog. A profile somebody edits between the send and the
 * read must not change what the page shows: the record answers "what did this
 * agent get", and a value fetched at read time answers a different question
 * while looking like the same one.
 *
 * Two shapes reach a model today. Discovery is handed the offered catalog, one
 * line per repository, with the provider's own listing text; every other send
 * is handed the repositories the run selected, in full. Both are recorded from
 * their own input, and neither is turned into the other.
 */
import type { RunStartWorkScope } from "../steps/run-start-settings.js";
import type { RepositoryCatalogEntry } from "../repository-discovery/catalog.js";
import type { WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import type { RepositoryMap } from "../../repository-map/map.js";
import { workScopeRepositoryKey } from "../work-scope/context.js";
import type { BriefingRepositoryContextPlan, BriefingRepositoryPlan } from "./plan.js";

/**
 * The record's own view of the subject, beside the repositories.
 *
 * `leftOutKeys` is every key the record does NOT have as selected, which is
 * what a person checks first when an agent ignored a repository they expected
 * it to touch.
 */
function workScopeOf(scope: RunStartWorkScope | undefined): BriefingRepositoryContextPlan["workScope"] {
  if (!scope?.scope) return null;
  return {
    version: scope.scope.version,
    leftOutKeys: scope.scope.entries
      .filter((entry) => entry.state !== "selected")
      .map((entry) => entry.repositoryKey),
  };
}

function entryFor(scope: RunStartWorkScope | undefined, key: string) {
  return scope?.scope?.entries.find((entry) => entry.repositoryKey === key) ?? null;
}

/**
 * The catalog as repository discovery was given it.
 *
 * `unlistedCount` is what the offer filter kept back: a repository the record
 * already excluded, or one without a default branch. A person reading "the
 * model picked none of these" needs to know how many it never saw.
 *
 * Relationships stay empty on purpose. The catalog entry carries them as
 * rendered sentences only (`repository-discovery/catalog.ts`), and the
 * structured rows never leave the pre-sandbox step, so the sentences are on
 * the record inside the prompt text and the structured field would have to be
 * invented. The Repository Map fills it from the rows themselves.
 */
export function discoveryRepositoryContext(input: {
  offered: readonly RepositoryCatalogEntry[];
  catalogSize: number;
  mandatory: readonly { provider: string; repoPath: string }[];
  workScope?: RunStartWorkScope;
  /** Where the catalog was rendered in the briefing being recorded. */
  renderedAt?: { sectionIndex: number; partId: string };
}): BriefingRepositoryContextPlan {
  const mandatoryKeys = new Set(input.mandatory.map(workScopeRepositoryKey));
  const repositories = input.offered.map((entry): BriefingRepositoryPlan => {
    const key = workScopeRepositoryKey(entry);
    const usable = entry.usable;
    return {
      key,
      description: describe(entry.description),
      rules: null,
      relationships: [],
      state: usable ? "offered" : "excluded",
      ...(usable
        ? {}
        : {
            reason:
              entry.unusableReason === "missing_default_branch"
                ? "The repository has no default branch, so nothing could be checked out of it."
                : "The catalog reports the repository as unusable.",
          }),
      inclusion: { cause: mandatoryKeys.has(key) ? "attached" : "catalog" },
      rendering: "line",
      workScopeEntry: entryFor(input.workScope, key),
    };
  });
  return {
    repositories,
    unlistedCount: Math.max(0, input.catalogSize - input.offered.length),
    workScope: workScopeOf(input.workScope),
    ...(input.renderedAt ? { renderedAt: input.renderedAt } : {}),
  };
}

/**
 * The repositories a sandbox send was working in.
 *
 * TWO SHAPES, AND THE MAP IS THE GOOD ONE. When the send rendered a repository
 * map, the record is that map's own entries: the operator's description in
 * their words, the relationships with the side of each edge this repository is
 * on, why each one is here, and what the send was allowed to do with it. It is
 * the SAME BUILD the model read, handed over by the composer, never a second
 * pass and never a fresh read of the catalog: a profile somebody edits between
 * the send and the read must not change what the page shows, and a map rebuilt
 * against a different prompt budget would list different repositories.
 *
 * Without one, the workspace list as it always was: `write` or `read_only`
 * from the access the workspace gave each repository, and no description or
 * relationships, because this send genuinely carried none. A run whose journal
 * predates the map, and a block that composed no map, record what they had
 * rather than facts nobody put in front of the agent.
 */
export function selectedRepositoryContext(input: {
  repositories: readonly WorkspaceRepositoryInput[];
  /** The map this send rendered, from the composer's own build. */
  map?: RepositoryMap | null;
  workScope?: RunStartWorkScope;
  renderedAt?: { sectionIndex: number; partId: string };
}): BriefingRepositoryContextPlan {
  if (input.map) return fromRepositoryMap(input.map, input);
  const repositories = input.repositories.map((repository): BriefingRepositoryPlan => {
    const key = workScopeRepositoryKey(repository);
    const entry = entryFor(input.workScope, key);
    return {
      key,
      description: describe(""),
      rules: null,
      relationships: [],
      state: repository.access === "read" ? "read_only" : "write",
      inclusion: { cause: entry ? "work_scope_entry" : "chosen_by_workflow" },
      rendering: "full",
      workScopeEntry: entry,
    };
  });
  return {
    repositories,
    unlistedCount: 0,
    workScope: workScopeOf(input.workScope),
    ...(input.renderedAt ? { renderedAt: input.renderedAt } : {}),
  };
}

/**
 * The map's entries as the record keeps them.
 *
 * A straight carry, field for field, because the map's entry shape was written
 * to be exactly this: the one pass that renders the text also produces the
 * rows, so nothing here decides anything and there is nothing for the two to
 * disagree about.
 *
 * The one thing NOT carried is the map's own `relationshipCount`, which counts
 * relationships the map did not show (a hub's ninth edge, one whose other end
 * is no longer a catalog row). The recorder derives its count from the list it
 * is handed, and what the map held back is said in the map's own text, where
 * the agent read it.
 */
function fromRepositoryMap(
  map: RepositoryMap,
  input: { workScope?: RunStartWorkScope; renderedAt?: { sectionIndex: number; partId: string } },
): BriefingRepositoryContextPlan {
  return {
    repositories: map.repositories.map(
      (entry): BriefingRepositoryPlan => ({
        key: entry.key,
        description: { source: entry.description.source, text: entry.description.text },
        rules: entry.rules,
        relationships: relationshipsOf(entry),
        state: entry.state,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        inclusion: {
          cause: entry.inclusion.cause,
          ...(entry.inclusion.via
            ? {
                via: {
                  key: entry.inclusion.via.key,
                  relationship: entry.inclusion.via.relationship,
                },
              }
            : {}),
        },
        rendering: entry.rendering,
        workScopeEntry: entry.workScopeEntry,
      }),
    ),
    unlistedCount: map.unlistedCount,
    workScope: workScopeOf(input.workScope),
    ...(input.renderedAt ? { renderedAt: input.renderedAt } : {}),
  };
}

/**
 * A map entry's relationships, from this repository's own end.
 *
 * The catalog stores each edge ONCE, on the repository whose operator recorded
 * it. So a neighbour that got into the map because the other end points at it
 * carries none of its own: the map's text still tells the agent about it, on
 * the "Why it is here" line built from `inclusion.via`, but the structured half
 * would show an empty relationship list beside a prose sentence about the same
 * edge. Worse, `via` on the record names the key and the kind and NOT the side,
 * because the package's `via` shape is strict and frozen, so a page rendering
 * "api backend_for web" from it says the reverse of what the operator recorded
 * whenever the edge hangs on the other end.
 *
 * So the edge this repository arrived through is listed here from ITS end, with
 * the direction flipped to match (`via.direction` is relative to `via.key`).
 * Nothing is invented: it is the same edge, from the same build, that the agent
 * read one line above. It is added only when the entry does not already carry
 * it, which is the case where the catalog hung the edge on this end and the map
 * already listed it.
 */
function relationshipsOf(
  entry: RepositoryMap["repositories"][number],
): BriefingRepositoryPlan["relationships"] {
  const listed = entry.relationships.map((relationship) => ({
    kind: relationship.kind,
    target: relationship.target,
    direction: relationship.direction,
    ...(relationship.note === undefined ? {} : { note: relationship.note }),
  }));
  const via = entry.inclusion.via;
  if (!via) return listed;
  if (listed.some((relationship) => relationship.kind === via.relationship && relationship.target === via.key)) {
    return listed;
  }
  return [
    ...listed,
    {
      kind: via.relationship,
      target: via.key,
      direction: via.direction === "outgoing" ? "incoming" : "outgoing",
    },
  ];
}

/**
 * Whose words a description is.
 *
 * Only one source exists today: the catalog entry's text is the provider's own
 * listing (`adapters/vcs/repository-directory.ts`), never the operator's
 * profile. No text at all is `none`, which the contract requires to be empty,
 * rather than an empty quote attributed to somebody.
 */
function describe(text: string): BriefingRepositoryPlan["description"] {
  return text.length === 0 ? { source: "none", text: "" } : { source: "provider", text };
}
