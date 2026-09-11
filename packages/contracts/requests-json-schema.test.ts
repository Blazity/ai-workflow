import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import { jsonSchemaInspectRequestSchema, parseRequestBody } from "@shared/contracts";

describe("jsonSchemaInspectRequestSchema", () => {
  it("accepts a source string", () => {
    const parsed = parseRequestBody(jsonSchemaInspectRequestSchema, {
      source: '{"type":"string"}',
    });
    expect(parsed).toEqual({ ok: true, value: { source: '{"type":"string"}' } });
  });

  it("refuses a missing source with the message the handler answered", () => {
    expect(parseRequestBody(jsonSchemaInspectRequestSchema, {})).toEqual({
      ok: false,
      message: "source must be a JSON Schema string",
    });
  });

  it("refuses a source that is not a string", () => {
    expect(parseRequestBody(jsonSchemaInspectRequestSchema, { source: 12 })).toEqual({
      ok: false,
      message: "source must be a JSON Schema string",
    });
  });

  it("ignores an unknown field, as the handler did", () => {
    const parsed = parseRequestBody(jsonSchemaInspectRequestSchema, {
      source: "{}",
      extra: true,
    });
    expect(parsed).toEqual({ ok: true, value: { source: "{}" } });
  });
});
