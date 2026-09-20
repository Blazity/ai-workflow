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
 * `write` and `read_only` come from the access the workspace gave each one, so
 * the record says what the agent could actually change rather than what it was
 * shown. The description and rules are null here: what reaches this send is a
 * checkout, and the operator's words about a repository travel as their own
 * prompt sections with their own provenance.
 */
export function selectedRepositoryContext(input: {
  repositories: readonly WorkspaceRepositoryInput[];
  workScope?: RunStartWorkScope;
  renderedAt?: { sectionIndex: number; partId: string };
}): BriefingRepositoryContextPlan {
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
