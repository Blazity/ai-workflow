import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  harnessLocalSkillImportBodySchema,
  harnessProfileCreateRequestSchema,
  harnessProfileDraftUpdateRequestSchema,
  harnessProfileForkRequestSchema,
  harnessProfileRevisionRequestSchema,
  harnessProfileSkillRefreshRequestSchema,
  harnessProfileUncheckedRevisionRequestSchema,
  harnessProfileVersionRestoreRequestSchema,
  harnessSkillDiscoverBodySchema,
  harnessSkillImportBodySchema,
  parseRequestBody,
} from "@shared/contracts";

describe("harness profile create request", () => {
  it("accepts a draft with an optional slug", () => {
    const parsed = parseRequestBody(harnessProfileCreateRequestSchema, {
      slug: "fast",
      draft: { schemaVersion: 1 },
    });
    expect(parsed).toEqual({
      ok: true,
      value: { slug: "fast", draft: { schemaVersion: 1 } },
    });
  });

  it("answers the handler's message when the draft is missing", () => {
    expect(parseRequestBody(harnessProfileCreateRequestSchema, {})).toEqual({
      ok: false,
      message: "Profile draft is required",
    });
  });

  it("accepts any draft type, because the store parses the manifest", () => {
    const parsed = parseRequestBody(harnessProfileCreateRequestSchema, {
      draft: "not a manifest",
    });
    expect(parsed.ok).toBe(true);
  });

  it("strips unknown fields", () => {
    const parsed = parseRequestBody(harnessProfileCreateRequestSchema, {
      draft: {},
      unexpected: 1,
    });
    expect(parsed).toEqual({ ok: true, value: { draft: {} } });
  });
});

describe("harness profile draft update request", () => {
  it("accepts a numeric revision with a draft", () => {
    expect(
      parseRequestBody(harnessProfileDraftUpdateRequestSchema, {
        expectedRevision: 3,
        draft: {},
      }),
    ).toEqual({ ok: true, value: { expectedRevision: 3, draft: {} } });
  });

  it("refuses a missing revision", () => {
    expect(
      parseRequestBody(harnessProfileDraftUpdateRequestSchema, { draft: {} }),
    ).toEqual({
      ok: false,
      message: "Draft and expectedRevision are required",
    });
  });

  it("refuses a revision of the wrong type", () => {
    expect(
      parseRequestBody(harnessProfileDraftUpdateRequestSchema, {
        expectedRevision: "3",
        draft: {},
      }),
    ).toEqual({
      ok: false,
      message: "Draft and expectedRevision are required",
    });
  });
});

describe("harness profile revision request", () => {
  it("accepts a numeric revision and strips the rest", () => {
    expect(
      parseRequestBody(harnessProfileRevisionRequestSchema, {
        expectedRevision: 1,
        extra: true,
      }),
    ).toEqual({ ok: true, value: { expectedRevision: 1 } });
  });

  it("refuses a missing revision", () => {
    expect(parseRequestBody(harnessProfileRevisionRequestSchema, {})).toEqual({
      ok: false,
      message: "expectedRevision is required",
    });
  });

  it("preserves the handlers' typeof check, so NaN reaches the store", () => {
    expect(
      parseRequestBody(harnessProfileRevisionRequestSchema, {
        expectedRevision: Number.NaN,
      }).ok,
    ).toBe(true);
  });
});

describe("harness profile unchecked revision request", () => {
  it("accepts a body with no revision at all", () => {
    expect(
      parseRequestBody(harnessProfileUncheckedRevisionRequestSchema, {}),
    ).toEqual({ ok: true, value: {} });
  });

  it("accepts a revision of any type, as the handler did", () => {
    expect(
      parseRequestBody(harnessProfileUncheckedRevisionRequestSchema, {
        expectedRevision: "7",
      }),
    ).toEqual({ ok: true, value: { expectedRevision: "7" } });
  });

  it("strips unknown fields", () => {
    expect(
      parseRequestBody(harnessProfileUncheckedRevisionRequestSchema, {
        other: 1,
      }),
    ).toEqual({ ok: true, value: {} });
  });
});

describe("harness profile fork request", () => {
  it("accepts a revision with an optional slug", () => {
    expect(
      parseRequestBody(harnessProfileForkRequestSchema, {
        expectedRevision: 2,
        slug: "copy",
      }),
    ).toEqual({ ok: true, value: { expectedRevision: 2, slug: "copy" } });
  });

  it("refuses a missing revision", () => {
    expect(
      parseRequestBody(harnessProfileForkRequestSchema, { slug: "copy" }),
    ).toEqual({ ok: false, message: "expectedRevision is required" });
  });
});

describe("harness profile version restore request", () => {
  it("accepts a version and a revision", () => {
    expect(
      parseRequestBody(harnessProfileVersionRestoreRequestSchema, {
        version: 4,
        expectedRevision: 9,
      }),
    ).toEqual({ ok: true, value: { version: 4, expectedRevision: 9 } });
  });

  it("refuses a version of the wrong type", () => {
    expect(
      parseRequestBody(harnessProfileVersionRestoreRequestSchema, {
        version: "4",
        expectedRevision: 9,
      }),
    ).toEqual({
      ok: false,
      message: "version and expectedRevision are required",
    });
  });
});

describe("harness profile skill refresh request", () => {
  it("accepts a revision and an artifact hash", () => {
    expect(
      parseRequestBody(harnessProfileSkillRefreshRequestSchema, {
        expectedRevision: 1,
        artifactHash: "abc",
      }),
    ).toEqual({ ok: true, value: { expectedRevision: 1, artifactHash: "abc" } });
  });

  it("refuses a missing artifact hash", () => {
    expect(
      parseRequestBody(harnessProfileSkillRefreshRequestSchema, {
        expectedRevision: 1,
      }),
    ).toEqual({
      ok: false,
      message: "artifactHash and expectedRevision are required",
    });
  });
});

describe("harness skill discover body", () => {
  it("accepts a source string", () => {
    expect(
      parseRequestBody(harnessSkillDiscoverBodySchema, {
        source: "https://github.com/o/r",
      }),
    ).toEqual({ ok: true, value: { source: "https://github.com/o/r" } });
  });

  it("refuses a source of the wrong type", () => {
    expect(
      parseRequestBody(harnessSkillDiscoverBodySchema, { source: 1 }),
    ).toEqual({ ok: false, message: "GitHub skill source is required" });
  });
});

describe("harness skill import body", () => {
  it("accepts an object source with an array of paths", () => {
    expect(
      parseRequestBody(harnessSkillImportBodySchema, {
        source: { owner: "o" },
        paths: ["skills/a"],
      }),
    ).toEqual({
      ok: true,
      value: { source: { owner: "o" }, paths: ["skills/a"] },
    });
  });

  it("refuses a null source", () => {
    expect(
      parseRequestBody(harnessSkillImportBodySchema, {
        source: null,
        paths: [],
      }),
    ).toEqual({
      ok: false,
      message: "Exact source and selected paths are required",
    });
  });

  it("refuses paths that are not an array", () => {
    expect(
      parseRequestBody(harnessSkillImportBodySchema, {
        source: {},
        paths: "skills/a",
      }),
    ).toEqual({
      ok: false,
      message: "Exact source and selected paths are required",
    });
  });
});

describe("harness local skill import body", () => {
  it("accepts an array of selections and strips unknown fields", () => {
    expect(
      parseRequestBody(harnessLocalSkillImportBodySchema, {
        skills: [{ path: "a" }],
        extra: 1,
      }),
    ).toEqual({ ok: true, value: { skills: [{ path: "a" }] } });
  });

  it("refuses a missing selection", () => {
    expect(parseRequestBody(harnessLocalSkillImportBodySchema, {})).toEqual({
      ok: false,
      message: "Selected skills are required",
    });
  });
});
