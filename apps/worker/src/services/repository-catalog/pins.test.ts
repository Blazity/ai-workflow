// apps/worker/src/services/repository-catalog/pins.test.ts
//
// One function answers "which pins does the catalog not enable", and three
// surfaces read it: the MCP draft reply, the MCP publish announcement and the
// REST deploy response. What this file protects is that the answer does not
// depend on which of them asked.
import { describe, expect, it } from "vitest";
import {
  activatedRepositoryCatalog,
  unactivatedRepositoryCatalog,
} from "../../test-support/repository-catalog.js";
import { pinnedRepositoriesNotEnabled } from "./pins.js";

const pinning = (...repositories: Array<{ provider: string; repoPath: string }>) => ({
  repositoryScope: { repositories },
});

describe("pinnedRepositoriesNotEnabled", () => {
  it("reports nothing while the catalog is not activated", () => {
    // The bridge enables everything, so a field named "not enabled in the
    // catalog" must not accuse a catalog that is refusing nobody.
    expect(
      pinnedRepositoriesNotEnabled(
        pinning({ provider: "github", repoPath: "acme/api" }),
        unactivatedRepositoryCatalog(),
      ),
    ).toEqual([]);
  });

  it("names the pins the enabled list does not carry, and only those", () => {
    expect(
      pinnedRepositoriesNotEnabled(
        pinning(
          { provider: "github", repoPath: "Acme/Api" },
          { provider: "github", repoPath: "acme/web" },
          { provider: "gitlab", repoPath: "acme/api" },
        ),
        activatedRepositoryCatalog(["github:acme/api"]),
      ),
    ).toEqual(["github:acme/web", "gitlab:acme/api"]);
  });

  it("reports a pin whose provider is not a provider rather than passing it", () => {
    // The MCP draft path composes its reply before the schema has run, so a
    // graph with a nonsense provider still reaches here. There is no enabled
    // row such a pin could match, so it is reported, not skipped.
    expect(
      pinnedRepositoriesNotEnabled(
        pinning({ provider: "svn", repoPath: "acme/api" }),
        activatedRepositoryCatalog(["github:acme/api"]),
      ),
    ).toEqual(["svn:acme/api"]);
  });

  it("answers empty for a graph with no scope, and for one that is not a graph", () => {
    const catalog = activatedRepositoryCatalog([]);
    expect(pinnedRepositoriesNotEnabled({}, catalog)).toEqual([]);
    expect(pinnedRepositoriesNotEnabled(null, catalog)).toEqual([]);
    expect(pinnedRepositoriesNotEnabled({ repositoryScope: {} }, catalog)).toEqual([]);
  });
});
