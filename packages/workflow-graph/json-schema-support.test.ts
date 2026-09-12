/**
 * The behaviour that is new at this seam: the graph rules ask the injected
 * JSON Schema support and never answer a JSON Schema question themselves.
 *
 * The suites that cover what these rules decide stay in the worker on vitest
 * and run against the real ajv-backed support. What only a package test can
 * show is the inversion itself, so each test below hands in a support object
 * that answers differently from ajv and asserts the rule followed it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TransformConfiguration } from "@shared/contracts";
import {
  deriveTransformOutputSchema,
  executeTransform,
  inspectAuthoredJsonSchema,
  validateTransformDefinition,
  type V2BindingResolutionContext,
  type WorkflowJsonSchemaSupport,
} from "./index";

const refusing = (message: string): WorkflowJsonSchemaSupport => ({
  inspect: () => ({ ok: false, issues: [{ code: "invalid_schema", path: "", message }] }),
  parse: () => ({ ok: false, issues: [{ code: "invalid_schema", path: "", message }] }),
  validateValue: () => [{ code: "invalid_value", path: "", message }],
});

const accepting = (): WorkflowJsonSchemaSupport => ({
  inspect: (raw) => ({
    ok: true,
    schema: raw as Record<string, never>,
    valueSchema: { type: "unknown" },
  }),
  parse: () => ({ ok: true, schema: {}, valueSchema: { type: "unknown" } }),
  validateValue: () => [],
});

const parseJsonWithSchema = {
  operation: "parse_json",
  source: "steps.entry.output.json",
  expectedSchema: { source: '{"type":"object"}' },
} as unknown as TransformConfiguration;

const context: V2BindingResolutionContext = {
  entryOutput: { status: "ok", json: '{"name":"Ada"}' },
  runValues: {},
  getStepOutput: () => undefined,
};

test("validateTransformDefinition reports the injected support's schema complaint", () => {
  assert.deepEqual(
    validateTransformDefinition(
      { configuration: parseJsonWithSchema },
      refusing("expected schema is not usable"),
    ),
    [
      {
        code: "invalid_configuration",
        path: "/configuration/expectedSchema/source",
        message: "expected schema is not usable",
      },
    ],
  );
  assert.deepEqual(
    validateTransformDefinition({ configuration: parseJsonWithSchema }, accepting()),
    [],
  );
});

test("deriveTransformOutputSchema derives nothing when the injected support refuses the schema", () => {
  assert.equal(
    deriveTransformOutputSchema(
      { configuration: parseJsonWithSchema },
      refusing("expected schema is not usable"),
    ),
    null,
  );
  assert.notEqual(
    deriveTransformOutputSchema({ configuration: parseJsonWithSchema }, accepting()),
    null,
  );
});

test("executeTransform measures the parsed value with the injected support", () => {
  assert.deepEqual(executeTransform(parseJsonWithSchema, context, accepting()), {
    success: true,
    value: { name: "Ada" },
    error: null,
  });
  const refused = executeTransform(
    parseJsonWithSchema,
    context,
    {
      ...accepting(),
      validateValue: () => [
        { code: "invalid_value", path: "/name", message: "output.name is invalid" },
      ],
    },
  ) as { success: boolean; error: string | null };
  assert.equal(refused.success, false);
  assert.equal(refused.error, "/name is invalid");
});

test("inspectAuthoredJsonSchema answers from the injected support and counts UTF-8 bytes itself", () => {
  assert.deepEqual(
    inspectAuthoredJsonSchema('{"type":"object"}', refusing("unsupported keyword")),
    {
      deployable: false,
      dialect: "https://json-schema.org/draft/2020-12/schema",
      schema: { type: "object" },
      valueSchema: null,
      issues: [{ code: "invalid_schema", path: "", message: "unsupported keyword" }],
    },
  );
  // Two bytes per character, so 128 KiB of them is exactly the 256 KiB ceiling
  // and one more character is over it. `Buffer` would say the same; this
  // package may not reach for it.
  const atCeiling = `"${"ż".repeat(128 * 1024 - 1)}"`;
  assert.equal(inspectAuthoredJsonSchema(atCeiling, accepting()).deployable, true);
  const overCeiling = `"${"ż".repeat(128 * 1024)}"`;
  assert.deepEqual(inspectAuthoredJsonSchema(overCeiling, accepting()).issues, [
    {
      code: "invalid_schema",
      path: "",
      message: "outputSchema must not exceed 256 KiB.",
    },
  ]);
});
