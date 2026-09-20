/**
 * What discovery is told about a repository.
 *
 * Discovery described every repository with the provider's listing text, the
 * "About" blurb somebody typed into GitHub years ago, while the description an
 * operator wrote on the Repositories page for exactly this decision reached
 * nothing. These tests observe the catalog entry the discovery prompt is built
 * from.
 */
import { describe, expect, it } from "vitest";
import {
  addRepositoryDiscoveryRelationships,
  type RepositoryCatalogEntry,
} from "./catalog.js";
import type { RepositoryMapFacts } from "../../repository-map/map.js";

function entry(over: Partial<RepositoryCatalogEntry> = {}): RepositoryCatalogEntry {
  return {
    provider: "github",
    repoPath: "acme/api",
    name: "api",
    defaultBranch: "main",
    description: "acme api service",
    topics: [],
    relationships: [],
    usable: true,
    ...over,
  };
}

function facts(over: Partial<RepositoryMapFacts> & { key: string }): RepositoryMapFacts {
  return { enabled: true, usable: true, ...over };
}

describe("addRepositoryDiscoveryRelationships", () => {
  it("replaces the provider's listing text with the operator's description", () => {
    const [described] = addRepositoryDiscoveryRelationships({
      catalog: [entry()],
      facts: [facts({ key: "github:acme/api", catalogDescription: "The payments API." })],
      attachedKeys: [],
      enabledKeys: ["github:acme/api"],
    });
    expect(described?.description).toBe("The payments API.");
    expect(described?.descriptionSource).toBe("catalog");
  });

  it("keeps the provider's text as a labelled fallback when nobody wrote one", () => {
    const [described] = addRepositoryDiscoveryRelationships({
      catalog: [entry()],
      facts: [facts({ key: "github:acme/api" })],
      attachedKeys: [],
      enabledKeys: ["github:acme/api"],
    });
    expect(described?.description).toBe("acme api service");
    expect(described?.descriptionSource).toBe("provider");
  });

  it("says nobody described a repository with no text on either side", () => {
    const [described] = addRepositoryDiscoveryRelationships({
      catalog: [entry({ description: "" })],
      facts: [facts({ key: "github:acme/api" })],
      attachedKeys: [],
      enabledKeys: ["github:acme/api"],
    });
    expect(described?.descriptionSource).toBe("none");
  });

  it("says so when it shortened the operator's description", () => {
    // A catalog description may hold 20,000 characters, and discovery renders
    // the whole catalog as JSON. A model shown half a paragraph with no marker
    // reads it as the whole thing the operator meant.
    const [described] = addRepositoryDiscoveryRelationships({
      catalog: [entry()],
      facts: [facts({ key: "github:acme/api", catalogDescription: "z".repeat(20_000) })],
      attachedKeys: [],
      enabledKeys: ["github:acme/api"],
    });
    expect(described?.description.length).toBeLessThan(1_200);
    expect(described?.description).toContain(
      "(shortened; the full description is on the Repositories page)",
    );
  });

  it("renders the relationship sentences the catalog holds, with their markers", () => {
    const [described] = addRepositoryDiscoveryRelationships({
      catalog: [entry()],
      facts: [
        facts({
          key: "github:acme/api",
          relationships: [
            { kind: "backend_for", targetKey: "github:acme/web", direction: "outgoing" },
            { kind: "deploys", targetKey: "github:acme/ops", direction: "incoming" },
          ],
        }),
      ],
      attachedKeys: [],
      enabledKeys: ["github:acme/api", "github:acme/web"],
    });
    // Enabled first, then not enabled: the existing marker ranking, so the
    // model reads what it can actually ask for before what it cannot.
    expect(described?.relationships).toEqual([
      "github:acme/api is the backend for github:acme/web (enabled in the catalog)",
      "github:acme/api is deployed by github:acme/ops (not enabled)",
    ]);
  });
});

describe("what every description in the catalog costs together", () => {
  it("keeps a 200 repository catalog under the whole-catalog budget", () => {
    const repositories = Array.from({ length: 200 }, (_, index) => ({
      provider: "github" as const,
      repoPath: `acme/repo-${String(index).padStart(3, "0")}`,
      name: `repo-${index}`,
      defaultBranch: "main",
      description: "short provider blurb",
      topics: [],
      relationships: [],
      usable: true,
    }));
    const described = addRepositoryDiscoveryRelationships({
      catalog: repositories,
      facts: repositories.map((repository) => ({
        key: `${repository.provider}:${repository.repoPath}`,
        // An operator who documents every repository properly. Nothing in the
        // contract forbids it, and the per-repository bound alone allows
        // 192,000 characters, four times what the provider text it replaced
        // could ever cost.
        catalogDescription: "d".repeat(20_000),
      })),
      attachedKeys: [],
      enabledKeys: [],
    });
    const total = described.reduce((sum, entry) => sum + entry.description.length, 0);
    expect(total).toBeLessThanOrEqual(48_000 + 200 * "short provider blurb".length);
    // The ones the budget could not pay for keep the provider's own text and
    // say whose words they are, rather than half an operator's paragraph.
    const fallenBack = described.filter((entry) => entry.descriptionSource === "provider");
    expect(fallenBack.length).toBeGreaterThan(0);
    expect(fallenBack[0]!.description).toBe("short provider blurb");
    expect(described[0]!.descriptionSource).toBe("catalog");
  });
});
