import { describe, it, expect } from "vitest";
import { resolveTicketMoveTarget } from "./ticket-move-target.js";

describe("resolveTicketMoveTarget", () => {
  it("maps 'backlog' to backlog", () => {
    expect(resolveTicketMoveTarget("backlog")).toBe("backlog");
  });

  it("maps 'ai_review' to ai_review", () => {
    expect(resolveTicketMoveTarget("ai_review")).toBe("ai_review");
  });

  it("maps any other value to ai_review", () => {
    expect(resolveTicketMoveTarget("done")).toBe("ai_review");
    expect(resolveTicketMoveTarget("")).toBe("ai_review");
    expect(resolveTicketMoveTarget(undefined)).toBe("ai_review");
    expect(resolveTicketMoveTarget("unknown")).toBe("ai_review");
  });
});
