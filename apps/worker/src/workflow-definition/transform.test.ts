import { describe, expect, it } from "vitest";
import type { TransformConfiguration } from "@shared/contracts";
import {
  deriveTransformOutputSchema,
  executeTransform,
  validateTransformDefinition,
} from "./transform.js";

const context = {
  entryOutput: {
    status: "ok",
    text: "  Hello world  ",
    number: 12.5,
    json: '{"name":"Ada","age":37}',
    invalid: "{no",
    nil: null,
    falseValue: false,
  },
  runValues: {},
  getStepOutput: () => undefined,
};

describe("Transform", () => {
  it("formats text with multiple workflow values", () => {
    expect(
      executeTransform(
        {
          operation: "format_text",
          template:
            "Text: {{data:steps.entry.output.text}}\nNumber: {{data:steps.entry.output.number}}",
        },
        context,
      ),
    ).toBe("Text:   Hello world  \nNumber: 12.5");
  });

  it("trims text", () => {
    expect(
      executeTransform(
        { operation: "trim_text", source: "steps.entry.output.text" },
        context,
      ),
    ).toBe("Hello world");
  });

  it.each([
    ["plain", "world", "you", false, "  Hello you  "],
    ["plain", "WORLD", "you", true, "  Hello you  "],
    ["regex", "\\s+", "-", false, "-Hello-world-"],
    ["regex", "WORLD", "$1", true, "  Hello $1  "],
  ] as const)(
    "replaces text in %s mode",
    async (mode, pattern, replacement, ignoreCase, expected) => {
      expect(
        await executeTransform(
          {
            operation: "replace_text",
            source: "steps.entry.output.text",
            mode,
            pattern,
            replacement,
            ignoreCase,
          },
          context,
        ),
      ).toBe(expected);
    },
  );

  it("rejects empty and unsupported regex patterns at deployment", () => {
    expect(
      validateTransformDefinition({
        configuration: {
          operation: "replace_text",
          source: "steps.entry.output.text",
          mode: "plain",
          pattern: "",
          replacement: "",
          ignoreCase: false,
        },
      }),
    ).toHaveLength(1);
    expect(
      validateTransformDefinition({
        configuration: {
          operation: "replace_text",
          source: "steps.entry.output.text",
          mode: "regex",
          pattern: "(?=x)",
          replacement: "",
          ignoreCase: false,
        },
      }),
    ).toHaveLength(1);
  });

  it.each([
    [" 12 ", true, 12],
    ["-0.25", true, -0.25],
    ["1e3", true, 1000],
    ["", false, null],
    ["12x", false, null],
    ["1,2", false, null],
    ["NaN", false, null],
    ["Infinity", false, null],
  ] as const)("parses number %j strictly", (text, success, value) => {
    expect(
      executeTransform(
        { operation: "text_to_number", source: "steps.entry.output.value" },
        { ...context, entryOutput: { status: "ok", value: text } },
      ),
    ).toEqual({
      success,
      value,
      error: success ? null : "Input is not a valid number.",
    });
  });

  it("converts finite numbers to locale-independent text", () => {
    expect(
      executeTransform(
        { operation: "number_to_text", source: "steps.entry.output.number" },
        context,
      ),
    ).toBe("12.5");
  });

  it("parses JSON as a normal domain result", () => {
    expect(
      executeTransform(
        { operation: "parse_json", source: "steps.entry.output.json" },
        context,
      ),
    ).toEqual({ success: true, value: { name: "Ada", age: 37 }, error: null });
    expect(
      executeTransform(
        { operation: "parse_json", source: "steps.entry.output.invalid" },
        context,
      ),
    ).toMatchObject({ success: false, value: null });
  });

  it("reports only the first expected-schema mismatch", () => {
    const configuration: TransformConfiguration = {
      operation: "parse_json",
      source: "steps.entry.output.json",
      expectedSchema: {
        dialect: "https://json-schema.org/draft/2020-12/schema",
        source: JSON.stringify({
          type: "object",
          properties: { age: { type: "string" } },
          required: ["age"],
          additionalProperties: false,
        }),
      },
    };
    expect(executeTransform(configuration, context)).toMatchObject({
      success: false,
      value: null,
    });
  });

  it("builds a flat object and applies defaults only to missing/null", () => {
    expect(
      executeTransform(
        {
          operation: "build_object",
          fields: [
            { name: "literal", value: { kind: "literal", value: 0 } },
            {
              name: "fallback",
              value: {
                kind: "reference",
                reference: "steps.entry.output.nil",
                defaultValue: "none",
              },
            },
            {
              name: "falsy",
              value: {
                kind: "reference",
                reference: "steps.entry.output.falseValue",
                defaultValue: true,
              },
            },
            {
              name: "omitted",
              value: {
                kind: "reference",
                reference: "steps.entry.output.missing",
              },
            },
          ],
        },
        context,
      ),
    ).toEqual({ literal: 0, fallback: "none", falsy: false });
  });

  it("validates object names and zero-row drafts", () => {
    expect(
      validateTransformDefinition({
        configuration: { operation: "build_object", fields: [] },
      }),
    ).toHaveLength(1);
    expect(
      validateTransformDefinition({
        configuration: {
          operation: "build_object",
          fields: [
            { name: "__proto__", value: { kind: "literal", value: 1 } },
            { name: "ok", value: { kind: "literal", value: 1 } },
            { name: "ok", value: { kind: "literal", value: 2 } },
          ],
        },
      }),
    ).toHaveLength(2);
  });

  it("derives deterministic result schemas", () => {
    expect(
      deriveTransformOutputSchema({
        configuration: {
          operation: "text_to_number",
          source: "steps.entry.output.text",
        },
      }),
    ).toMatchObject({
      type: "object",
      properties: {
        success: { type: "boolean" },
        value: { type: ["number", "null"] },
      },
    });
  });
});
