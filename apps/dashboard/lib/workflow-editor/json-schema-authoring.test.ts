import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VISUAL_JSON_SCHEMA,
  addVisualSchemaProperty,
  changeVisualSchemaType,
  removeVisualSchemaProperty,
  renameVisualSchemaProperty,
  setVisualSchemaAdditionalProperties,
  setVisualSchemaArrayItems,
  setVisualSchemaNullable,
  setVisualSchemaProperty,
  setVisualSchemaPropertyRequired,
  valueForExactSchemaSource,
  visualSchemaNullable,
  visualSchemaType,
} from "./json-schema-authoring.ts";

test("the default visual schema is a closed JSON Schema 2020-12 object", () => {
  assert.deepEqual(DEFAULT_VISUAL_JSON_SCHEMA, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  });
});

test("visual type changes retain shared metadata and create complete nested shapes", () => {
  const array = changeVisualSchemaType(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: ["string", "null"],
      description: "Result",
      enum: ["a", null],
    },
    "array",
  );
  assert.equal(visualSchemaType(array), "array");
  assert.equal(visualSchemaNullable(array), true);
  assert.deepEqual(array.items, { type: "string" });
  assert.equal(array.description, "Result");
  assert.equal(array.enum, undefined);

  const object = changeVisualSchemaType(array, "object");
  assert.deepEqual(object.properties, {});
  assert.deepEqual(object.required, []);
  assert.equal(object.additionalProperties, false);
});

test("nullable changes preserve the authored base type", () => {
  const nullable = setVisualSchemaNullable(
    { type: "number", enum: [1, 2] },
    true,
  );
  assert.deepEqual(nullable.type, ["number", "null"]);
  assert.deepEqual(nullable.enum, [1, 2, null]);
  const required = setVisualSchemaNullable(nullable, false);
  assert.deepEqual(required.type, "number");
  assert.deepEqual(required.enum, [1, 2]);
  assert.deepEqual(setVisualSchemaNullable({ type: "null" }, true), {
    type: "null",
  });
});

test("property operations retain order, requirements, and child schemas", () => {
  let schema = structuredClone(DEFAULT_VISUAL_JSON_SCHEMA);
  schema = addVisualSchemaProperty(schema, "title")!;
  schema = addVisualSchemaProperty(schema, "score")!;
  schema = setVisualSchemaProperty(schema, "score", { type: "number" });
  schema = setVisualSchemaPropertyRequired(schema, "score", true);
  schema = renameVisualSchemaProperty(schema, "score", "rating")!;

  assert.deepEqual(Object.keys(schema.properties as object), ["title", "rating"]);
  assert.deepEqual(schema.required, ["rating"]);
  assert.deepEqual(
    (schema.properties as Record<string, unknown>).rating,
    { type: "number" },
  );
  assert.equal(addVisualSchemaProperty(schema, "rating"), null);
  assert.equal(addVisualSchemaProperty(schema, "__proto__"), null);

  schema = removeVisualSchemaProperty(schema, "rating");
  assert.deepEqual(Object.keys(schema.properties as object), ["title"]);
  assert.deepEqual(schema.required, []);
});

test("array items and open-object choice are represented explicitly", () => {
  const array = setVisualSchemaArrayItems(
    { type: "array", items: { type: "string" } },
    { type: "boolean" },
  );
  assert.deepEqual(array.items, { type: "boolean" });
  assert.equal(
    setVisualSchemaAdditionalProperties(
      structuredClone(DEFAULT_VISUAL_JSON_SCHEMA),
      true,
    ).additionalProperties,
    true,
  );
});

test("async editor state is usable only for the exact inspected source", () => {
  const inspected = {
    source: '{"type":"string"}',
    value: { type: "string" },
  };
  assert.deepEqual(
    valueForExactSchemaSource('{"type":"string"}', inspected),
    { type: "string" },
  );
  assert.equal(
    valueForExactSchemaSource('{"type":"number"}', inspected),
    null,
  );

  const failed = {
    source: '{"type":"number"}',
    value: "Schema inspection failed (503)",
  };
  assert.equal(
    valueForExactSchemaSource('{"type":"string"}', failed),
    null,
  );
  assert.equal(
    valueForExactSchemaSource('{"type":"number"}', failed),
    "Schema inspection failed (503)",
  );
});
