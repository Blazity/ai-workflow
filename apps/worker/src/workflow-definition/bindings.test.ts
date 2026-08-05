import { describe, expect, it } from "vitest";
import type { WorkflowValueSchema } from "@shared/contracts";
import {
  isWorkflowSchemaAssignable,
  parseWorkflowBindingSource,
  resolveWorkflowInputBindings,
  resolveWorkflowSchemaPath,
  RUN_BINDING_SCHEMA,
} from "./bindings.js";

const stringSchema: WorkflowValueSchema = { type: "string" };

describe("parseWorkflowBindingSource", () => {
  it.each([
    ["trigger.ticket.key", { root: "trigger", path: ["ticket", "key"] }],
    [
      "steps.plan.output.data.items.0.title",
      { root: "steps", nodeId: "plan", path: ["data", "items", "0", "title"] },
    ],
    ["run.defaultAgent.model", { root: "run", path: ["defaultAgent", "model"] }],
  ])("parses %s", (source, expected) => {
    expect(parseWorkflowBindingSource(source)).toEqual(expected);
  });

  it.each([
    " trigger.ticket.key",
    "trigger",
    "trigger.",
    "trigger.ticket..key",
    "steps.plan.output",
    "steps.plan.result.value",
    "steps..output.value",
    "run.branchName.",
    "run.constructor.name",
    "trigger.__proto__.polluted",
    "steps.prototype.output.value",
  ])("rejects the non-canonical or unsafe source %s", (source) => {
    expect(parseWorkflowBindingSource(source)).toBeNull();
  });
});

describe("resolveWorkflowSchemaPath", () => {
  const schema: WorkflowValueSchema = {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { title: stringSchema },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
    required: ["data"],
    additionalProperties: false,
  };

  it("looks up nested object fields and numeric array indices", () => {
    expect(resolveWorkflowSchemaPath(schema, ["data", "items", "0", "title"])).toEqual(
      stringSchema,
    );
  });

  it("rejects undeclared fields and non-numeric array indices", () => {
    expect(resolveWorkflowSchemaPath(schema, ["data", "missing"])).toBeNull();
    expect(resolveWorkflowSchemaPath(schema, ["data", "items", "first"])).toBeNull();
  });

  it("publishes the exact fixed run binding schema", () => {
    expect(RUN_BINDING_SCHEMA).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        branchName: { type: "string" },
        defaultAgent: {
          type: "object",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
          },
          required: ["provider", "model"],
          additionalProperties: false,
        },
      },
      required: ["id", "branchName", "defaultAgent"],
      additionalProperties: false,
    });
  });
});

describe("isWorkflowSchemaAssignable", () => {
  it("accepts exact primitive types and rejects incompatible or unknown sources", () => {
    expect(isWorkflowSchemaAssignable(stringSchema, stringSchema)).toBe(true);
    expect(isWorkflowSchemaAssignable({ type: "number" }, stringSchema)).toBe(false);
    expect(isWorkflowSchemaAssignable({ type: "unknown" }, stringSchema)).toBe(false);
    expect(isWorkflowSchemaAssignable(stringSchema, { type: "unknown" })).toBe(true);
    expect(isWorkflowSchemaAssignable({ type: "unknown" }, { type: "unknown" })).toBe(
      true,
    );
  });

  it("treats source enums as finite sets that must fit inside the target", () => {
    const ready: WorkflowValueSchema = { type: "string", enum: ["ready"] };
    const readyOrBlocked: WorkflowValueSchema = {
      type: "string",
      enum: ["ready", "blocked"],
    };
    const blocked: WorkflowValueSchema = {
      type: "string",
      enum: ["blocked"],
    };

    expect(isWorkflowSchemaAssignable(ready, ready)).toBe(true);
    expect(isWorkflowSchemaAssignable(ready, readyOrBlocked)).toBe(true);
    expect(isWorkflowSchemaAssignable(readyOrBlocked, ready)).toBe(false);
    expect(isWorkflowSchemaAssignable(ready, blocked)).toBe(false);
    expect(isWorkflowSchemaAssignable(ready, stringSchema)).toBe(true);
    expect(isWorkflowSchemaAssignable(stringSchema, ready)).toBe(false);
  });

  it("handles finite Boolean, null, nullable, array, and object enums exactly", () => {
    expect(
      isWorkflowSchemaAssignable(
        { type: "boolean" },
        { type: "boolean", enum: [false, true] },
      ),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(
        { type: "boolean" },
        { type: "boolean", enum: [true] },
      ),
    ).toBe(false);
    expect(
      isWorkflowSchemaAssignable(
        { type: "null" },
        { type: "nullable", value: stringSchema, enum: ["ready", null] },
      ),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "nullable",
          value: { type: "string", enum: ["ready"] },
          enum: ["ready"],
        },
        { type: "string", enum: ["ready"] },
      ),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(
        { type: "array", items: stringSchema, enum: [["ready"]] },
        { type: "array", items: stringSchema, enum: [["ready"], ["blocked"]] },
      ),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "object",
          properties: { state: stringSchema },
          required: ["state"],
          additionalProperties: false,
          enum: [{ state: "ready" }],
        },
        {
          type: "object",
          properties: { state: { type: "string", enum: ["ready"] } },
          required: ["state"],
          additionalProperties: false,
          enum: [{ state: "ready" }],
        },
      ),
    ).toBe(true);
  });

  it("enforces closed-object property sets in both directions", () => {
    const closedTitle: WorkflowValueSchema = {
      type: "object",
      properties: { title: stringSchema },
      required: ["title"],
      additionalProperties: false,
    };
    const closedTitleAndOptionalCount: WorkflowValueSchema = {
      type: "object",
      properties: { title: stringSchema, count: { type: "number" } },
      required: ["title"],
      additionalProperties: false,
    };
    const closedTitleAndRequiredCount: WorkflowValueSchema = {
      ...closedTitleAndOptionalCount,
      required: ["title", "count"],
    };

    expect(isWorkflowSchemaAssignable(closedTitle, closedTitle)).toBe(true);
    expect(
      isWorkflowSchemaAssignable(closedTitle, closedTitleAndOptionalCount),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(closedTitleAndOptionalCount, closedTitle),
    ).toBe(false);
    expect(
      isWorkflowSchemaAssignable(closedTitleAndRequiredCount, closedTitle),
    ).toBe(false);
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "object",
          properties: { title: { type: "number" } },
          required: ["title"],
          additionalProperties: false,
        },
        closedTitle,
      ),
    ).toBe(false);
  });

  it("allows closed sources into open targets but rejects unsafe open sources", () => {
    const closedTitle: WorkflowValueSchema = {
      type: "object",
      properties: { title: stringSchema },
      required: ["title"],
      additionalProperties: false,
    };
    const openTitle: WorkflowValueSchema = {
      ...closedTitle,
      additionalProperties: true,
    };
    const openAnything: WorkflowValueSchema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    };

    expect(isWorkflowSchemaAssignable(closedTitle, openTitle)).toBe(true);
    expect(isWorkflowSchemaAssignable(openTitle, closedTitle)).toBe(false);
    expect(isWorkflowSchemaAssignable(openTitle, openTitle)).toBe(true);
    expect(isWorkflowSchemaAssignable(openTitle, openAnything)).toBe(true);
    expect(isWorkflowSchemaAssignable(openAnything, openTitle)).toBe(false);
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "object",
          properties: { title: stringSchema, count: { type: "number" } },
          required: ["title", "count"],
          additionalProperties: true,
        },
        openTitle,
      ),
    ).toBe(true);
  });

  it("requires every target-required property to be guaranteed by the source", () => {
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "object",
          properties: { title: stringSchema },
          required: [],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { title: stringSchema },
          required: ["title"],
          additionalProperties: false,
        },
      ),
    ).toBe(false);
  });
});

describe("resolveWorkflowInputBindings", () => {
  it("resolves trigger, prior-step, and run values using own properties", () => {
    const resolved = resolveWorkflowInputBindings(
      {
        ticketKey: "trigger.ticket.key",
        summary: "steps.plan.output.data.summary",
        model: "run.defaultAgent.model",
      },
      { status: "fired", ticket: { key: "AIW-92" } },
      { plan: { output: { status: "ok", data: { summary: "Ready" } } } },
      {
        id: "run-1",
        branchName: "ai-workflow/AIW-92",
        defaultAgent: { provider: "codex", model: "gpt-5-codex" },
      },
    );

    expect(resolved).toEqual({ ticketKey: "AIW-92", summary: "Ready", model: "gpt-5-codex" });
  });

  it("fails closed when a runtime path is missing", () => {
    expect(() =>
      resolveWorkflowInputBindings(
        { value: "trigger.missing" },
        { status: "fired" },
        {},
        {
          id: "run-1",
          branchName: "branch",
          defaultAgent: { provider: "claude", model: "model" },
        },
      ),
    ).toThrow('binding "trigger.missing" could not be resolved');
  });
});
