import { describe, expect, it } from "vitest";
import {
  inspectJsonSchema202012,
  jsonSchemaForProvider,
  normalizeJsonSchemaProviderOutput,
  parseJsonSchema202012,
  validateJsonSchemaValue,
} from "./json-schema.js";

describe("JSON Schema 2020-12 structured outputs", () => {
  it("derives value metadata for the complete deployable subset", () => {
    const result = inspectJsonSchema202012({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      description: "Result",
      properties: {
        state: {
          type: "string",
          description: "Current state",
          enum: ["ready", "blocked"],
        },
        score: { type: ["number", "null"] },
        approved: { type: "boolean" },
        empty: { type: "null" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["state", "approved", "empty", "tags"],
      additionalProperties: false,
    });

    expect(result).toEqual({
      ok: true,
      schema: expect.any(Object),
      valueSchema: {
        type: "object",
        description: "Result",
        properties: {
          state: {
            type: "string",
            description: "Current state",
            enum: ["ready", "blocked"],
          },
          score: {
            type: "nullable",
            value: { type: "number" },
          },
          approved: { type: "boolean" },
          empty: { type: "null" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["state", "approved", "empty", "tags"],
        additionalProperties: false,
      },
    });
  });

  it("keeps legacy permissive v1 object schemas readable", () => {
    const parsed = parseJsonSchema202012(
      '{"type":"object","properties":{"answer":{"type":"number"}}}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      validateJsonSchemaValue(parsed.schema, { answer: 42, legacyExtra: true }),
    ).toEqual([]);
  });

  it("keeps deployed v1 annotations and draft-07 markers runtime-compatible", () => {
    const source = JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Legacy classifier",
      type: "object",
      properties: {
        state: {
          title: "State",
          type: "string",
        },
      },
      required: ["state", "state"],
      additionalProperties: false,
    });

    const strict = parseJsonSchema202012(source);
    expect(strict.ok).toBe(false);
    if (!strict.ok) {
      expect(strict.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unsupported_keyword",
            path: "/title",
          }),
        ]),
      );
    }

    const compatible = parseJsonSchema202012(source, {
      legacyCompatibility: true,
    });
    expect(compatible.ok).toBe(true);
    if (!compatible.ok) return;
    expect(validateJsonSchemaValue(compatible.schema, { state: "ready" })).toEqual([]);
    expect(validateJsonSchemaValue(compatible.schema, { state: 1 })).toEqual([
      expect.objectContaining({ code: "invalid_value", path: "/state" }),
    ]);
  });

  it("requires every deployable object to close additional properties at its exact path", () => {
    const result = inspectJsonSchema202012(
      {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {},
            },
          },
        },
      },
      { requireClosedObjects: true },
    );

    expect(result).toEqual({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_schema",
          path: "/additionalProperties",
        }),
        expect.objectContaining({
          code: "invalid_schema",
          path: "/properties/nested/additionalProperties",
        }),
        expect.objectContaining({
          code: "invalid_schema",
          path: "/properties/rows/items/additionalProperties",
        }),
      ]),
    });
  });

  it("reports invalid JSON and non-object roots at the schema root", () => {
    expect(parseJsonSchema202012("{nope")).toEqual({
      ok: false,
      issues: [{
        code: "invalid_json",
        path: "",
        message: "outputSchema is not valid JSON.",
      }],
    });
    expect(parseJsonSchema202012("42")).toEqual({
      ok: false,
      issues: [{
        code: "invalid_schema",
        path: "",
        message: "outputSchema must be a JSON Schema object.",
      }],
    });
  });

  it("rejects an unknown JSON Schema dialect without throwing", () => {
    expect(
      inspectJsonSchema202012({
        $schema: "https://example.com/unknown-schema",
        type: "string",
      }),
    ).toEqual({
      ok: false,
      issues: [{
        code: "invalid_schema",
        path: "/$schema",
        message: "outputSchema declares an unsupported JSON Schema dialect.",
      }],
    });
  });

  it.each([
    [
      { type: "string", pattern: "^[A-Z]+$" },
      "/pattern",
      "unsupported_keyword",
    ],
    [
      {
        type: "object",
        properties: { state: { type: "integer" } },
      },
      "/properties/state/type",
      "unsupported_type",
    ],
    [
      {
        type: "object",
        properties: { "not.addressable": { type: "string" } },
      },
      "/properties/not.addressable",
      "invalid_schema",
    ],
    [
      {
        type: "object",
        properties: { state: { type: "string" } },
        required: ["missing"],
      },
      "/required/0",
      "invalid_schema",
    ],
    [
      { type: ["string", "number"] },
      "/type",
      "unsupported_type",
    ],
  ] as const)("reports exact product-subset paths", (schema, path, code) => {
    const result = inspectJsonSchema202012(schema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, path })]),
    );
  });

  it("returns exact output pointers for canonical validation failures", () => {
    const parsed = inspectJsonSchema202012({
      type: "object",
      properties: {
        state: { type: "string", enum: ["ready", "blocked"] },
        nested: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
      required: ["state", "nested"],
      additionalProperties: false,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(
      validateJsonSchemaValue(parsed.schema, {
        state: "unknown",
        nested: { extra: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_value", path: "/state" }),
        expect.objectContaining({ code: "invalid_value", path: "/nested/count" }),
        expect.objectContaining({ code: "invalid_value", path: "/nested/extra" }),
      ]),
    );
  });

  it("makes Codex objects strict and required while preserving canonical optionality", () => {
    const parsed = inspectJsonSchema202012({
      type: "object",
      properties: {
        requiredName: { type: "string" },
        optionalCount: { type: "number" },
        nullableNote: {
          type: ["string", "null"],
          enum: ["note", null],
        },
        nested: {
          type: "object",
          properties: { optionalFlag: { type: "boolean" } },
        },
      },
      required: ["requiredName"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(jsonSchemaForProvider(parsed.schema, "claude")).toEqual(parsed.schema);
    expect(jsonSchemaForProvider(parsed.schema, "codex")).toEqual({
      type: "object",
      properties: {
        requiredName: { type: "string" },
        optionalCount: { type: ["number", "null"] },
        nullableNote: {
          type: ["string", "null"],
          enum: ["note", null],
        },
        nested: {
          type: ["object", "null"],
          properties: {
            optionalFlag: { type: ["boolean", "null"] },
          },
          required: ["optionalFlag"],
          additionalProperties: false,
        },
      },
      required: ["requiredName", "optionalCount", "nullableNote", "nested"],
      additionalProperties: false,
    });

    expect(
      normalizeJsonSchemaProviderOutput(parsed.schema, "codex", {
        requiredName: "Ada",
        optionalCount: null,
        nullableNote: null,
        nested: { optionalFlag: null },
      }),
    ).toEqual({
      requiredName: "Ada",
      nullableNote: null,
      nested: {},
    });
  });

  it("adds null to Codex optional types and enums exactly once", () => {
    const parsed = inspectJsonSchema202012({
      type: "object",
      properties: {
        nullableTypeButEnumExcludesNull: {
          type: ["string", "null"],
          enum: ["ready"],
        },
        enumIncludesNullButTypeExcludesIt: {
          type: "string",
          enum: ["ready", null],
        },
      },
      additionalProperties: false,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(jsonSchemaForProvider(parsed.schema, "codex")).toEqual({
      type: "object",
      properties: {
        nullableTypeButEnumExcludesNull: {
          type: ["string", "null"],
          enum: ["ready", null],
        },
        enumIncludesNullButTypeExcludesIt: {
          type: ["string", "null"],
          enum: ["ready", null],
        },
      },
      required: [
        "nullableTypeButEnumExcludesNull",
        "enumIncludesNullButTypeExcludesIt",
      ],
      additionalProperties: false,
    });
    expect(
      normalizeJsonSchemaProviderOutput(parsed.schema, "codex", {
        nullableTypeButEnumExcludesNull: null,
        enumIncludesNullButTypeExcludesIt: null,
      }),
    ).toEqual({});
  });

  it("strips dialect markers only at provider boundaries", () => {
    const parsed = inspectJsonSchema202012({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        nested: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.schema).toHaveProperty("$schema");
    expect(jsonSchemaForProvider(parsed.schema, "claude")).toEqual({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
    expect(jsonSchemaForProvider(parsed.schema, "codex")).toEqual({
      type: "object",
      properties: {
        nested: {
          type: ["object", "null"],
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      required: ["nested"],
      additionalProperties: false,
    });
  });
});
