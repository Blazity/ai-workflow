/**
 * AN EDGE RECORDED ON ONE END REACHES BOTH ENDS' MAP ENTRIES.
 *
 * The catalog stores a relationship ONCE, on the row whose operator recorded
 * it: `repositoryRelationshipSchema` is `{ repositoryId, kind, note }` with no
 * side, and saving a profile writes only that repository's own list. Read
 * naively, an operator who opens A and records "A is the backend for B" has
 * told every agent working in A and told every agent working in B nothing,
 * which is half a dependency map and the wrong half for whoever is standing in
 * B.
 *
 * It is not read naively. `listRepositoryCatalogMapRows` returns the edge to
 * both repositories in ONE statement (`outgoing` to the end that wrote it down,
 * `incoming` to the other), `repositoryMapFacts` carries the side through
 * untouched, and `buildRepositoryMap` renders the inverse sentence for an
 * incoming one. Three modules, each with its own tests, and nothing observed
 * the promise they add up to.
 *
 * This does: one operator records one edge on one side, and both agents read a
 * true sentence about it. It runs the real query against the real schema, so a
 * change to that SQL, to the mapping, or to the sentences fails here.
 *
 * WHAT TURNS IT RED, observed: deleting the `UNION ALL` half of the `edges` CTE
 * in `listRepositoryCatalogMapRows` (the obvious "this looks like a duplicate
 * of the other half" edit) leaves the dashboard with no relationships and no
 * relationship count at all.
 */
import { describe, expect, it } from "vitest";
import {
  listRepositoryCatalogMapRows,
  setRepositoryEnabled,
  upsertRepositoryProfile,
} from "../../../db/repositories/repository-catalog.js";
import { createTestDb } from "../../../db/test-db.js";
import { buildRepositoryMap } from "../../../repository-map/map.js";
import { repositoryMapFacts } from "./related-repositories.js";

const KEYS = ["github:acme/api", "github:acme/web"];

/** Everything the providers offered, the shape `loadRepositoryMapCatalog`
 *  passes: both repositories exist and can be checked out. */
const LISTED = ["acme/api", "acme/web"].map((repoPath) => ({
  provider: "github" as const,
  repoPath,
  name: repoPath.slice(repoPath.indexOf("/") + 1),
  owner: "acme",
  defaultBranch: "main",
  description: "",
  webUrl: `https://github.com/${repoPath}`,
  topics: [],
  archived: false,
  private: false,
}));

/** One operator, one page, one relationship: recorded on the API and never
 *  touched on the dashboard. `webRelationships` lets one case record the same
 *  fact from the dashboard's page as well. */
async function catalogWithOneRecordedEdge(options: { apiKind?: string; webKind?: string } = {}) {
  const db = await createTestDb();
  const web = await upsertRepositoryProfile(db, {
    provider: "github",
    path: "acme/web",
    description: "The customer dashboard.",
    rules: "",
    relationships: [],
    scriptGroups: { provider: "github", repoPath: "acme/web", groups: {} },
    gateGroups: null,
    actorId: "user-1",
    actorLabel: "Ada",
    reason: "",
    expectedProfileVersion: undefined,
  });
  const api = await upsertRepositoryProfile(db, {
    provider: "github",
    path: "acme/api",
    description: "The payments API.",
    rules: "",
    relationships: [
      { repositoryId: web.id, kind: options.apiKind ?? "backend_for", note: "checkout" },
    ] as never,
    scriptGroups: { provider: "github", repoPath: "acme/api", groups: {} },
    gateGroups: null,
    actorId: "user-1",
    actorLabel: "Ada",
    reason: "",
    expectedProfileVersion: undefined,
  });
  if (options.webKind) {
    await upsertRepositoryProfile(db, {
      provider: "github",
      path: "acme/web",
      description: "The customer dashboard.",
      rules: "",
      relationships: [{ repositoryId: api.id, kind: options.webKind }] as never,
      scriptGroups: { provider: "github", repoPath: "acme/web", groups: {} },
      gateGroups: null,
      actorId: "user-2",
      actorLabel: "Bo",
      reason: "",
      expectedProfileVersion: undefined,
    });
  }
  await setRepositoryEnabled(db, { id: api.id, enabled: true });
  await setRepositoryEnabled(db, { id: web.id, enabled: true });
  return db;
}

/** The three real steps between the operator's page and the agent's prompt. */
async function mapFor(attached: string, options: { apiKind?: string; webKind?: string } = {}) {
  const db = await catalogWithOneRecordedEdge(options);
  const rows = await listRepositoryCatalogMapRows(db, KEYS);
  const facts = repositoryMapFacts({
    rows,
    listed: LISTED,
    enabledKeys: KEYS,
    catalogActivated: true,
  });
  return buildRepositoryMap({
    repositories: facts,
    namedKeys: [attached],
    attached: [{ key: attached, access: "write" }],
    catalogActivated: true,
    expansionOpen: true,
  });
}

describe("one relationship, recorded once, read from both ends", () => {
  it("tells the agent standing in the repository whose operator recorded it", async () => {
    const map = await mapFor("github:acme/api");
    expect(map.text).toContain("is the backend for `github:acme/web`");

    const api = map.repositories.find((entry) => entry.key === "github:acme/api");
    expect(api?.relationships).toEqual([
      {
        kind: "backend_for",
        target: "github:acme/web",
        direction: "outgoing",
        note: "checkout",
      },
    ]);
    expect(api?.relationshipCount).toBe(1);
  });

  it("tells the agent standing in the OTHER one, in the inverse sentence", async () => {
    // Nobody ever opened this repository's page. Read forwards, the same edge
    // would say the dashboard is the backend for the API, which is backwards
    // and sends the agent to the wrong repository.
    const map = await mapFor("github:acme/web");
    expect(map.text).toContain("is a frontend of `github:acme/api`");
    expect(map.text).not.toContain("is the backend for `github:acme/api`");

    const web = map.repositories.find((entry) => entry.key === "github:acme/web");
    expect(web?.relationships).toEqual([
      {
        kind: "backend_for",
        target: "github:acme/api",
        direction: "incoming",
        note: "checkout",
      },
    ]);
    // Counts every edge TOUCHING it, not only the ones it owns. It owns none.
    expect(web?.relationshipCount).toBe(1);
  });

  it("lists one edge once when BOTH operators recorded the same symmetric fact", async () => {
    // Two people, two pages, one fact: each recorded "related to the other" on
    // their own repository, so the catalog holds two rows and the reader hands
    // this repository its own edge and its neighbour's. A symmetric kind reads
    // the same sentence either way, so before the deduplication the prompt said
    // "It is related to `x`. It is related to `x`." and the count said two.
    const map = await mapFor("github:acme/api", { apiKind: "related_to", webKind: "related_to" });
    const api = map.repositories.find((entry) => entry.key === "github:acme/api");
    expect(api?.relationships).toEqual([
      // `outgoing`, because this repository's own operator did record it.
      { kind: "related_to", target: "github:acme/web", direction: "outgoing", note: "checkout" },
    ]);
    expect(api?.relationshipCount).toBe(1);
    // And the prompt says it once. Before the deduplication this line read
    // "It is related to `x`. It is related to `x`."
    const relates = map.text
      .split("\n")
      .filter((line) => line.trim().startsWith("How it relates:"));
    const aboutTheDashboard = relates.filter((line) => line.includes("github:acme/web"));
    expect(aboutTheDashboard).toHaveLength(1);
    expect(aboutTheDashboard[0]!.split("github:acme/web").length - 1).toBe(1);
  });

  it("keeps both when the two operators recorded CONTRADICTING sides of one kind", async () => {
    // Not the same case: "the API is the backend for the dashboard" and "the
    // dashboard is the backend for the API" are two different claims, and an
    // agent shown only one cannot tell that the catalog contradicts itself.
    const map = await mapFor("github:acme/api", { webKind: "backend_for" });
    const api = map.repositories.find((entry) => entry.key === "github:acme/api");
    expect(api?.relationships).toHaveLength(2);
    expect(api?.relationshipCount).toBe(2);
    expect(map.text).toContain("is the backend for `github:acme/web`");
    expect(map.text).toContain("is a frontend of `github:acme/web`");
  });

  it("counts and shows the edge once, not twice, on the end that owns it", async () => {
    // The reverse view is the query's, not a copy made on this side, so there
    // is no second edge to deduplicate and no second place to get the side
    // wrong.
    const map = await mapFor("github:acme/api");
    const sentences = map.text.split("github:acme/web").length - 1;
    expect(sentences).toBeGreaterThan(0);
    for (const entry of map.repositories) {
      const seen = new Set(
        entry.relationships.map(
          (relationship) => `${relationship.kind}|${relationship.target}|${relationship.direction}`,
        ),
      );
      expect(seen.size).toBe(entry.relationships.length);
      expect(entry.relationships.length).toBeLessThanOrEqual(entry.relationshipCount);
    }
  });
});
