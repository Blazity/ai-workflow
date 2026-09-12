import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  parseRequestBody,
  relatesToItself,
  repositoryCatalogActivateRequestSchema,
  repositoryCatalogEnabledRequestSchema,
  repositoryCatalogImportPreviewRequestSchema,
  repositoryCatalogImportRequestSchema,
  repositoryCatalogSuggestRequestSchema,
  repositoryCatalogUpsertRequestSchema,
  repositoryCatalogVersionsQuerySchema,
  REPOSITORY_RELATIONSHIPS_MAX,
  REPOSITORY_VERSION_PAGE_DEFAULT,
  REPOSITORY_VERSION_PAGE_MAX,
  selfRelationshipMessage,
} from "@shared/contracts";

/** Every upsert body below carries one, because a profile version with no
 *  audit line is what D4 stopped accepting. */
const REASON = "first profile";

describe("repositoryCatalogUpsertRequestSchema", () => {
  it("leaves an omitted profile field out, because omitted means unchanged", () => {
    // The route reads an absent field as "carry the stored value forward". A
    // default here would turn a Rules-only save into a body that also clears
    // the description and the script groups, which is the exact bug this
    // schema change exists to close.
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: REASON,
      }),
    ).toEqual({
      ok: true,
      value: { provider: "github", path: "acme/api", reason: REASON },
    });
  });

  // D4 / row P31. MCP has always required one. HTTP defaulted it to the empty
  // string, so a profile version could be minted with a blank audit line and
  // the History tab had nothing to show for it.
  it("refuses a save with no reason, because the version history is the point", () => {
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
      }).ok,
    ).toBe(false);
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: "   ",
      }),
    ).toEqual({ ok: false, message: "a reason is required" });
  });

  it("keeps null apart from absent, because one clears and the other does not", () => {
    const parsed = parseRequestBody(repositoryCatalogUpsertRequestSchema, {
      provider: "github",
      path: "acme/api",
      reason: REASON,
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
        reason: REASON,
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
        reason: REASON,
        expectedProfileVersion: 0,
      }).ok,
    ).toEqual(true);
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: REASON,
        batchTimeoutMinutes: 0,
      }).ok,
    ).toEqual(false);
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: REASON,
        batchTimeoutMinutes: 121,
      }).ok,
    ).toEqual(false);
    // Null is the operator ceiling, which is a value and not an absence.
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: REASON,
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
      reason: REASON,
      enabled: true,
    });
    expect(granting.ok && granting.value.enabled).toBe(true);
    const silent = parseRequestBody(repositoryCatalogUpsertRequestSchema, {
      provider: "github",
      path: "acme/api",
      reason: REASON,
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
        reason: REASON,
      }).ok,
    ).toBe(false);
  });

  it("refuses a path that is not owner/name", () => {
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "api",
        reason: REASON,
      }),
    ).toEqual({ ok: false, message: 'repository path must look like "owner/name"' });
  });

  // D12 / rows P29, P30. Refused HERE rather than on one surface, because the
  // dashboard, the HTTP route and the MCP tool all parse this same schema.
  it("refuses the same repository related twice", () => {
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: REASON,
        relationships: [
          { repositoryId: 8, label: "the client" },
          { repositoryId: 8, label: "again" },
        ],
      }),
    ).toEqual({
      ok: false,
      message: "repository 8 is related twice; one relationship per repository",
    });
  });

  it("caps a relationship list at what the Overview tab can be read from", () => {
    const withinBound = Array.from({ length: REPOSITORY_RELATIONSHIPS_MAX }, (_, index) => ({
      repositoryId: index + 1,
      label: "related",
    }));
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: REASON,
        relationships: withinBound,
      }).ok,
    ).toBe(true);
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: REASON,
        relationships: [...withinBound, { repositoryId: 999, label: "one too many" }],
      }).ok,
    ).toBe(false);
  });

  it("accepts a relationship to a repository the catalog does not hold yet", () => {
    // Deliberately unchanged: the row it names may be imported later, and the
    // Overview tab renders an unresolved id as `repository <id>`.
    expect(
      parseRequestBody(repositoryCatalogUpsertRequestSchema, {
        provider: "github",
        path: "acme/api",
        reason: REASON,
        relationships: [{ repositoryId: 4242, label: "imported next week" }],
      }).ok,
    ).toBe(true);
  });
});

// The one relationship rule the schema cannot apply: identity on the body is
// the provider and the path, so the id a relationship would point at is not on
// the body at all and the caller has to supply it.
describe("relatesToItself", () => {
  it("finds a repository related to itself, whatever else the list holds", () => {
    expect(
      relatesToItself(7, [
        { repositoryId: 8, label: "the client" },
        { repositoryId: 7, label: "itself" },
      ]),
    ).toBe(true);
    expect(relatesToItself(7, [{ repositoryId: 8, label: "the client" }])).toBe(false);
  });

  it("says no for a repository that does not exist yet, and for an absent list", () => {
    // A create has no id, so nothing on its list can be itself.
    expect(relatesToItself(0, [{ repositoryId: 7, label: "somebody" }])).toBe(false);
    expect(relatesToItself(7, undefined)).toBe(false);
  });

  it("names the repository in the refusal, under one stable prefix", () => {
    expect(selfRelationshipMessage(7)).toEqual(
      "relationship_self_reference: repository 7 cannot be related to itself",
    );
  });
});

// D5 / row P34. The History tab and an agent reading the same history must not
// disagree about where a page ends, so the route pages by the numbers the MCP
// tool pages by.
describe("repositoryCatalogVersionsQuerySchema", () => {
  it("reads a query string's numbers, because a query string has none", () => {
    expect(
      parseRequestBody(repositoryCatalogVersionsQuerySchema, { limit: "25", before: "12" }),
    ).toEqual({ ok: true, value: { limit: 25, before: 12 } });
  });

  it("leaves both out when the caller asked for the first page", () => {
    expect(parseRequestBody(repositoryCatalogVersionsQuerySchema, {})).toEqual({
      ok: true,
      value: {},
    });
  });

  it("refuses a page size nobody could mean rather than answering a different one", () => {
    expect(parseRequestBody(repositoryCatalogVersionsQuerySchema, { limit: "0" }).ok).toBe(false);
    expect(
      parseRequestBody(repositoryCatalogVersionsQuerySchema, {
        limit: String(REPOSITORY_VERSION_PAGE_MAX + 1),
      }).ok,
    ).toBe(false);
    expect(parseRequestBody(repositoryCatalogVersionsQuerySchema, { before: "nope" }).ok).toBe(
      false,
    );
    expect(parseRequestBody(repositoryCatalogVersionsQuerySchema, { cursor: "12" }).ok).toBe(
      false,
    );
  });

  it("states a default and a ceiling the MCP history tool can import", () => {
    expect(REPOSITORY_VERSION_PAGE_DEFAULT).toEqual(50);
    expect(REPOSITORY_VERSION_PAGE_MAX).toEqual(200);
    expect(
      parseRequestBody(repositoryCatalogVersionsQuerySchema, {
        limit: String(REPOSITORY_VERSION_PAGE_MAX),
      }).ok,
    ).toBe(true);
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
