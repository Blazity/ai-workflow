import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  parseRequestBody,
  promptLibraryCreateRequestSchema,
  promptLibraryRestoreRequestSchema,
  promptLibrarySaveVersionRequestSchema,
  promptLibraryUpdateMetaRequestSchema,
} from "@shared/contracts";

describe("promptLibraryCreateRequestSchema", () => {
  it("accepts the full body", () => {
    const parsed = parseRequestBody(promptLibraryCreateRequestSchema, {
      name: "Planner",
      body: "Plan it",
      slots: [],
      description: null,
      tags: ["plan"],
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "Planner",
        body: "Plan it",
        slots: [],
        description: null,
        tags: ["plan"],
      },
    });
  });

  it("refuses a missing name before it looks at the body", () => {
    expect(parseRequestBody(promptLibraryCreateRequestSchema, {})).toEqual({
      ok: false,
      message: "Invalid name",
    });
  });

  it("refuses a body of the wrong type", () => {
    expect(
      parseRequestBody(promptLibraryCreateRequestSchema, { name: "n", body: 1 }),
    ).toEqual({ ok: false, message: "Invalid body" });
  });

  it("refuses slots, description and tags of the wrong type", () => {
    const base = { name: "n", body: "b" };
    expect(
      parseRequestBody(promptLibraryCreateRequestSchema, { ...base, slots: {} }),
    ).toEqual({ ok: false, message: "Invalid slots" });
    expect(
      parseRequestBody(promptLibraryCreateRequestSchema, { ...base, description: 3 }),
    ).toEqual({ ok: false, message: "Invalid description" });
    expect(
      parseRequestBody(promptLibraryCreateRequestSchema, { ...base, tags: "plan" }),
    ).toEqual({ ok: false, message: "Invalid tags" });
  });

  it("drops an unknown field instead of refusing it", () => {
    expect(
      parseRequestBody(promptLibraryCreateRequestSchema, {
        name: "n",
        body: "b",
        surprise: 1,
      }),
    ).toEqual({ ok: true, value: { name: "n", body: "b" } });
  });
});

describe("promptLibraryUpdateMetaRequestSchema", () => {
  it("accepts an empty body, since every field is optional", () => {
    expect(parseRequestBody(promptLibraryUpdateMetaRequestSchema, {})).toEqual({
      ok: true,
      value: {},
    });
  });

  it("refuses a name of the wrong type", () => {
    expect(
      parseRequestBody(promptLibraryUpdateMetaRequestSchema, { name: 5 }),
    ).toEqual({ ok: false, message: "Invalid name" });
  });

  it("drops an unknown field", () => {
    expect(
      parseRequestBody(promptLibraryUpdateMetaRequestSchema, { nope: true }),
    ).toEqual({ ok: true, value: {} });
  });
});

describe("promptLibrarySaveVersionRequestSchema", () => {
  it("accepts a body without slots", () => {
    expect(
      parseRequestBody(promptLibrarySaveVersionRequestSchema, { body: "b" }),
    ).toEqual({ ok: true, value: { body: "b" } });
  });

  it("refuses a missing body", () => {
    expect(parseRequestBody(promptLibrarySaveVersionRequestSchema, {})).toEqual({
      ok: false,
      message: "Invalid body",
    });
  });

  it("refuses slots that are not an array", () => {
    expect(
      parseRequestBody(promptLibrarySaveVersionRequestSchema, { body: "b", slots: 1 }),
    ).toEqual({ ok: false, message: "Invalid slots" });
  });

  it("drops an unknown field", () => {
    expect(
      parseRequestBody(promptLibrarySaveVersionRequestSchema, { body: "b", x: 1 }),
    ).toEqual({ ok: true, value: { body: "b" } });
  });
});

describe("promptLibraryRestoreRequestSchema", () => {
  it("accepts a version inside the int4 range", () => {
    expect(parseRequestBody(promptLibraryRestoreRequestSchema, { version: 2 })).toEqual({
      ok: true,
      value: { version: 2 },
    });
  });

  it("refuses a missing version", () => {
    expect(parseRequestBody(promptLibraryRestoreRequestSchema, {})).toEqual({
      ok: false,
      message: "Invalid version",
    });
  });

  it("refuses a version that is not a number, not an integer, or out of range", () => {
    for (const version of ["2", 1.5, 0, -1, 2147483648]) {
      expect(parseRequestBody(promptLibraryRestoreRequestSchema, { version })).toEqual({
        ok: false,
        message: "Invalid version",
      });
    }
  });

  it("drops an unknown field", () => {
    expect(
      parseRequestBody(promptLibraryRestoreRequestSchema, { version: 1, x: 1 }),
    ).toEqual({ ok: true, value: { version: 1 } });
  });
});
