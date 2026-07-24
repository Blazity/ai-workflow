import { describe, expect, it } from "vitest";
import type { RepositoryMetadata } from "../adapters/vcs/repository-directory.js";
import {
  MAX_ACCESSIBLE_REPOSITORIES,
  RepositoryCatalogError,
  buildRepositoryCatalog,
  buildRepositoryCatalogEntries,
} from "./catalog.js";

function repository(
  overrides: Partial<RepositoryMetadata> = {},
): RepositoryMetadata {
  return {
    provider: "github",
    repoPath: "acme/app",
    name: "app",
    owner: "acme",
    defaultBranch: "main",
    description: "Application",
    webUrl: "https://github.com/acme/app",
    topics: [],
    archived: false,
    private: true,
    ...overrides,
  };
}

describe("buildRepositoryCatalog", () => {
  it("normalizes deterministic order and excludes archived repositories", () => {
    const catalog = buildRepositoryCatalog([
      repository({ provider: "gitlab", repoPath: "group/team/z", name: "z" }),
      repository({ repoPath: "acme/old", archived: true }),
      repository({ repoPath: "Acme/A", name: "A" }),
    ]);

    expect(catalog.map((entry) => `${entry.provider}:${entry.repoPath}`)).toEqual([
      "github:Acme/A",
      "gitlab:group/team/z",
    ]);
  });

  it("bounds untrusted metadata included in discovery prompts", () => {
    const [entry] = buildRepositoryCatalog([
      repository({
        description: "x".repeat(500),
        topics: Array.from({ length: 20 }, (_, index) => `topic-${index}-${"y".repeat(80)}`),
      }),
    ]);

    expect(entry.description).toHaveLength(240);
    expect(entry.topics).toHaveLength(8);
    expect(entry.topics.every((topic) => topic.length <= 40)).toBe(true);
  });

  it("marks repositories without a usable default branch as uninitialized", () => {
    expect(buildRepositoryCatalog([repository({ defaultBranch: "" })])[0]).toMatchObject({
      usable: false,
      unusableReason: "missing_default_branch",
    });
  });

  it("rejects provider-invalid repository paths", () => {
    expect(() =>
      buildRepositoryCatalog([
        repository({ provider: "github", repoPath: "group/team/repo" }),
      ]),
    ).toThrow(RepositoryCatalogError);
    expect(() =>
      buildRepositoryCatalog([
        repository({ provider: "gitlab", repoPath: "repo-only" }),
      ]),
    ).toThrow(RepositoryCatalogError);
  });

  it("fails closed on a case-insensitive provider-scoped key collision", () => {
    expect(() =>
      buildRepositoryCatalog([
        repository({ provider: "gitlab", repoPath: "group/Repo", name: "Repo" }),
        repository({ provider: "gitlab", repoPath: "group/repo", name: "repo" }),
      ]),
    ).toThrow(RepositoryCatalogError);
    try {
      buildRepositoryCatalog([
        repository({ provider: "gitlab", repoPath: "group/Repo", name: "Repo" }),
        repository({ provider: "gitlab", repoPath: "group/repo", name: "repo" }),
      ]);
    } catch (error) {
      expect((error as RepositoryCatalogError).code).toBe("catalog_case_collision");
    }
  });

  it("fails closed instead of truncating catalogs above 200 entries", () => {
    const repositories = Array.from(
      { length: MAX_ACCESSIBLE_REPOSITORIES + 1 },
      (_, index) => repository({ repoPath: `acme/repo-${index}` }),
    );

    expect(() => buildRepositoryCatalog(repositories)).toThrow(
      "Accessible repository catalog exceeds 200 entries",
    );
  });
});

describe("buildRepositoryCatalogEntries", () => {
  it("returns entries above the limit without failing closed", () => {
    const repositories = Array.from(
      { length: MAX_ACCESSIBLE_REPOSITORIES + 1 },
      (_, index) => repository({ repoPath: `acme/repo-${index}` }),
    );

    expect(buildRepositoryCatalogEntries(repositories)).toHaveLength(
      MAX_ACCESSIBLE_REPOSITORIES + 1,
    );
  });

  it("shares usability and ordering semantics with the bounded catalog", () => {
    const repositories = [
      repository({ provider: "gitlab", repoPath: "group/team/z", name: "z" }),
      repository({ repoPath: "acme/old", archived: true }),
      repository({ repoPath: "Acme/A", name: "A" }),
      repository({ repoPath: "acme/empty", defaultBranch: "" }),
    ];

    expect(buildRepositoryCatalogEntries(repositories)).toEqual(
      buildRepositoryCatalog(repositories),
    );
  });

  it("still rejects provider-invalid repository paths", () => {
    expect(() =>
      buildRepositoryCatalogEntries([
        repository({ provider: "github", repoPath: "group/team/repo" }),
      ]),
    ).toThrow(RepositoryCatalogError);
  });

  it("also fails closed on a case-insensitive key collision", () => {
    expect(() =>
      buildRepositoryCatalogEntries([
        repository({ provider: "gitlab", repoPath: "group/Repo" }),
        repository({ provider: "gitlab", repoPath: "group/repo" }),
      ]),
    ).toThrow(RepositoryCatalogError);
  });
});
