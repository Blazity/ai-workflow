import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  canManageRepositoryCatalog,
  parseRequestBody,
  repositoryCatalogEntrySchema,
  repositoryCatalogKey,
  repositoryCatalogKeyOfRepoPath,
  repositoryCatalogStateSchema,
  repositoryProfileVersionSchema,
} from "@shared/contracts";

const entry = {
  id: 7,
  provider: "github",
  path: "Acme/Api",
  displayName: "Acme API",
  defaultBranch: "main",
  description: "# Acme",
  rules: "never force push",
  relationships: [{ repositoryId: 8, label: "deploys" }],
  enabled: true,
  source: "manual",
  profileVersion: 3,
  createdAt: "2026-09-12T10:00:00.000Z",
  updatedAt: "2026-09-12T10:00:00.000Z",
};

describe("repositoryCatalogEntrySchema", () => {
  it("accepts a full entry", () => {
    expect(parseRequestBody(repositoryCatalogEntrySchema, entry)).toEqual({
      ok: true,
      value: entry,
    });
  });

  it("refuses a path with no slash", () => {
    expect(
      parseRequestBody(repositoryCatalogEntrySchema, { ...entry, path: "api" }),
    ).toEqual({ ok: false, message: 'repository path must look like "owner/name"' });
  });

  it("accepts a nested GitLab group path", () => {
    const nested = { ...entry, provider: "gitlab", path: "acme/group/api" };
    expect(parseRequestBody(repositoryCatalogEntrySchema, nested)).toEqual({
      ok: true,
      value: nested,
    });
  });

  it("refuses an unknown source", () => {
    expect(
      parseRequestBody(repositoryCatalogEntrySchema, { ...entry, source: "guessed" }).ok,
    ).toBe(false);
  });

  it("accepts a row that has no profile yet", () => {
    expect(
      parseRequestBody(repositoryCatalogEntrySchema, { ...entry, profileVersion: 0 }).ok,
    ).toBe(true);
  });
});

describe("repositoryProfileVersionSchema", () => {
  const version = {
    version: 1,
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: { provider: "github", repoPath: "acme/api", groups: {} },
    gateGroups: ["verify"],
    actorId: "migration",
    actorLabel: "migration",
    reason: "script groups migration from pre_pr_check_config_versions",
    createdAt: "2026-09-12T10:00:00.000Z",
  };

  it("accepts a migrated profile", () => {
    expect(parseRequestBody(repositoryProfileVersionSchema, version)).toEqual({
      ok: true,
      value: version,
    });
  });

  it("accepts a profile that configures no scripts", () => {
    expect(
      parseRequestBody(repositoryProfileVersionSchema, {
        ...version,
        scriptGroups: null,
        gateGroups: null,
      }).ok,
    ).toBe(true);
  });

  it("refuses version 0, because a stored profile is always at least 1", () => {
    expect(
      parseRequestBody(repositoryProfileVersionSchema, { ...version, version: 0 }).ok,
    ).toBe(false);
  });
});

describe("repositoryCatalogStateSchema", () => {
  it("carries the bridge alongside the flag it is derived from", () => {
    expect(
      parseRequestBody(repositoryCatalogStateSchema, {
        activated: false,
        bridge: true,
        activatedAt: null,
        activatedById: null,
      }),
    ).toEqual({
      ok: true,
      value: { activated: false, bridge: true, activatedAt: null, activatedById: null },
    });
  });
});

describe("repositoryCatalogKey", () => {
  it("cases the path down so a differently cased row still matches", () => {
    expect(repositoryCatalogKey({ provider: "github", path: "Acme/Api" })).toBe(
      "github:acme/api",
    );
  });

  it("reads the engine spelling of a repository to the same key", () => {
    expect(
      repositoryCatalogKeyOfRepoPath({ provider: "github", repoPath: "Acme/Api" }),
    ).toBe(repositoryCatalogKey({ provider: "github", path: "acme/api" }));
  });

  it("keeps two providers apart", () => {
    expect(repositoryCatalogKey({ provider: "gitlab", path: "acme/api" })).toBe(
      "gitlab:acme/api",
    );
  });
});

describe("canManageRepositoryCatalog", () => {
  it("admits an owner and an admin", () => {
    expect(canManageRepositoryCatalog("owner")).toBe(true);
    expect(canManageRepositoryCatalog("admin")).toBe(true);
  });

  it("refuses a member", () => {
    expect(canManageRepositoryCatalog("member")).toBe(false);
  });
});
