import { describe, expect, it } from "vitest";
import {
  containsMalformedPromptDataToken,
  containsMalformedPromptSlotToken,
  formatPromptDataToken,
  formatPromptSlotToken,
  isPromptDataReference,
  isPromptSlotBinding,
  isPromptSlotDefinition,
  parsePromptDataTokens,
  parsePromptSlotTokens,
} from "@shared/contracts";

describe("Prompt Slot shared contracts", () => {
  it("formats and parses canonical slot and data tokens losslessly", () => {
    const text = [
      formatPromptSlotToken("plan"),
      formatPromptDataToken("steps.entry.output.ticket.title"),
      formatPromptDataToken("steps.review-agent.output.decision"),
      formatPromptDataToken("run.branchName"),
    ].join(" ");

    expect(parsePromptSlotTokens(text)).toEqual([
      expect.objectContaining({
        raw: "{{slot:plan}}",
        name: "plan",
      }),
    ]);
    expect(parsePromptDataTokens(text).map(({ reference }) => reference)).toEqual(
      [
        "steps.entry.output.ticket.title",
        "steps.review-agent.output.decision",
        "run.branchName",
      ],
    );
  });

  it("detects malformed and unsafe tokens", () => {
    expect(containsMalformedPromptSlotToken("{{slot:plan}}")).toBe(false);
    expect(containsMalformedPromptSlotToken("{{slot:bad name}}")).toBe(true);
    expect(containsMalformedPromptSlotToken("{{ slot:plan }}")).toBe(true);
    expect(containsMalformedPromptSlotToken("{{slot:plan")).toBe(true);
    expect(containsMalformedPromptDataToken("{{data:run.id}}")).toBe(false);
    expect(containsMalformedPromptDataToken("{{data:run.__proto__}}")).toBe(
      true,
    );
    expect(containsMalformedPromptDataToken("{{data:steps.entry.title}}")).toBe(
      true,
    );
    expect(isPromptDataReference("steps.entry.output.ticket")).toBe(true);
    expect(isPromptDataReference("steps.constructor.output.value")).toBe(false);
  });

  it("validates slot definitions and reference-or-literal bindings", () => {
    expect(
      isPromptSlotDefinition({
        name: "plan",
        description: "Implementation plan",
        schema: { type: "string" },
        required: true,
      }),
    ).toBe(true);
    expect(
      isPromptSlotDefinition({
        name: "bad name",
        description: "",
        schema: { type: "string" },
        required: true,
      }),
    ).toBe(false);
    expect(
      isPromptSlotBinding({
        kind: "reference",
        reference: "steps.plan.output.plan",
      }),
    ).toBe(true);
    expect(
      isPromptSlotBinding({
        kind: "literal",
        value: { title: "Ready", attempts: 2 },
      }),
    ).toBe(true);
    expect(
      isPromptSlotBinding({
        kind: "reference",
        reference: "steps.plan.output.__proto__",
      }),
    ).toBe(false);
  });
});
