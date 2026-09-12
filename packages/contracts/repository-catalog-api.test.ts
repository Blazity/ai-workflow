import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  parseRequestBody,
  repositoryCatalogActivateRequestSchema,
  repositoryCatalogEnabledRequestSchema,
  repositoryCatalogImportPreviewRequestSchema,
  repositoryCatalogImportRequestSchema,
  repositoryCatalogSuggestRequestSchema,
  repositoryCatalogUpsertRequestSchema,
} from "@shared/contracts";

describe("repositoryCatalogUpsertRequestSchema", () => {
  it("fills every optional field so a minimal body still describes a profile", () => {
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
      }),
    ).toEqual({
      ok: true,
      value: {
        provider: "github",
        path: "acme/api",
        description: "",
        rules: "",
        relationships: [],
        scriptGroups: null,
        gateGroups: null,
        reason: "",
      },
    });
  });

  it("keeps the submitted script groups entry verbatim", () => {
    const scriptGroups = {
      provider: "github",
      repoPath: "acme/api",
      groups: { test: { commands: ["pnpm test"] } },
    };
    const parsed = parseRequestBody(repositoryCatalogUpsertRequestSchema, {
      provider: "github",
      path: "acme/api",
      scriptGroups,
      gateGroups: ["test"],
      reason: "first profile",
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: { scriptGroups, gateGroups: ["test"], reason: "first profile" },
    });
  });

  it("refuses an unknown field rather than storing it", () => {
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        colour: "blue",
      }).ok,
    ).toBe(false);
  });

  it("takes enabled, and defaults it to nothing rather than to a grant", () => {
    const granting = parseRequestBody(repositoryCatalogUpsertRequestSchema, {
      provider: "github",
      path: "acme/api",
      enabled: true,
    });
    expect(granting.ok && granting.value.enabled).toBe(true);
    const silent = parseRequestBody(repositoryCatalogUpsertRequestSchema, {
      provider: "github",
      path: "acme/api",
    });
    // Absent, not false: the service turns absence into "do not grant", and the
    // contract does not pretend the caller made a decision it never made.
    expect(silent.ok && silent.value.enabled).toBe(undefined);
  });

  it("refuses a provider the worker cannot talk to", () => {
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "bitbucket",
        path: "acme/api",
      }).ok,
    ).toBe(false);
  });

  it("refuses a path that is not owner/name", () => {
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "api",
      }),
    ).toEqual({ ok: false, message: 'repository path must look like "owner/name"' });
  });
});

describe("repositoryCatalogEnabledRequestSchema", () => {
  it("accepts a boolean", () => {
    expect(
      parseRequestBody(repositoryCatalogEnabledRequestSchema, { enabled: false }),
    ).toEqual({ ok: true, value: { enabled: false } });
  });

  it("refuses a string, which is how a checkbox posted by hand arrives", () => {
    expect(
      parseRequestBody(repositoryCatalogEnabledRequestSchema, { enabled: "false" }),
    ).toEqual({ ok: false, message: "enabled must be a boolean" });
  });
});

describe("repositoryCatalogActivateRequestSchema", () => {
  it("defaults the acknowledged list to empty", () => {
    expect(parseRequestBody(repositoryCatalogActivateRequestSchema, {})).toEqual({
      ok: true,
      value: { acknowledgedRepositoryKeys: [] },
    });
  });

  it("carries the keys the dialog showed", () => {
    expect(
      parseRequestBody(repositoryCatalogActivateRequestSchema, {
        acknowledgedRepositoryKeys: ["github:acme/api"],
      }),
    ).toEqual({ ok: true, value: { acknowledgedRepositoryKeys: ["github:acme/api"] } });
  });
});

describe("repositoryCatalogImportRequestSchema", () => {
  it("defaults the grant to off, so an import that forgot to decide grants nothing", () => {
    expect(
      parseRequestBody(repositoryCatalogImportRequestSchema, {
        repositoryKeys: ["github:acme/api"],
      }),
    ).toEqual({
      ok: true,
      value: { repositoryKeys: ["github:acme/api"], enabled: false },
    });
  });

  it("refuses an empty selection rather than committing nothing", () => {
    expect(
      parseRequestBody(repositoryCatalogImportRequestSchema, { repositoryKeys: [] }).ok,
    ).toBe(false);
  });
});

describe("repositoryCatalogImportPreviewRequestSchema", () => {
  it("accepts an empty body and refuses anything else", () => {
    expect(parseRequestBody(repositoryCatalogImportPreviewRequestSchema, {})).toEqual({
      ok: true,
      value: {},
    });
    expect(
      parseRequestBody(repositoryCatalogImportPreviewRequestSchema, { provider: "github" })
        .ok,
    ).toBe(false);
  });
});

describe("repositoryCatalogSuggestRequestSchema", () => {
  it("takes one repository id and refuses a repository that cannot exist", () => {
    expect(parseRequestBody(repositoryCatalogSuggestRequestSchema, { repositoryId: 7 })).toEqual(
      { ok: true, value: { repositoryId: 7 } },
    );
    expect(
      parseRequestBody(repositoryCatalogSuggestRequestSchema, { repositoryId: 0 }).ok,
    ).toBe(false);
  });
});
