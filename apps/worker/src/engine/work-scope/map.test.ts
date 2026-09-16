import type { RepositoryRelationshipKind } from "@shared/contracts";
import { describe, expect, it } from "vitest";
import { renderRepositoryMap } from "./map.js";

function repository(
  key: string,
  description = "",
  relationships: Array<{ kind: RepositoryRelationshipKind; targetKey: string }> = [],
  asksFirst = false,
) {
  return { key, description, relationships, asksFirst };
}

function numbered(count: number, description: (index: string) => string) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return repository(`github:acme/repo-${suffix}`, description(suffix));
  });
}

const noSignals = { attachedKeys: [], ticketText: "", scopeKeys: [] };

describe("renderRepositoryMap", () => {
  it("lists every repository when the catalog holds twenty", () => {
    const map = renderRepositoryMap({
      ...noSignals,
      repositories: numbered(20, (suffix) => `Service ${suffix}.`),
    });

    const lines = map.text.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("- github:acme/repo-01: Service 01.");
    expect(lines[19]).toBe("- github:acme/repo-20: Service 20.");
    expect(map.repositoryKeys).toHaveLength(20);
    expect(map.text).not.toContain("more repositories");
  });

  it("lists twelve of forty repositories and says how many more may be requested", () => {
    const map = renderRepositoryMap({
      ...noSignals,
      repositories: numbered(40, (suffix) => `Service ${suffix}.`),
    });

    const lines = map.text.split("\n");
    expect(lines).toHaveLength(13);
    expect(lines[11]).toBe("- github:acme/repo-12: Service 12.");
    expect(lines[12]).toBe(
      "28 more repositories may be requested; ask for the rest of the map to see them.",
    );
    expect(map.repositoryKeys).toEqual([
      "github:acme/repo-01",
      "github:acme/repo-02",
      "github:acme/repo-03",
      "github:acme/repo-04",
      "github:acme/repo-05",
      "github:acme/repo-06",
      "github:acme/repo-07",
      "github:acme/repo-08",
      "github:acme/repo-09",
      "github:acme/repo-10",
      "github:acme/repo-11",
      "github:acme/repo-12",
    ]);
  });

  it("ranks a one hop neighbour of an attached repository above a two hop one", () => {
    const map = renderRepositoryMap({
      attachedKeys: ["github:acme/web"],
      ticketText: "",
      scopeKeys: [],
      repositories: [
        repository("github:acme/web"),
        repository("github:acme/aaa-two-hop", "", [{ kind: "depends_on", targetKey: "github:acme/zzz-one-hop" }]),
        repository("github:acme/zzz-one-hop", "", [{ kind: "backend_for", targetKey: "github:acme/web" }]),
      ],
    });

    expect(map.repositoryKeys).toEqual(["github:acme/zzz-one-hop", "github:acme/aaa-two-hop"]);
  });

  it("ranks a relationship neighbour above a repository the ticket text matches", () => {
    const map = renderRepositoryMap({
      attachedKeys: ["github:acme/web"],
      ticketText: "Fix the billing export",
      scopeKeys: [],
      repositories: [
        repository("github:acme/aaa-billing"),
        // Only the attached repository's side names the relationship.
        repository("github:acme/web", "", [{ kind: "calls", targetKey: "github:acme/zzz-neighbour" }]),
        repository("github:acme/zzz-neighbour"),
      ],
    });

    expect(map.repositoryKeys).toEqual(["github:acme/zzz-neighbour", "github:acme/aaa-billing"]);
  });

  it("ranks a repository with more ticket word matches first, above one the scope holds", () => {
    const map = renderRepositoryMap({
      attachedKeys: [],
      ticketText: "Fix the billing webhook retries",
      scopeKeys: ["github:acme/aaa-scoped"],
      repositories: [
        repository("github:acme/aaa-scoped", "Holds shared fixtures."),
        repository("github:acme/billing-service", "Invoices customers."),
        repository("github:acme/notify", "Sends webhook retries to partners."),
      ],
    });

    expect(map.repositoryKeys).toEqual([
      "github:acme/notify",
      "github:acme/billing-service",
      "github:acme/aaa-scoped",
    ]);
  });

  it("ignores ticket words shorter than four characters", () => {
    const map = renderRepositoryMap({
      attachedKeys: [],
      ticketText: "fix the api",
      scopeKeys: [],
      repositories: [repository("github:acme/aaa"), repository("github:acme/api")],
    });

    expect(map.repositoryKeys).toEqual(["github:acme/aaa", "github:acme/api"]);
  });

  it("ranks a repository the scope holds above the rest", () => {
    const map = renderRepositoryMap({
      attachedKeys: [],
      ticketText: "",
      scopeKeys: ["gitlab:acme/zzz"],
      repositories: [repository("github:acme/aaa"), repository("gitlab:acme/zzz")],
    });

    expect(map.repositoryKeys).toEqual(["gitlab:acme/zzz", "github:acme/aaa"]);
  });

  it("breaks ties by key ascending", () => {
    const map = renderRepositoryMap({
      attachedKeys: [],
      ticketText: "",
      scopeKeys: [],
      repositories: [
        repository("gitlab:acme/api"),
        repository("github:acme/web"),
        repository("github:acme/api"),
      ],
    });

    expect(map.repositoryKeys).toEqual(["github:acme/api", "github:acme/web", "gitlab:acme/api"]);
  });

  it("drops lines from the bottom to stay within 1600 characters and counts them", () => {
    const map = renderRepositoryMap({
      ...noSignals,
      repositories: numbered(20, () => "A".repeat(120)),
    });

    const lines = map.text.split("\n");
    expect(map.text.length).toBe(1519);
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe(`- github:acme/repo-10: ${"A".repeat(120)}`);
    expect(lines[10]).toBe(
      "10 more repositories may be requested; ask for the rest of the map to see them.",
    );
    expect(map.repositoryKeys).toHaveLength(10);
    expect(map.repositoryKeys[9]).toBe("github:acme/repo-10");
  });

  it("drops a bottom line that alone exceeds the bound and names one more repository", () => {
    const attachedKeys = Array.from({ length: 60 }, (_, index) => `github:acme/attached-${index}`);
    const map = renderRepositoryMap({
      attachedKeys,
      ticketText: "",
      scopeKeys: [],
      repositories: [
        repository("github:acme/aaa", "Small.", [
          { kind: "related_to", targetKey: "github:acme/attached-0" },
        ]),
        repository(
          "github:acme/bbb",
          "",
          attachedKeys.map((targetKey) => ({ kind: "related_to" as const, targetKey })),
        ),
      ],
    });

    expect(map.text).toBe(
      "- github:acme/aaa: Small. (related: related_to github:acme/attached-0)\n" +
        "1 more repository may be requested; ask for the rest of the map to see them.",
    );
    expect(map.repositoryKeys).toEqual(["github:acme/aaa"]);
  });

  it("cuts a 300 character description at 120 characters", () => {
    const map = renderRepositoryMap({
      ...noSignals,
      repositories: [repository("github:acme/api", "abcdefghij".repeat(30))],
    });

    expect(map.text).toBe(`- github:acme/api: ${"abcdefghij".repeat(12)}`);
  });

  it("renders the first sentence with whitespace collapsed and the relationships to attached repositories", () => {
    const map = renderRepositoryMap({
      attachedKeys: ["github:acme/web", "github:acme/db"],
      ticketText: "",
      scopeKeys: [],
      repositories: [
        repository("github:acme/api", "  The public\n\n  API.  Also handles refunds.", [
          { kind: "backend_for", targetKey: "github:acme/web" },
          { kind: "calls", targetKey: "github:acme/billing" },
          { kind: "shares_schema_with", targetKey: "github:acme/db" },
        ]),
      ],
    });

    expect(map.text).toBe(
      "- github:acme/api: The public API. (related: backend_for github:acme/web, shares_schema_with github:acme/db)",
    );
  });

  it("never lists an attached repository", () => {
    const map = renderRepositoryMap({
      attachedKeys: ["github:acme/web"],
      ticketText: "web frontend",
      scopeKeys: ["github:acme/web"],
      repositories: [
        repository("github:acme/web", "The web frontend."),
        repository("github:acme/api", "The API.", [{ kind: "backend_for", targetKey: "github:acme/web" }]),
      ],
    });

    expect(map.repositoryKeys).toEqual(["github:acme/api"]);
    expect(map.text).toBe(
      "- github:acme/api: The API. (related: backend_for github:acme/web)",
    );
  });

  it("marks a repository a request asks a person about first", () => {
    const map = renderRepositoryMap({
      ...noSignals,
      repositories: [
        repository("github:acme/api", "The API.", [], true),
        repository("github:acme/web", "The web frontend."),
      ],
    });

    expect(map.text).toBe(
      "- github:acme/api: The API. (asks first)\n- github:acme/web: The web frontend.",
    );
  });

  it("never lists a key the caller left out, which is how a blocking entry stays out of the map", () => {
    const map = renderRepositoryMap({
      ...noSignals,
      repositories: [repository("github:acme/api", "The API.", [], true)],
    });

    expect(map.repositoryKeys).toEqual(["github:acme/api"]);
    expect(map.text).not.toContain("github:acme/excluded");
  });

  it("keeps the ranking and the 1600 character bound when every line is marked", () => {
    const map = renderRepositoryMap({
      ...noSignals,
      repositories: numbered(20, () => "A".repeat(120)).map((entry) => ({
        ...entry,
        asksFirst: true,
      })),
    });

    const lines = map.text.split("\n");
    expect(map.text.length).toBe(1492);
    expect(lines).toHaveLength(10);
    expect(lines[8]).toBe(`- github:acme/repo-09: ${"A".repeat(120)} (asks first)`);
    expect(lines[9]).toBe(
      "11 more repositories may be requested; ask for the rest of the map to see them.",
    );
    expect(map.repositoryKeys).toEqual([
      "github:acme/repo-01",
      "github:acme/repo-02",
      "github:acme/repo-03",
      "github:acme/repo-04",
      "github:acme/repo-05",
      "github:acme/repo-06",
      "github:acme/repo-07",
      "github:acme/repo-08",
      "github:acme/repo-09",
    ]);
  });

  it("renders identical text for the same input twice", () => {
    const input = {
      attachedKeys: ["github:acme/web"],
      ticketText: "Fix the billing webhook retries",
      scopeKeys: ["github:acme/repo-07"],
      repositories: [
        ...numbered(30, (suffix) => `Service ${suffix} for billing.`),
        repository("github:acme/web", "", [{ kind: "calls", targetKey: "github:acme/repo-30" }]),
      ],
    };

    expect(renderRepositoryMap(input)).toEqual(renderRepositoryMap(input));
  });
});
