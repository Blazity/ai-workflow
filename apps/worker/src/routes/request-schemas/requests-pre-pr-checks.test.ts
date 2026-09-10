import { describe, expect, it } from "vitest";
import {
  parseRequestBody,
  prePrCheckRestoreRequestSchema,
  prePrCheckSaveRequestSchema,
} from "@shared/contracts";

describe("prePrCheckSaveRequestSchema", () => {
  it("accepts a config and a base version", () => {
    const parsed = parseRequestBody(prePrCheckSaveRequestSchema, {
      config: { repositories: [] },
      baseVersion: 3,
    });
    expect(parsed).toEqual({
      ok: true,
      value: { config: { repositories: [] }, baseVersion: 3 },
    });
  });

  it("accepts a body without a base version", () => {
    expect(
      parseRequestBody(prePrCheckSaveRequestSchema, { config: { repositories: [] } }),
    ).toEqual({ ok: true, value: { config: { repositories: [] } } });
  });

  it("leaves a base version of the wrong type to the handler, as before", () => {
    expect(
      parseRequestBody(prePrCheckSaveRequestSchema, { config: {}, baseVersion: "3" }),
    ).toEqual({ ok: true, value: { config: {}, baseVersion: "3" } });
  });

  it("keeps an unknown field, because the whole body is forwarded", () => {
    expect(
      parseRequestBody(prePrCheckSaveRequestSchema, { config: {}, note: "hi" }),
    ).toEqual({ ok: true, value: { config: {}, note: "hi" } });
  });

  it("refuses a body that is not an object", () => {
    expect(parseRequestBody(prePrCheckSaveRequestSchema, "nope")).toEqual({
      ok: false,
      message: "Invalid config: config is required.",
    });
  });
});

describe("prePrCheckRestoreRequestSchema", () => {
  it("accepts an integer version", () => {
    expect(parseRequestBody(prePrCheckRestoreRequestSchema, { version: 4 })).toEqual({
      ok: true,
      value: { version: 4 },
    });
  });

  it("refuses a missing version", () => {
    expect(parseRequestBody(prePrCheckRestoreRequestSchema, {})).toEqual({
      ok: false,
      message: "Invalid version",
    });
  });

  it("refuses a version of the wrong type", () => {
    expect(
      parseRequestBody(prePrCheckRestoreRequestSchema, { version: "4" }),
    ).toEqual({ ok: false, message: "Invalid version" });
  });

  it("refuses a fractional version", () => {
    expect(parseRequestBody(prePrCheckRestoreRequestSchema, { version: 4.5 })).toEqual({
      ok: false,
      message: "Invalid version",
    });
  });

  it("drops an unknown field rather than refusing it", () => {
    expect(
      parseRequestBody(prePrCheckRestoreRequestSchema, { version: 4, why: "rollback" }),
    ).toEqual({ ok: true, value: { version: 4 } });
  });
});
