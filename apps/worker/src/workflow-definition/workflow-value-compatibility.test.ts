import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowValueCompatibility,
  type WorkflowDataCatalogEntry,
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
      evaluateWorkflowValueCompatibility(
        entry({
          availability: {
            state: "unavailable",
            reason: "The step is not guaranteed on this path.",
          },
        }),
        { kind: "mixed_text" },
      ).reason?.code,
    ).toBe("graph_unavailable");
    expect(
      evaluateWorkflowValueCompatibility(
        entry({ presence: "optional" }),
        { kind: "mixed_text" },
      ).reason?.code,
    ).toBe("presence_optional");
    expect(
      evaluateWorkflowValueCompatibility(
        entry({ presence: "nullable", schema: { type: ["number", "null"] } }),
        { kind: "mixed_text" },
      ).reason?.code,
    ).toBe("nullable");
    expect(
      evaluateWorkflowValueCompatibility(
        entry({ schema: { type: "object" } }),
        { kind: "mixed_text" },
      ).reason?.code,
    ).toBe("type_mismatch");
  });

  it("uses the same required source rule for scalar Transforms", () => {
    expect(
      evaluateWorkflowValueCompatibility(entry(), {
        kind: "transform_number",
      }),
    ).toEqual({ compatible: true });
    expect(
      evaluateWorkflowValueCompatibility(entry({ presence: "optional" }), {
        kind: "transform_number",
      }).reason?.code,
    ).toBe("presence_optional");
  });

  it("distinguishes whole-input compatibility from array-item compatibility", () => {
    const listItem = entry({
      compatibleInputNames: [],
      compatibleListInputNames: ["reviews"],
    });

    expect(
      evaluateWorkflowValueCompatibility(listItem, {
        kind: "typed_input",
        inputName: "reviews",
      }).reason?.code,
    ).toBe("type_mismatch");
    expect(
      evaluateWorkflowValueCompatibility(listItem, {
        kind: "typed_list_item",
        inputName: "reviews",
      }),
    ).toEqual({ compatible: true });
  });
});
