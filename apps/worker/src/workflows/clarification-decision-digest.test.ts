import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestClarificationDecisionInputs } from "./clarification-decision-digest.js";
import { canonicalJson } from "./workspace-gate-fingerprint.js";

describe("digestClarificationDecisionInputs", () => {
  it("is deterministic for the same ticket value and context", () => {
    const first = digestClarificationDecisionInputs(
      { title: "Ticket body" },
      { repo: "a" },
    );
    const second = digestClarificationDecisionInputs(
      { title: "Ticket body" },
      { repo: "a" },
    );
    expect(first).toEqual(second);
  });

  it("matches an independently computed sha256 of the canonicalized ticket value", () => {
    const digest = digestClarificationDecisionInputs({ title: "Ticket body" }, null);
    const ticketJson = canonicalJson({ title: "Ticket body" });
    expect(digest.ticketDigest).toBe(
      createHash("sha256").update(ticketJson, "utf8").digest("hex"),
    );
    expect(digest.ticketBytes).toBe(Buffer.byteLength(ticketJson, "utf8"));
  });

  it("produces the same digest for the same ticket regardless of key order (AIW-267 comparability)", () => {
    // The resolved ticket value is spread from an externally-sourced object
    // whose key order this code does not control, and conditionally includes
    // a `clarifications` key. Two runs carrying the same ticket content must
    // still hash identically for "same ticket -> same digest" to hold.
    const inOneOrder = {
      identifier: "AIW-267",
      title: "Two identical tickets",
      description: "Same content",
      clarifications: [{ questions: ["Which env?"], answer: "prod" }],
    };
    const inAnotherOrder = {
      clarifications: [{ questions: ["Which env?"], answer: "prod" }],
      description: "Same content",
      title: "Two identical tickets",
      identifier: "AIW-267",
    };
    const context = { z: 1, a: 2 };
    const reorderedContext = { a: 2, z: 1 };

    const first = digestClarificationDecisionInputs(inOneOrder, context);
    const second = digestClarificationDecisionInputs(inAnotherOrder, reorderedContext);

    expect(first.ticketDigest).toBe(second.ticketDigest);
    expect(first.contextDigest).toBe(second.contextDigest);
  });

  it("changes the ticket digest when the ticket value changes, holding context fixed", () => {
    const context = { repo: "a" };
    const first = digestClarificationDecisionInputs({ title: "Ticket A" }, context);
    const second = digestClarificationDecisionInputs({ title: "Ticket B" }, context);
    expect(first.ticketDigest).not.toBe(second.ticketDigest);
    expect(first.contextDigest).toBe(second.contextDigest);
  });

  it("changes the context digest when the retrieved context changes, holding the ticket fixed", () => {
    const ticket = { title: "Ticket A" };
    const first = digestClarificationDecisionInputs(ticket, { repo: "a" });
    const second = digestClarificationDecisionInputs(ticket, { repo: "b" });
    expect(first.contextDigest).not.toBe(second.contextDigest);
    expect(first.ticketDigest).toBe(second.ticketDigest);
  });

  it("treats undefined context the same as null", () => {
    const ticket = { title: "Ticket A" };
    const withNull = digestClarificationDecisionInputs(ticket, null);
    const withUndefined = digestClarificationDecisionInputs(ticket, undefined);
    expect(withNull.contextDigest).toBe(withUndefined.contextDigest);
  });

  it("never leaks raw ticket or context text into the digest output", () => {
    const digest = digestClarificationDecisionInputs(
      { description: "super secret ticket body" },
      { token: "sk-should-not-appear" },
    );
    const serialized = JSON.stringify(digest);
    expect(serialized).not.toContain("super secret ticket body");
    expect(serialized).not.toContain("sk-should-not-appear");
  });
});
