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
  it("leaves an omitted profile field out, because omitted means unchanged", () => {
    // The route reads an absent field as "carry the stored value forward". A
    // default here would turn a Rules-only save into a body that also clears
    // the description and the script groups, which is the exact bug this
    // schema change exists to close. Only `reason` still defaults, because it
    // describes the write rather than the profile.
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
      }),
    ).toEqual({
      ok: true,
      value: { provider: "github", path: "acme/api", reason: "" },
    });
  });

  it("keeps null apart from absent, because one clears and the other does not", () => {
    const parsed = parseRequestBody(repositoryCatalogUpsertRequestSchema, {
      provider: "github",
      path: "acme/api",
      scriptGroups: null,
    });
    expect(parsed.ok).toEqual(true);
    expect(parsed.ok && "scriptGroups" in parsed.value).toEqual(true);
    expect(parsed.ok && parsed.value.scriptGroups).toEqual(null);
  });

  it("takes the concurrency token and the checks ceiling, and bounds the ceiling", () => {
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        expectedProfileVersion: 4,
        batchTimeoutMinutes: 90,
      }),
    ).toMatchObject({
      ok: true,
      value: { expectedProfileVersion: 4, batchTimeoutMinutes: 90 },
    });
    // A version of 0 is "this screen loaded a repository with no profile", so
    // it is a legal token, not a missing one.
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        expectedProfileVersion: 0,
      }).ok,
    ).toEqual(true);
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        batchTimeoutMinutes: 0,
      }).ok,
    ).toEqual(false);
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        batchTimeoutMinutes: 121,
      }).ok,
    ).toEqual(false);
    // Null is the operator ceiling, which is a value and not an absence.
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        batchTimeoutMinutes: null,
      }).ok,
    ).toEqual(true);
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
  it("defaults the acknowledged list to empty, but never the reason", () => {
    expect(
      parseRequestBody(repositoryCatalogActivateRequestSchema, {
        reason: "the bridge is over",
      }),
    ).toEqual({
      ok: true,
      value: { acknowledgedRepositoryKeys: [], reason: "the bridge is over" },
    });
  });

  it("refuses an activation with no reason, so the stored audit line is never blank", () => {
    expect(parseRequestBody(repositoryCatalogActivateRequestSchema, {}).ok).toEqual(false);
    expect(
      parseRequestBody(repositoryCatalogActivateRequestSchema, { reason: "   " }),
    ).toEqual({ ok: false, message: "a reason is required" });
  });

  it("carries the keys the dialog showed", () => {
    expect(
      parseRequestBody(repositoryCatalogActivateRequestSchema, {
        acknowledgedRepositoryKeys: ["github:acme/api"],
        reason: "the bridge is over",
      }),
    ).toEqual({
      ok: true,
      value: {
        acknowledgedRepositoryKeys: ["github:acme/api"],
        reason: "the bridge is over",
      },
    });
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
