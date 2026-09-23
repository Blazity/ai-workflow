import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import { blockTypeSpecOf, isStorableWorkflowBlockType } from "./workflow-graph.js";

/**
 * A definition may name a block an integration contributes, and may keep naming
 * one after the build stops shipping that integration. Core's catalog is
 * generated from core's own blocks, so it can never hold either, and the two
 * helpers here are what keeps a stored graph readable instead of unparseable.
 */

describe("isStorableWorkflowBlockType", () => {
  it("accepts a core block type", () => {
    expect(isStorableWorkflowBlockType("post_ticket_comment")).toBe(true);
  });

  it("accepts a block type an integration contributes", () => {
    expect(isStorableWorkflowBlockType("acmenotify_announce")).toBe(true);
  });

  it("refuses what no integration could have produced", () => {
    expect(isStorableWorkflowBlockType("Announce")).toBe(false);
    expect(isStorableWorkflowBlockType("no-underscore")).toBe(false);
    expect(isStorableWorkflowBlockType("ab_short")).toBe(false);
    expect(isStorableWorkflowBlockType(42)).toBe(false);
  });
});

describe("blockTypeSpecOf", () => {
  it("gives a core block its own spec", () => {
    expect(blockTypeSpecOf("branch").category).toBe("control");
  });

  it("gives a type core does not own one action port rather than throwing", () => {
    expect(blockTypeSpecOf("acmenotify_announce")).toEqual({
      category: "action",
      ports: ["out"],
      allowsFailurePort: false,
    });
  });
});
