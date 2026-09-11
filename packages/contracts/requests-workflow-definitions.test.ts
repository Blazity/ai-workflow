import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  parseRequestBody,
  workflowDefinitionCreateRequestSchema,
  workflowDefinitionDeployRequestSchema,
  workflowDefinitionDraftSaveRequestSchema,
  workflowDefinitionLayoutPatchRequestSchema,
  workflowDefinitionMetaPatchRequestSchema,
  workflowDefinitionPromptPreviewRequestSchema,
  workflowDefinitionRollbackRequestSchema,
} from "@shared/contracts";

describe("workflowDefinitionCreateRequestSchema", () => {
  it("accepts a name and a source, trimming the name", () => {
    const parsed = parseRequestBody(workflowDefinitionCreateRequestSchema, {
      name: "  Nightly sweep  ",
      source: { kind: "template", templateId: "support-investigation" },
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "Nightly sweep",
        source: { kind: "template", templateId: "support-investigation" },
      },
    });
  });

  it("refuses a missing name with the message the handler used", () => {
    expect(parseRequestBody(workflowDefinitionCreateRequestSchema, {})).toEqual({
      ok: false,
      message: "Invalid name",
    });
  });

  it("refuses a whitespace-only name, which trims to nothing", () => {
    const parsed = parseRequestBody(workflowDefinitionCreateRequestSchema, {
      name: "   ",
      source: { kind: "default" },
    });
    expect(parsed).toEqual({ ok: false, message: "Invalid name" });
  });

  it("refuses a name of the wrong type before it looks at the source", () => {
    const parsed = parseRequestBody(workflowDefinitionCreateRequestSchema, {
      name: 7,
      source: "nonsense",
    });
    expect(parsed).toEqual({ ok: false, message: "Invalid name" });
  });

  it("reports every unusable source with one message", () => {
    for (const source of [
      undefined,
      null,
      "default",
      { kind: "template" },
      { kind: "template", templateId: "" },
      { kind: "duplicate", definitionId: 0 },
      { kind: "duplicate", definitionId: 1.5 },
    ]) {
      expect(
        parseRequestBody(workflowDefinitionCreateRequestSchema, { name: "n", source }),
      ).toEqual({ ok: false, message: "Invalid source" });
    }
  });

  it("drops an unknown field rather than refusing the request", () => {
    const parsed = parseRequestBody(workflowDefinitionCreateRequestSchema, {
      name: "n",
      source: { kind: "default" },
      surprise: true,
    });
    expect(parsed).toEqual({
      ok: true,
      value: { name: "n", source: { kind: "default" } },
    });
  });
});

describe("workflowDefinitionMetaPatchRequestSchema", () => {
  it("accepts an empty body, which updates nothing", () => {
    expect(parseRequestBody(workflowDefinitionMetaPatchRequestSchema, {})).toEqual({
      ok: true,
      value: {},
    });
  });

  it("trims a name it is given", () => {
    expect(
      parseRequestBody(workflowDefinitionMetaPatchRequestSchema, { name: " a " }),
    ).toEqual({ ok: true, value: { name: "a" } });
  });

  it("refuses a name that is not a string", () => {
    expect(
      parseRequestBody(workflowDefinitionMetaPatchRequestSchema, { name: 1 }),
    ).toEqual({ ok: false, message: "Invalid name" });
  });

  it("refuses an enabled flag that is not a boolean", () => {
    expect(
      parseRequestBody(workflowDefinitionMetaPatchRequestSchema, { enabled: "yes" }),
    ).toEqual({ ok: false, message: "Invalid enabled" });
  });

  it("ignores an unknown field", () => {
    expect(
      parseRequestBody(workflowDefinitionMetaPatchRequestSchema, {
        enabled: true,
        colour: "red",
      }),
    ).toEqual({ ok: true, value: { enabled: true } });
  });
});

describe("workflowDefinitionDraftSaveRequestSchema", () => {
  it("keeps the candidate untouched and takes the revision", () => {
    const parsed = parseRequestBody(workflowDefinitionDraftSaveRequestSchema, {
      definition: { schema: "v2" },
      expectedDraftRevision: 0,
    });
    expect(parsed).toEqual({
      ok: true,
      value: { definition: { schema: "v2" }, expectedDraftRevision: 0 },
    });
  });

  it("refuses a missing revision", () => {
    expect(
      parseRequestBody(workflowDefinitionDraftSaveRequestSchema, { definition: {} }),
    ).toEqual({ ok: false, message: "Invalid draft revision" });
  });

  it("refuses a revision that is not a whole number", () => {
    expect(
      parseRequestBody(workflowDefinitionDraftSaveRequestSchema, {
        expectedDraftRevision: 1.5,
      }),
    ).toEqual({ ok: false, message: "Invalid draft revision" });
  });

  it("refuses a revision of the wrong type", () => {
    expect(
      parseRequestBody(workflowDefinitionDraftSaveRequestSchema, {
        expectedDraftRevision: "1",
      }),
    ).toEqual({ ok: false, message: "Invalid draft revision" });
  });
});

describe("workflowDefinitionDeployRequestSchema", () => {
  it("accepts a null deployed version, which means nothing is deployed yet", () => {
    const parsed = parseRequestBody(workflowDefinitionDeployRequestSchema, {
      expectedDraftRevision: 3,
      expectedDeployedVersion: null,
      extra: 1,
    });
    expect(parsed).toEqual({
      ok: true,
      value: { expectedDraftRevision: 3, expectedDeployedVersion: null },
    });
  });

  it("demands the deployed version rather than defaulting it", () => {
    expect(
      parseRequestBody(workflowDefinitionDeployRequestSchema, { expectedDraftRevision: 3 }),
    ).toEqual({ ok: false, message: "Invalid deployed version" });
  });

  it("reports the draft revision first when both are wrong", () => {
    expect(
      parseRequestBody(workflowDefinitionDeployRequestSchema, {
        expectedDraftRevision: -1,
        expectedDeployedVersion: 0,
      }),
    ).toEqual({ ok: false, message: "Invalid draft revision" });
  });
});

describe("workflowDefinitionRollbackRequestSchema", () => {
  it("accepts a version and an expected deployed version", () => {
    expect(
      parseRequestBody(workflowDefinitionRollbackRequestSchema, {
        version: 2,
        expectedDeployedVersion: 4,
      }),
    ).toEqual({ ok: true, value: { version: 2, expectedDeployedVersion: 4 } });
  });

  it("refuses version zero, which names no stored version", () => {
    expect(
      parseRequestBody(workflowDefinitionRollbackRequestSchema, {
        version: 0,
        expectedDeployedVersion: null,
      }),
    ).toEqual({ ok: false, message: "Invalid version" });
  });

  it("refuses a version of the wrong type", () => {
    expect(
      parseRequestBody(workflowDefinitionRollbackRequestSchema, {
        version: "2",
        expectedDeployedVersion: null,
      }),
    ).toEqual({ ok: false, message: "Invalid version" });
  });
});

describe("workflowDefinitionLayoutPatchRequestSchema", () => {
  it("forwards the layout object whole", () => {
    const layout = { nodes: { a: { x: 1, y: 2 } } };
    expect(
      parseRequestBody(workflowDefinitionLayoutPatchRequestSchema, {
        layout,
        expectedLayoutRevision: 0,
      }),
    ).toEqual({ ok: true, value: { layout, expectedLayoutRevision: 0 } });
  });

  it("refuses a missing layout", () => {
    expect(
      parseRequestBody(workflowDefinitionLayoutPatchRequestSchema, {
        expectedLayoutRevision: 0,
      }),
    ).toEqual({ ok: false, message: "Invalid workflow layout" });
  });

  it("refuses a layout that is not an object", () => {
    expect(
      parseRequestBody(workflowDefinitionLayoutPatchRequestSchema, {
        layout: "wide",
        expectedLayoutRevision: 0,
      }),
    ).toEqual({ ok: false, message: "Invalid workflow layout" });
  });

  it("still accepts an array, exactly as the handler's typeof check did", () => {
    const parsed = parseRequestBody(workflowDefinitionLayoutPatchRequestSchema, {
      layout: [],
      expectedLayoutRevision: 0,
    });
    expect(parsed.ok).toBe(true);
  });

  it("refuses a revision that is not a whole number", () => {
    expect(
      parseRequestBody(workflowDefinitionLayoutPatchRequestSchema, {
        layout: {},
        expectedLayoutRevision: -1,
      }),
    ).toEqual({ ok: false, message: "Invalid layout revision" });
  });
});

describe("workflowDefinitionPromptPreviewRequestSchema", () => {
  it("accepts a block id and keeps the candidate untouched", () => {
    expect(
      parseRequestBody(workflowDefinitionPromptPreviewRequestSchema, {
        blockId: "implement",
        definition: { schema: "v2" },
        extra: true,
      }),
    ).toEqual({
      ok: true,
      value: { blockId: "implement", definition: { schema: "v2" } },
    });
  });

  it("refuses a missing block id", () => {
    expect(
      parseRequestBody(workflowDefinitionPromptPreviewRequestSchema, {}),
    ).toEqual({ ok: false, message: "Invalid block id" });
  });

  it("refuses a block id of the wrong type", () => {
    expect(
      parseRequestBody(workflowDefinitionPromptPreviewRequestSchema, { blockId: 3 }),
    ).toEqual({ ok: false, message: "Invalid block id" });
  });

  it("refuses a padded block id rather than trimming it", () => {
    expect(
      parseRequestBody(workflowDefinitionPromptPreviewRequestSchema, {
        blockId: " implement ",
      }),
    ).toEqual({ ok: false, message: "Invalid block id" });
  });
});
