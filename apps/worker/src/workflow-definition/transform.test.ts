import { describe, expect, it } from "vitest";
import type {
  JsonSchema202012,
  JsonValue,
  TransformConfiguration,
} from "@shared/contracts";
import {
  deriveTransformOutputSchema,
  executeTransform,
  TransformExecutionError,
  validateTransformDefinition,
} from "./transform.js";

const profileSchema: JsonSchema202012 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    name: { type: "string" },
    nickname: { type: "string" },
    score: { type: "number" },
    active: { type: "boolean" },
    note: { type: ["string", "null"] },
  },
  required: ["name", "score", "active", "note"],
  additionalProperties: false,
};

const rowsSchema: JsonSchema202012 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "array",
  items: profileSchema,
};

describe("Transform Map object", () => {
  const configuration: TransformConfiguration = {
    operation: "map_object",
    fields: [
      {
        name: "displayName",
        value: { kind: "input", source: { input: "profile", path: ["name"] } },
      },
      {
        name: "nickname",
        value: {
          kind: "input",
          source: { input: "profile", path: ["nickname"] },
          defaultValue: "Anonymous",
        },
      },
      { name: "source", value: { kind: "literal", value: "workflow" } },
    ],
  };

  it("selects, renames, combines, and defaults absent values", () => {
    expect(
      executeTransform(configuration, {
        profile: { name: "Ada", score: 10, active: true, note: null },
      }),
    ).toEqual({
      displayName: "Ada",
      nickname: "Anonymous",
      source: "workflow",
    });
  });

  it("does not replace an explicit null with a default", () => {
    const config: TransformConfiguration = {
      operation: "map_object",
      fields: [
        {
          name: "note",
          value: {
            kind: "input",
            source: { input: "profile", path: ["note"] },
            defaultValue: "none",
          },
        },
      ],
    };
    expect(executeTransform(config, { profile: { note: null } })).toEqual({ note: null });
  });

  it("derives a closed output schema and keeps optional fields optional", () => {
    const schema = deriveTransformOutputSchema({
      configuration: {
        operation: "map_object",
        fields: [
          {
            name: "requiredName",
            value: { kind: "input", source: { input: "profile", path: ["name"] } },
          },
          {
            name: "optionalNickname",
            value: { kind: "input", source: { input: "profile", path: ["nickname"] } },
          },
          { name: "literal", value: { kind: "literal", value: true } },
        ],
      },
      inputSchemas: { profile: profileSchema },
    });
    expect(schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        requiredName: { type: "string" },
        optionalNickname: { type: "string" },
        literal: { type: "boolean" },
      },
      required: ["requiredName", "literal"],
      additionalProperties: false,
    });
  });

  it("keeps a field selected through a nullable required parent optional", () => {
    const nullableProfileSchema: JsonSchema202012 = {
      type: "object",
      properties: {
        profile: {
          type: ["object", "null"],
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      required: ["profile"],
      additionalProperties: false,
    };
    const config: TransformConfiguration = {
      operation: "map_object",
      fields: [
        {
          name: "name",
          value: {
            kind: "input",
            source: { input: "data", path: ["profile", "name"] },
          },
        },
      ],
    };

    expect(
      deriveTransformOutputSchema({
        configuration: config,
        inputSchemas: { data: nullableProfileSchema },
      }),
    ).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    });
    expect(executeTransform(config, { data: { profile: null } })).toEqual({});
    expect(executeTransform(config, { data: { profile: { name: "Ada" } } })).toEqual({
      name: "Ada",
    });
  });

  it("rejects unknown inputs, invalid paths, unsafe or duplicate fields, and bad defaults", () => {
    const issues = validateTransformDefinition({
      configuration: {
        operation: "map_object",
        fields: [
          {
            name: "__proto__",
            value: { kind: "input", source: { input: "missing", path: [] } },
          },
          {
            name: "duplicate",
            value: {
              kind: "input",
              source: { input: "profile", path: ["unknown"] },
            },
          },
          {
            name: "duplicate",
            value: {
              kind: "input",
              source: { input: "profile", path: ["score"] },
              defaultValue: "not a number",
            },
          },
        ],
      },
      inputSchemas: { profile: profileSchema },
    });
    expect(issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "unsafe_output_field",
        "unknown_input",
        "invalid_path",
        "incompatible_value",
      ]),
    );
  });

  it("rejects a literal whose mixed array cannot be represented by the deployable schema subset", () => {
    expect(
      validateTransformDefinition({
        configuration: {
          operation: "map_object",
          fields: [
            {
              name: "mixed",
              value: { kind: "literal", value: [1, "two"] },
            },
          ],
        },
        inputSchemas: {},
      }),
    ).toEqual([expect.objectContaining({ code: "incompatible_value" })]);
  });
});

describe("Transform Filter array", () => {
  it("preserves order and evaluates nested typed predicates", () => {
    const configuration: TransformConfiguration = {
      operation: "filter_array",
      source: { input: "rows", path: [] },
      predicate: {
        kind: "all",
        predicates: [
          {
            kind: "comparison",
            path: ["score"],
            operator: "greater_than_or_equal",
            value: 5,
          },
          {
            kind: "any",
            predicates: [
              {
                kind: "comparison",
                path: ["name"],
                operator: "contains",
                value: "a",
              },
              {
                kind: "not",
                predicate: { kind: "is_null", path: ["note"], isNull: true },
              },
            ],
          },
        ],
      },
    };
    const rows: JsonValue[] = [
      { name: "Ada", score: 9, active: true, note: null },
      { name: "Bob", score: 7, active: true, note: "ready" },
      { name: "Cara", score: 2, active: true, note: "ready" },
      { name: "Dan", score: 6, active: true },
    ];
    expect(executeTransform(configuration, { rows })).toEqual([rows[0], rows[1], rows[3]]);
  });

  it("treats an absent path as neither null nor non-null", () => {
    const rows: JsonValue[] = [{}, { note: null }, { note: "ready" }];
    const base = {
      operation: "filter_array" as const,
      source: { input: "rows", path: [] },
    };
    expect(
      executeTransform(
        { ...base, predicate: { kind: "is_null", path: ["note"], isNull: true } },
        { rows },
      ),
    ).toEqual([rows[1]]);
    expect(
      executeTransform(
        { ...base, predicate: { kind: "is_null", path: ["note"], isNull: false } },
        { rows },
      ),
    ).toEqual([rows[2]]);
    expect(
      executeTransform(
        {
          ...base,
          predicate: {
            kind: "not",
            predicate: { kind: "is_null", path: ["note"], isNull: true },
          },
        },
        { rows },
      ),
    ).toEqual([rows[2]]);
  });

  it("preserves missing paths through nested logical predicates", () => {
    const rows: JsonValue[] = [
      { active: true },
      { active: true, note: null },
      { active: true, note: "ready" },
      { active: false, note: "ready" },
    ];
    const base = {
      operation: "filter_array" as const,
      source: { input: "rows", path: [] },
    };

    expect(
      executeTransform(
        {
          ...base,
          predicate: {
            kind: "not",
            predicate: {
              kind: "all",
              predicates: [
                {
                  kind: "comparison",
                  path: ["active"],
                  operator: "equals",
                  value: true,
                },
                { kind: "is_null", path: ["note"], isNull: true },
              ],
            },
          },
        },
        { rows },
      ),
    ).toEqual([rows[2], rows[3]]);

    expect(
      executeTransform(
        {
          ...base,
          predicate: {
            kind: "not",
            predicate: {
              kind: "any",
              predicates: [
                {
                  kind: "comparison",
                  path: ["active"],
                  operator: "equals",
                  value: false,
                },
                { kind: "is_null", path: ["note"], isNull: true },
              ],
            },
          },
        },
        { rows },
      ),
    ).toEqual([rows[2]]);
  });

  it("returns the source array schema as its output schema", () => {
    expect(
      deriveTransformOutputSchema({
        configuration: {
          operation: "filter_array",
          source: { input: "rows", path: [] },
          predicate: {
            kind: "comparison",
            path: ["active"],
            operator: "equals",
            value: true,
          },
        },
        inputSchemas: { rows: rowsSchema },
      }),
    ).toEqual(rowsSchema);
  });

  it("rejects incompatible operators and values", () => {
    const issues = validateTransformDefinition({
      configuration: {
        operation: "filter_array",
        source: { input: "rows", path: [] },
        predicate: {
          kind: "all",
          predicates: [
            {
              kind: "comparison",
              path: ["name"],
              operator: "greater_than",
              value: 1,
            },
            {
              kind: "comparison",
              path: ["score"],
              operator: "equals",
              value: "high",
            },
            {
              kind: "comparison",
              path: ["active"],
              operator: "not_equals",
              value: false,
            },
          ],
        },
      },
      inputSchemas: { rows: rowsSchema },
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "invalid_configuration" }),
      expect.objectContaining({ code: "incompatible_value" }),
      expect.objectContaining({ code: "invalid_configuration" }),
    ]);
  });

  it("rejects an optional nested array source", () => {
    const optionalRowsSchema: JsonSchema202012 = {
      type: "object",
      properties: {
        rows: rowsSchema,
      },
      required: [],
      additionalProperties: false,
    };

    expect(
      validateTransformDefinition({
        configuration: {
          operation: "filter_array",
          source: { input: "data", path: ["rows"] },
          predicate: { kind: "is_null", path: [], isNull: false },
        },
        inputSchemas: { data: optionalRowsSchema },
      }),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        path: "/configuration/source",
        message: "Filter array source must be guaranteed and non-null.",
      }),
    ]);
  });

  it("rejects a nullable root array source", () => {
    const nullableRowsSchema: JsonSchema202012 = {
      type: ["array", "null"],
      items: profileSchema,
    };

    expect(
      validateTransformDefinition({
        configuration: {
          operation: "filter_array",
          source: { input: "rows", path: [] },
          predicate: { kind: "is_null", path: [], isNull: false },
        },
        inputSchemas: { rows: nullableRowsSchema },
      }),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        path: "/configuration/source",
        message: "Filter array source must be guaranteed and non-null.",
      }),
    ]);
  });

  it("fails execution when the selected source is not an array", () => {
    expect(() =>
      executeTransform(
        {
          operation: "filter_array",
          source: { input: "rows", path: [] },
          predicate: { kind: "is_null", path: [], isNull: false },
        },
        { rows: "not an array" },
      ),
    ).toThrow(TransformExecutionError);
  });
});
