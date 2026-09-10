import { describe, it, expect } from "vitest";
import { resolveTicketMoveTarget } from "./ticket-move-target.js";

describe("resolveTicketMoveTarget", () => {
  const configured = {
    backlog: { name: "Backlog", transitionId: "11" },
    aiReview: { name: "AI Review", transitionId: "31" },
  };

  it("maps 'backlog' to backlog", () => {
    expect(resolveTicketMoveTarget("backlog", configured)).toEqual(configured.backlog);
  });

  it("maps 'ai_review' to ai_review", () => {
    expect(resolveTicketMoveTarget("ai_review", configured)).toEqual(configured.aiReview);
  });

  it("preserves provider status ids for execution-time transition resolution", () => {
    expect(resolveTicketMoveTarget("10042", configured)).toEqual({
      name: "10042",
      statusId: "10042",
    });
  });

  it("rejects invalid targets instead of silently moving to AI Review", () => {
    expect(() => resolveTicketMoveTarget("", configured)).toThrow("status target");
    expect(() => resolveTicketMoveTarget(undefined, configured)).toThrow("status target");
  });
});
