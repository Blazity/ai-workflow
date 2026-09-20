import { describe, expect, it } from "vitest";
import type { WorkScopeEntry } from "@shared/contracts";
import {
  buildRepositoryMap,
  relatedRepositoryKeys,
  repositoryMapTrailSummary,
  type RepositoryMapFacts,
  type RepositoryMapInput,
} from "./map.js";

const API = "github:acme/api";
const WEB = "github:acme/web";
const OPS = "github:acme/ops";
const DOCS = "github:acme/docs";

const PERSON = { kind: "person", actorId: "u1", actorLabel: "Ada" } as const;

function entry(over: Partial<WorkScopeEntry> & { repositoryKey: string }): WorkScopeEntry {
  return {
    state: "selected",
    origin: "person",
    rationale: "chosen",
    decidedBy: PERSON,
    decidedAt: "2026-09-01T10:00:00.000Z",
    ...over,
  } as WorkScopeEntry;
}

function facts(over: Partial<RepositoryMapFacts> & { key: string }): RepositoryMapFacts {
  return { enabled: true, usable: true, ...over };
}

/** A ticket that names api, where the catalog says api is the backend for web. */
function neighbourhood(over: Partial<RepositoryMapInput> = {}): RepositoryMapInput {
  return {
    repositories: [
      facts({
        key: API,
        catalogDescription:
          "The payments API. It owns the ledger and the webhook fan-out, and every money movement goes through it.",
        relationships: [{ kind: "backend_for", targetKey: WEB, direction: "outgoing" }],
      }),
      facts({
        key: WEB,
        catalogDescription: "The customer dashboard. Checkout and the invoice screens live here.",
        providerDescription: "acme web app",
      }),
      facts({ key: DOCS, catalogDescription: "The developer docs site." }),
    ],
    attached: [{ key: API, localPath: "/vercel/sandbox", access: "write", rationale: "The ticket text names this repository path." }],
    namedKeys: [API],
    catalogActivated: true,
    ...over,
  };
}

describe("buildRepositoryMap", () => {
  it("gives the neighbour of a named repository a full entry naming the source and the relationship", () => {
    const map = buildRepositoryMap(neighbourhood());
    const web = map.repositories.find((repository) => repository.key === WEB);
    expect(web?.rendering).toBe("full");
    expect(web?.inclusion).toEqual({
      cause: "related",
      via: { key: API, relationship: "backend_for", direction: "outgoing" },
    });
    expect(map.text).toContain(
      "Why it is here: `github:acme/api` is the backend for `github:acme/web`.",
    );
  });

  it("describes a repository in the operator's own words", () => {
    const map = buildRepositoryMap(neighbourhood());
    expect(map.text).toContain(
      "What it is: The customer dashboard. Checkout and the invoice screens live here.",
    );
    expect(map.text).not.toContain("acme web app");
    expect(map.repositories.find((repository) => repository.key === WEB)?.description.source).toBe(
      "catalog",
    );
  });

  it("falls back to the provider's listing text and labels it as the provider's", () => {
    const map = buildRepositoryMap(
      neighbourhood({
        repositories: [
          facts({ key: API, relationships: [{ kind: "backend_for", targetKey: WEB, direction: "outgoing" }] }),
          facts({ key: WEB, providerDescription: "acme web app" }),
        ],
      }),
    );
    expect(map.text).toContain(
      "What it is: acme web app (the provider's own listing text; nobody here wrote a description)",
    );
    expect(map.repositories.find((repository) => repository.key === WEB)?.description.source).toBe(
      "provider",
    );
  });

  it("shows a repository a person excluded as excluded, with the record's own sentence", () => {
    const map = buildRepositoryMap(
      neighbourhood({
        entries: [entry({ repositoryKey: WEB, state: "excluded" })],
        leftOut: [{ repositoryKey: WEB, reason: "Ada excluded github:acme/web on 1 September." }],
      }),
    );
    const web = map.repositories.find((repository) => repository.key === WEB);
    expect(web?.state).toBe("excluded");
    expect(web?.reason).toBe("Ada excluded github:acme/web on 1 September.");
    expect(map.text).toContain(
      "a person left it out of this work, do not request it: Ada excluded github:acme/web on 1 September.",
    );
  });

  it("marks a disabled, a not-enabled and an unusable repository do not request, each with its own reason", () => {
    const map = buildRepositoryMap(
      neighbourhood({
        repositories: [
          facts({ key: API, relationships: [{ kind: "backend_for", targetKey: WEB, direction: "outgoing" }] }),
          facts({ key: WEB, enabled: false }),
          facts({ key: OPS, enabled: true, usable: false }),
          facts({ key: DOCS, enabled: undefined, usable: undefined }),
        ],
        entries: [
          entry({ repositoryKey: DOCS, state: "unavailable", unavailableReason: "not_enabled" }),
        ],
      }),
    );
    const state = (key: string) => map.repositories.find((repository) => repository.key === key);
    expect(state(WEB)?.state).toBe("disabled");
    expect(state(OPS)?.state).toBe("unusable");
    expect(state(DOCS)?.state).toBe("not_enabled");
    expect(map.text).toContain("switched off in the repository catalog, do not request it");
    expect(map.text).toContain(
      "enabled here, but the provider offers nothing to check out, do not request it",
    );
    expect(map.text).toContain("nobody has enabled it, do not request it");
    for (const key of [WEB, OPS, DOCS]) {
      expect(state(key)?.reason ?? "").not.toBe("");
    }
  });

  it("renders byte-identical text for the same input twice", () => {
    expect(buildRepositoryMap(neighbourhood()).text).toBe(
      buildRepositoryMap(neighbourhood()).text,
    );
  });

  it("does not depend on the order the catalog happens to arrive in", () => {
    const forwards = neighbourhood();
    const backwards = neighbourhood({
      repositories: [...(forwards.repositories ?? [])].reverse(),
    });
    expect(buildRepositoryMap(backwards).text).toBe(buildRepositoryMap(forwards).text);
  });

  it("explains a relationship whose target this run's catalog does not hold, instead of dropping it", () => {
    const map = buildRepositoryMap(
      neighbourhood({
        repositories: [
          facts({
            key: API,
            relationships: [{ kind: "depends_on", targetKey: "github:acme/gone", direction: "outgoing" }],
          }),
        ],
        attached: [{ key: API, localPath: "/vercel/sandbox", access: "write" }],
      }),
    );
    // The edge is rendered, AND the repository it points at gets its own entry
    // saying why it cannot be used. Dropping either would teach the agent that
    // the neighbourhood is smaller than the operator said it is.
    expect(map.text).toContain("It depends on a package published from `github:acme/gone`.");
    const gone = map.repositories.find((repository) => repository.key === "github:acme/gone");
    expect(gone?.state).toBe("outside_catalog");
    expect(gone?.reason).toBe("github:acme/gone is not in the catalog this run may use.");
    expect(map.text).toContain(
      "- `github:acme/gone` - outside the catalog this run may use, do not request it",
    );
  });

  it("marks a relationship whose target nothing in this run describes", () => {
    // The neighbourhood is ONE hop, so a neighbour's own edge to a third
    // repository reaches nothing this map describes. The edge is still the
    // operator's statement, so it is rendered and the gap is named rather than
    // silently dropped, which would teach the agent that the neighbourhood is
    // smaller than the operator said it is.
    const map = buildRepositoryMap({
      repositories: [
        facts({
          key: API,
          relationships: [{ kind: "frontend_for", targetKey: WEB, direction: "outgoing" }],
        }),
        facts({
          key: WEB,
          relationships: [
            { kind: "deploys", targetKey: "github:acme/unknown", direction: "outgoing" },
          ],
        }),
      ],
      attached: [{ key: API, access: "write" }],
      catalogActivated: true,
    });
    expect(map.text).toContain(
      "It deploys `github:acme/unknown` (we do not know this repository on this run)",
    );
  });

  it("gives a settled repository a line and a reason, never a full entry", () => {
    // A settled repository cannot be acted on, so its relationships and its
    // description would be prompt spent on a decision already made. What it
    // must carry is the reason, on the line, where the model reads it.
    const map = buildRepositoryMap(
      neighbourhood({
        repositories: [
          facts({ key: API }),
          facts({
            key: OPS,
            catalogDescription: "The deployment pipelines.",
            relationships: [{ kind: "deploys", targetKey: API, direction: "outgoing" }],
          }),
        ],
        entries: [entry({ repositoryKey: OPS, state: "excluded" })],
      }),
    );
    const ops = map.repositories.find((repository) => repository.key === OPS);
    expect(ops?.rendering).toBe("line");
    expect(map.text).toContain(
      "- `github:acme/ops` - a person left it out of this work, do not request it",
    );
    expect(map.text).not.toContain("How it relates:");
    // The structured entry still carries the relationship: the prompt drops a
    // detail, the record does not lose a fact.
    expect(ops?.relationships).toHaveLength(1);
  });

  it("counts the relationships whose other end is gone from the catalog", () => {
    const map = buildRepositoryMap(
      neighbourhood({
        repositories: [facts({ key: API, unknownRelationshipCount: 2 })],
        attached: [{ key: API, access: "write" }],
      }),
    );
    expect(map.text).toContain(
      "2 recorded relationships point at a repository that is no longer in the catalog",
    );
  });

  it("says the relationships could not be read instead of showing none", () => {
    const map = buildRepositoryMap(
      neighbourhood({
        repositories: [facts({ key: API }), facts({ key: WEB })],
        relationshipsUnreadable: true,
      }),
    );
    expect(map.text).toContain(
      "The repository relationships could not be read for this run, so no repository below lists any. Do not read that as these repositories being unrelated.",
    );
    expect(map.notes).toHaveLength(1);
  });

  it("says the map was not available rather than rendering an empty catalog", () => {
    const map = buildRepositoryMap({
      silence: "not_recorded",
      attached: [{ key: API, localPath: "/vercel/sandbox", access: "write" }],
    });
    expect(map.text).toContain("The repository map was not available for this send");
    expect(map.text).toContain("`github:acme/api`");
  });

  it("reads a relationship from the side the catalog recorded it on", () => {
    // The catalog stores one edge and two sentences for it. Read forwards, an
    // incoming edge says the opposite of what the operator recorded: that the
    // API holds the tests for the e2e suite, rather than the other way round.
    const map = buildRepositoryMap(
      neighbourhood({
        repositories: [
          facts({
            key: API,
            relationships: [
              { kind: "tests", targetKey: "github:acme/api-e2e", direction: "incoming" },
            ],
          }),
          facts({ key: "github:acme/api-e2e" }),
        ],
      }),
    );
    expect(map.text).toContain("It is tested by `github:acme/api-e2e`.");
    expect(map.text).not.toContain("It holds tests or fixtures for `github:acme/api-e2e`");
    expect(map.text).toContain(
      "Why it is here: `github:acme/api` is tested by `github:acme/api-e2e`.",
    );
  });

  it("renders an unknown relationship kind as itself", () => {
    const map = buildRepositoryMap(
      neighbourhood({
        repositories: [
          facts({
            key: API,
            relationships: [{ kind: "vendors_for" as never, targetKey: WEB, direction: "outgoing" }],
          }),
          facts({ key: WEB }),
        ],
      }),
    );
    expect(map.text).toContain("is recorded as `vendors_for` of `github:acme/web`");
  });

  it("shows a read-only attachment as read only", () => {
    const map = buildRepositoryMap(
      neighbourhood({
        attached: [
          { key: API, localPath: "/a", access: "write" },
          { key: WEB, localPath: "/b", access: "read_only", rationale: "Related to github:acme/api" },
        ],
      }),
    );
    expect(map.text).toContain("- `github:acme/web` at `/b` (read only)");
    expect(map.repositories.find((repository) => repository.key === WEB)?.state).toBe("read_only");
  });

  describe("bounds", () => {
    /** One repository wired to 150 neighbours, each carrying a 5 KB description:
     *  the shape the contract allows and nothing in the catalog forbids. */
    const wideNeighbourhood = (): RepositoryMapInput => {
      const neighbours = Array.from({ length: 150 }, (_, index) => {
        const key = `github:acme/neighbour-${String(index).padStart(3, "0")}`;
        return facts({ key, catalogDescription: "x".repeat(5 * 1024) });
      });
      return {
        repositories: [
          facts({
            key: API,
            catalogDescription: "y".repeat(5 * 1024),
            relationships: neighbours.map((neighbour) => ({
              kind: "depends_on" as const,
              targetKey: neighbour.key,
              direction: "outgoing" as const,
            })),
          }),
          ...neighbours,
        ],
        attached: [{ key: API, localPath: "/vercel/sandbox", access: "write" }],
        namedKeys: [API],
        catalogActivated: true,
      };
    };

    it("stays far under the prompt section cap and still names the neighbourhood", () => {
      const map = buildRepositoryMap(wideNeighbourhood());
      expect(map.text.length).toBeLessThanOrEqual(16_000);
      expect(map.text).toContain("`github:acme/api`");
      expect(map.text).toContain("`github:acme/neighbour-000`");
      expect(map.unlistedCount).toBeGreaterThan(0);
      expect(map.text).toContain("Ask for one by its exact provider:path.");
    });

    it("never lets one description spend the whole budget", () => {
      const map = buildRepositoryMap(wideNeighbourhood());
      for (const repository of map.repositories) {
        expect(repository.description.text.length).toBeLessThanOrEqual(280);
      }
    });

    it("keeps every settled repository even when the neighbourhood is huge", () => {
      const wide = wideNeighbourhood();
      const map = buildRepositoryMap({
        ...wide,
        entries: [entry({ repositoryKey: OPS, state: "excluded" })],
        leftOut: [{ repositoryKey: OPS, reason: "Ada excluded github:acme/ops." }],
      });
      expect(map.text).toContain("github:acme/ops");
      expect(map.text).toContain("Ada excluded github:acme/ops.");
      expect(map.unlistedKeys).not.toContain(OPS);
    });
  });
});

describe("relatedRepositoryKeys", () => {
  it("returns one hop in either direction and never the seeds themselves", () => {
    const repositories = [
      facts({ key: API, relationships: [{ kind: "backend_for", targetKey: WEB, direction: "outgoing" }] }),
      facts({ key: OPS, relationships: [{ kind: "deploys", targetKey: API, direction: "outgoing" }] }),
      facts({ key: DOCS, relationships: [{ kind: "documents", targetKey: WEB, direction: "outgoing" }] }),
    ];
    expect(relatedRepositoryKeys(repositories, [API])).toEqual([OPS, WEB]);
  });

  it("stops at one hop", () => {
    const repositories = [
      facts({ key: API, relationships: [{ kind: "backend_for", targetKey: WEB, direction: "outgoing" }] }),
      facts({ key: WEB, relationships: [{ kind: "documents", targetKey: DOCS, direction: "outgoing" }] }),
    ];
    expect(relatedRepositoryKeys(repositories, [API])).toEqual([WEB]);
  });
});

describe("a workspace the budget pushed onto one line each", () => {
  /** Two checkouts and almost no room: the first gets a full entry, the rest
   *  fall to a line. */
  const cramped = () =>
    buildRepositoryMap(
      neighbourhood({
        repositories: [facts({ key: API }), facts({ key: WEB })],
        attached: [
          { key: API, localPath: "/vercel/sandbox/repos/github__acme__api", access: "write" },
          { key: WEB, localPath: "/vercel/sandbox/repos/github__acme__web", access: "read_only" },
        ],
      }),
      { maxLength: 400 },
    );

  it("still says where each one is and what may be done to it", () => {
    // A repository the budget shortened used to read as a bare key: no path to
    // look in, and nothing saying whether it may be written to. An agent
    // standing in a checkout it cannot name, beside one it must not change,
    // is how a read-only repository gets written to.
    const map = cramped();
    const web = map.repositories.find((repository) => repository.key === WEB);
    expect(web?.rendering).toBe("line");
    expect(map.text).toContain(
      `- \`${WEB}\` at \`/vercel/sandbox/repos/github__acme__web\` (read only)`,
    );
    expect(map.text).toContain(`- \`${API}\` at \`/vercel/sandbox/repos/github__acme__api\` (write)`);
  });
});

describe("repositoryMapTrailSummary", () => {
  it("summarizes the same build inside the trail's own bound", () => {
    const map = buildRepositoryMap(neighbourhood());
    const summary = repositoryMapTrailSummary(map);
    expect(summary.text.length).toBeLessThanOrEqual(1600);
    expect(summary.text).toContain(`${API}: write`);
    expect(summary.repositoryKeys).toEqual(map.repositories.map((repository) => repository.key));
  });

  it("stays inside the bound and says how many it left out on a large catalog", () => {
    const map = buildRepositoryMap({
      repositories: Array.from({ length: 400 }, (_, index) =>
        facts({ key: `github:acme/repo-${String(index).padStart(3, "0")}` }),
      ),
      attached: [],
      catalogActivated: true,
    });
    const summary = repositoryMapTrailSummary(map);
    expect(summary.text.length).toBeLessThanOrEqual(1600);
    expect(summary.text).toMatch(/\nand \d+ more$/);
  });
});
