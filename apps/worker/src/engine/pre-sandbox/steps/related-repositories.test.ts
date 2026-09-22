/**
 * Taking the obvious neighbour of a repository a ticket names.
 *
 * The failure this exists to end: an operator writes in the catalog that A is
 * the frontend for B, a ticket names A, and the run opens A alone. The agent
 * then spends passes working out that B is where the logic lives, or asks a
 * person a question the catalog already answered.
 *
 * The failure it must not cause: a repository nobody asked about, checked out
 * with write access, because workspace access defaults to write.
 */
import { describe, expect, it } from "vitest";
import type { RepositoryMetadata } from "../../../adapters/vcs/repository-directory.js";
import type { WorkScope, WorkScopeEntry } from "@shared/contracts";
import { createRunWorkScopeRecorder } from "../../work-scope/context.js";
import type { RepositoryMapFacts } from "../../../repository-map/map.js";
import type { SelectedRepository } from "../../../adapters/vcs/repository-directory.js";
import { takeRelatedRepositories } from "./related-repositories.js";

const API = "github:acme/api";
const WEB = "github:acme/web";
const OPS = "github:acme/ops";

function repository(path: string): RepositoryMetadata {
  return {
    provider: "github",
    repoPath: path,
    name: path.split("/")[1] ?? path,
    owner: "acme",
    defaultBranch: "main",
    description: "",
    webUrl: `https://github.com/${path}`,
    topics: [],
    archived: false,
    private: false,
  };
}

const REPOSITORIES = new Map([
  [API, repository("acme/api")],
  [WEB, repository("acme/web")],
  [OPS, repository("acme/ops")],
]);

const FACTS: RepositoryMapFacts[] = [
  {
    key: API,
    enabled: true,
    usable: true,
    relationships: [
      { kind: "frontend_for", targetKey: WEB, direction: "outgoing" },
      { kind: "deploys", targetKey: OPS, direction: "incoming" },
    ],
  },
  { key: WEB, enabled: true, usable: true },
  { key: OPS, enabled: true, usable: true },
];

function entry(over: Partial<WorkScopeEntry> & { repositoryKey: string }): WorkScopeEntry {
  return {
    state: "selected",
    origin: "person",
    rationale: "chosen",
    decidedBy: { kind: "person", actorId: "u1", actorLabel: "Ada" },
    decidedAt: "2026-09-01T10:00:00.000Z",
    ...over,
  } as WorkScopeEntry;
}

function recorder(entries: WorkScopeEntry[] = [], enabledKeys: string[] = [API, WEB, OPS]) {
  const scope: WorkScope = { subjectKey: "ticket:AWP-1", version: 1, entries };
  return createRunWorkScopeRecorder({
    subjectKey: "ticket:AWP-1",
    scope,
    selectionAnswered: false,
    answeredRepositoryKeys: [],
    ticketText: null,
    catalog: { activated: true, enabledKeys, unusableKeys: [] },
    // What a ticket trigger actually runs: every usable repository is a
    // candidate, and the run may attach one without asking.
    policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
    actor: { kind: "run", runId: "run-1", definitionId: 1, definitionVersion: 1 },
    now: "2026-09-19T09:00:00.000Z",
    attachedKeys: [API],
  });
}

const chosen: SelectedRepository[] = [
  { provider: "github" as const, repoPath: "acme/api", defaultBranch: "main", selectedRationale: "The ticket text names this repository path." },
];

describe("takeRelatedRepositories", () => {
  it("takes the neighbour of a repository the ticket names, and says which relationship brought it", () => {
    const taken = takeRelatedRepositories({
      chosen,
      evidenceReadable: true,
      recorder: recorder(),
      facts: FACTS,
      seedKeys: [API],
      repositoriesByKey: REPOSITORIES,
    });
    expect(taken.chosen.map((repo) => `github:${repo.repoPath}`)).toEqual([API, OPS, WEB]);
    expect(taken.relatedAttachments).toEqual([
      { repositoryKey: OPS, viaRepositoryKey: API, relationship: "deploys" },
      { repositoryKey: WEB, viaRepositoryKey: API, relationship: "frontend_for" },
    ]);
    expect(taken.chosen.find((repo) => repo.repoPath === "acme/web")?.selectedRationale).toBe(
      "Related to github:acme/api, which this work names: github:acme/api is a frontend for `github:acme/web`.",
    );
  });

  it("records the catalog relationship as the origin, not the trigger policy", () => {
    // A person reading the Decision Trail and then opening the trigger used to
    // find nothing about relationships at all, because the entry said
    // `trigger_policy` while the truth sat in free text beside it. The origin
    // is what tells them where to go and undo it.
    const recorder_ = recorder();
    takeRelatedRepositories({
      chosen,
      evidenceReadable: true,
      recorder: recorder_,
      facts: FACTS,
      seedKeys: [API],
      repositoriesByKey: REPOSITORIES,
    });
    const written = recorder_.plans.flatMap((plan) => plan.upserts.map((upsert) => upsert.entry));
    expect(written.map((entry_) => entry_.repositoryKey).sort()).toEqual([OPS, WEB]);
    for (const entry_ of written) expect(entry_.origin).toBe("related_repository");
  });

  it("drops a held entry whose relationship the operator deleted, and says so in the trail", () => {
    // The run before this one took `web` because the catalog said `api` was its
    // backend. Somebody has since deleted that relationship. Without this the
    // entry re-attaches `web` on every run from now on, and the only way back
    // is a database edit: a repository that attaches itself forever after the
    // reason was taken away is worse than no automatic attachment.
    const held = entry({
      repositoryKey: WEB,
      origin: "related_repository",
      rationale: "Related to github:acme/api, which this work names: ...",
    });
    const recorder_ = recorder([held]);
    const taken = takeRelatedRepositories({
      chosen: [
        ...chosen,
        { provider: "github", repoPath: "acme/web", defaultBranch: "main", selectedRationale: "related" },
      ],
      evidenceReadable: true,
      recorder: recorder_,
      // The catalog this run read: `api` relates to nothing any more.
      facts: [{ key: API, enabled: true, usable: true }, { key: WEB, enabled: true, usable: true }],
      seedKeys: [API],
      repositoriesByKey: REPOSITORIES,
    });
    expect(taken.droppedKeys).toEqual([WEB]);
    // Off the record...
    const deleted = recorder_.plans.flatMap((plan) => plan.deletes);
    expect(deleted).toEqual([{ repositoryKey: WEB, origin: "related_repository" }]);
    // ...with a trail line a person can act on...
    const removals = recorder_.plans
      .flatMap((plan) => plan.trail)
      .filter((event) => event.kind === "entry_removed");
    expect(removals).toHaveLength(1);
    const removal = removals[0]!;
    if (removal.kind !== "entry_removed") throw new Error("unreachable");
    expect(removal.reason).toBe("relationship_removed");
    expect(removal.entry.repositoryKey).toBe(WEB);
    // ...and out of this run's workspace too, or the agent works in a
    // repository the trail has just said we took away.
    expect(taken.chosen.map((repo) => `github:${repo.repoPath}`)).toEqual([API]);
  });

  it("keeps a held entry whose relationship is still there but which this run declines to take", () => {
    // The neighbourhood is too wide to take whole, so nothing is attached. The
    // relationships are all still recorded, so nothing is evidence that went
    // away, and sweeping here would delete an entry over a decision about
    // WORKSPACE SIZE rather than about the relationship.
    const wide = Array.from({ length: 9 }, (_, index) => `github:acme/n${index}`);
    const recorder_ = recorder([entry({ repositoryKey: wide[0]!, origin: "related_repository" })], [
      API,
      ...wide,
    ]);
    const taken = takeRelatedRepositories({
      chosen,
      evidenceReadable: true,
      recorder: recorder_,
      facts: [
        {
          key: API,
          enabled: true,
          usable: true,
          relationships: wide.map((key) => ({
            kind: "depends_on" as const,
            targetKey: key,
            direction: "outgoing" as const,
          })),
        },
        ...wide.map((key) => ({ key, enabled: true, usable: true })),
      ],
      seedKeys: [API],
      repositoriesByKey: new Map([
        [API, repository("acme/api")],
        ...wide.map((key) => [key, repository(key.slice("github:".length))] as const),
      ]),
    });
    expect(taken.droppedKeys).toEqual([]);
    expect(recorder_.plans.flatMap((plan) => plan.deletes)).toEqual([]);
  });

  it("drops nothing when this run could not read the catalog or the ticket", () => {
    // A failed catalog read looks exactly like an operator deleting every
    // relationship. Acting on that would take repositories off the record on
    // the strength of evidence this run never saw.
    const recorder_ = recorder([entry({ repositoryKey: WEB, origin: "related_repository" })]);
    const taken = takeRelatedRepositories({
      chosen,
      evidenceReadable: false,
      recorder: recorder_,
      facts: [],
      seedKeys: [API],
      repositoriesByKey: REPOSITORIES,
    });
    expect(taken.droppedKeys).toEqual([]);
    expect(recorder_.plans.flatMap((plan) => plan.deletes)).toEqual([]);
  });

  it("never takes a repository a person excluded", () => {
    const taken = takeRelatedRepositories({
      chosen,
      evidenceReadable: true,
      recorder: recorder([entry({ repositoryKey: WEB, state: "excluded" })]),
      facts: FACTS,
      seedKeys: [API],
      repositoriesByKey: REPOSITORIES,
    });
    expect(taken.chosen.map((repo) => `github:${repo.repoPath}`)).not.toContain(WEB);
    expect(taken.relatedAttachments.map((attachment) => attachment.repositoryKey)).not.toContain(
      WEB,
    );
  });

  it("never takes a repository the catalog does not offer this run", () => {
    const taken = takeRelatedRepositories({
      chosen,
      evidenceReadable: true,
      recorder: recorder(),
      facts: FACTS,
      seedKeys: [API],
      // The provider listed neither neighbour, so neither can be checked out.
      repositoriesByKey: new Map([[API, repository("acme/api")]]),
    });
    expect(taken.chosen).toEqual(chosen);
    expect(taken.relatedAttachments).toEqual([]);
  });

  it("takes none of a wide neighbourhood rather than the first two of it", () => {
    const wide = Array.from({ length: 9 }, (_, index) => `github:acme/n${index}`);
    const taken = takeRelatedRepositories({
      chosen,
      evidenceReadable: true,
      recorder: recorder([], [API, ...wide]),
      facts: [
        {
          key: API,
          enabled: true,
          usable: true,
          relationships: wide.map((key) => ({
            kind: "depends_on" as const,
            targetKey: key,
            direction: "outgoing" as const,
          })),
        },
        ...wide.map((key) => ({ key, enabled: true, usable: true })),
      ],
      seedKeys: [API],
      repositoriesByKey: new Map([
        [API, repository("acme/api")],
        ...wide.map((key) => [key, repository(key.slice("github:".length))] as const),
      ]),
    });
    // `n000` and `n001` are not the two the work needs, they are the two the
    // alphabet put first, and each is a clone on the critical path. The whole
    // neighbourhood is in the map instead, to be asked for by name.
    expect(taken.relatedAttachments).toEqual([]);
    expect(taken.chosen).toEqual(chosen);
  });

  it("takes no neighbour that would push the workspace past the question ceiling", () => {
    // Seven repositories a person already put on this work, and a
    // neighbourhood of exactly two: small enough to take, and two too many.
    const held = Array.from({ length: 7 }, (_, index) => `github:acme/h${index}`);
    const neighbours = [WEB, OPS];
    const taken = takeRelatedRepositories({
      chosen: held.map((key) => ({
        provider: "github" as const,
        repoPath: key.slice("github:".length),
        defaultBranch: "main",
        selectedRationale: "A person put this on the ticket.",
      })),
      evidenceReadable: true,
      recorder: recorder([], [...held, ...neighbours]),
      facts: [
        {
          key: held[0]!,
          enabled: true,
          usable: true,
          relationships: neighbours.map((key) => ({
            kind: "depends_on" as const,
            targetKey: key,
            direction: "outgoing" as const,
          })),
        },
        ...neighbours.map((key) => ({ key, enabled: true, usable: true })),
      ],
      seedKeys: [held[0]!],
      repositoriesByKey: new Map([
        ...held.map((key) => [key, repository(key.slice("github:".length))] as const),
        ...neighbours.map((key) => [key, repository(key.slice("github:".length))] as const),
      ]),
    });
    // Nine in the workspace is "More than 8 repositories are in scope. Which
    // are essential?", put to a person who had asked nothing of the sort.
    expect(taken.relatedAttachments).toEqual([]);
    expect(taken.chosen).toHaveLength(7);
  });

  it("takes nothing when the ticket names nothing", () => {
    const taken = takeRelatedRepositories({
      chosen,
      evidenceReadable: true,
      recorder: recorder(),
      facts: FACTS,
      seedKeys: [],
      repositoriesByKey: REPOSITORIES,
    });
    expect(taken.chosen).toEqual(chosen);
    expect(taken.relatedAttachments).toEqual([]);
  });
});
