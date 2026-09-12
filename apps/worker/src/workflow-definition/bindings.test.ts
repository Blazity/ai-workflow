import { describe, expect, it } from "vitest";
import type { WorkflowValueSchema } from "@shared/contracts";
import {
  isWorkflowSchemaAssignable,
  RUN_BINDING_SCHEMA,
} from "@shared/workflow-graph";

const stringSchema: WorkflowValueSchema = { type: "string" };

describe("RUN_BINDING_SCHEMA", () => {
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
