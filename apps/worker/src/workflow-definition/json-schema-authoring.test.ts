import { describe, expect, it } from "vitest";
import {
  inspectAuthoredJsonSchema,
  MAX_AUTHORED_JSON_SCHEMA_BYTES,
} from "./json-schema-authoring.js";

describe("inspectAuthoredJsonSchema", () => {
  it("returns the canonical schema and derived value type for the deployable subset", () => {
    const source = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        title: { type: "string", description: "Display title" },
        score: { type: ["number", "null"] },
      },
      required: ["title"],
      additionalProperties: false,
    });
    const result = inspectAuthoredJsonSchema(source);
    expect(result.deployable).toBe(true);
    if (!result.deployable) return;
    expect(result.schema.properties).toBeDefined();
    expect(result.valueSchema).toEqual({
      type: "object",
      properties: {
        title: { type: "string", description: "Display title" },
        score: { type: "nullable", value: { type: "number" } },
      },
      required: ["title"],
      additionalProperties: false,
    });
  });

  it("preserves a valid-but-unsupported parsed schema and returns exact pointers", () => {
    const result = inspectAuthoredJsonSchema(
      JSON.stringify({
        type: "object",
        properties: {
          title: { type: "string", minLength: 2 },
        },
      }),
    );
    expect(result.deployable).toBe(false);
    if (result.deployable) return;
    expect(result.schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string", minLength: 2 },
      },
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "unsupported_keyword",
        path: "/properties/title/minLength",
      }),
    );
  });

  it("does not replace invalid raw JSON with a parsed approximation", () => {
    const result = inspectAuthoredJsonSchema('{"type":"string"');
    expect(result).toMatchObject({
      deployable: false,
      schema: null,
      issues: [{ code: "invalid_json", path: "" }],
    });
  });

  it("bounds candidate source size before parsing", () => {
    const result = inspectAuthoredJsonSchema(
      " ".repeat(MAX_AUTHORED_JSON_SCHEMA_BYTES + 1),
    );
    expect(result).toMatchObject({
      deployable: false,
      schema: null,
      issues: [{ code: "invalid_schema", path: "" }],
    });
  });
});
