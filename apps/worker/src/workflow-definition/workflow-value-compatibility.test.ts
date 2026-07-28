import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowValueCompatibility,
  type WorkflowDataCatalogEntry,
  type WorkflowValueCompatibility,
} from "@shared/contracts";

function entry(
  overrides: Partial<WorkflowDataCatalogEntry> = {},
): WorkflowDataCatalogEntry {
  return {
    reference: "steps.open.output.prNumber",
    label: "Open pull request · prNumber",
    description: "Primary pull request number.",
    schema: { type: "number" },
    source: { kind: "step", nodeId: "open" },
    presence: "required",
    availability: { state: "available", guarantee: "Guaranteed." },
    compatibleInputNames: [],
    ...overrides,
  };
}

function reasonCode(
  compatibility: WorkflowValueCompatibility,
): string | null {
  return compatibility.compatible ? null : compatibility.reason.code;
}

describe("workflow value compatibility", () => {
  it("allows guaranteed numbers and text in mixed text", () => {
    expect(
      evaluateWorkflowValueCompatibility(entry(), { kind: "mixed_text" }),
    ).toEqual({ compatible: true });
    expect(
      evaluateWorkflowValueCompatibility(
        entry({ schema: { type: "string", enum: ["approved"] } }),
        { kind: "mixed_text" },
      ),
    ).toEqual({ compatible: true });
  });

  it("reports graph, presence, nullability, and type separately", () => {
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(
          entry({
            availability: {
              state: "unavailable",
              reason: "The step is not guaranteed on this path.",
            },
          }),
          { kind: "mixed_text" },
        ),
      ),
    ).toBe("graph_unavailable");
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(
          entry({ presence: "optional" }),
          { kind: "mixed_text" },
        ),
      ),
    ).toBe("presence_optional");
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(
          entry({ presence: "nullable", schema: { type: ["number", "null"] } }),
          { kind: "mixed_text" },
        ),
      ),
    ).toBe("nullable");
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(
          entry({ schema: { type: "object" } }),
          { kind: "mixed_text" },
        ),
      ),
    ).toBe("type_mismatch");
  });

  it("uses the same required source rule for scalar Transforms", () => {
    expect(
      evaluateWorkflowValueCompatibility(entry(), {
        kind: "transform_number",
      }),
    ).toEqual({ compatible: true });
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(entry({ presence: "optional" }), {
          kind: "transform_number",
        }),
      ),
    ).toBe("presence_optional");
  });

  it("covers typed, text-transform, and build-object destinations", () => {
    expect(
      evaluateWorkflowValueCompatibility(
        entry({ compatibleInputNames: ["score"] }),
        { kind: "typed_input", inputName: "score" },
      ),
    ).toEqual({ compatible: true });
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(entry(), {
          kind: "typed_input",
          inputName: "score",
        }),
      ),
    ).toBe("type_mismatch");
    expect(
      evaluateWorkflowValueCompatibility(
        entry({ schema: { type: "string" } }),
        { kind: "transform_text" },
      ),
    ).toEqual({ compatible: true });
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(entry(), {
          kind: "transform_text",
        }),
      ),
    ).toBe("type_mismatch");
    expect(
      evaluateWorkflowValueCompatibility(
        entry({ presence: "optional", schema: { type: "object" } }),
        { kind: "build_object" },
      ),
    ).toEqual({ compatible: true });
  });

  it("gates Branch presence handling on allowMissing", () => {
    const optional = entry({ presence: "optional" });
    expect(
      evaluateWorkflowValueCompatibility(optional, {
        kind: "branch",
        allowMissing: true,
      }),
    ).toEqual({ compatible: true });
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(optional, {
          kind: "branch",
        }),
      ),
    ).toBe("presence_optional");
    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(
          entry({ schema: { type: "object" } }),
          { kind: "branch", allowMissing: true },
        ),
      ),
    ).toBe("unsupported_destination");
  });

  it("distinguishes whole-input compatibility from array-item compatibility", () => {
    const listItem = entry({
      compatibleInputNames: [],
      compatibleListInputNames: ["reviews"],
    });

    expect(
      reasonCode(
        evaluateWorkflowValueCompatibility(listItem, {
          kind: "typed_input",
          inputName: "reviews",
        }),
      ),
    ).toBe("type_mismatch");
    expect(
      evaluateWorkflowValueCompatibility(listItem, {
        kind: "typed_list_item",
        inputName: "reviews",
      }),
    ).toEqual({ compatible: true });
  });
});
