import { describe, expect, it } from "vitest";
import {
  filterPinnedRepositories,
  isRepositoryWithinPinnedScope,
} from "./repository-directory.js";

/**
 * Fetching a listing left with the providers in S10 and S11, so what is left to
 * test here is the one thing core still decides about one: whether a repository
 * survives the scope a workflow pinned. The provider id is an open registry
 * value, so the case that matters is one this build has never heard of.
 */
describe("pinned repository scope", () => {
  it("filters an open provider id through the stored scope", () => {
    const repositories = [
      { provider: "forgejo", repoPath: "acme/api" },
      { provider: "github", repoPath: "acme/web" },
    ];
    const scope = { providers: ["forgejo"] };
    expect(filterPinnedRepositories(repositories, scope)).toEqual([repositories[0]]);
    expect(isRepositoryWithinPinnedScope(scope, repositories[0]!)).toBe(true);
    expect(isRepositoryWithinPinnedScope(scope, repositories[1]!)).toBe(false);
  });
});
