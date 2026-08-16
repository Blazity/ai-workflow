import { createHash } from "node:crypto";
import { canonicalJson } from "./workspace-gate-fingerprint.js";

export interface ClarificationDecisionDigest {
  ticketDigest: string;
  ticketBytes: number;
  contextDigest: string;
  contextBytes: number;
}

/**
 * Deterministic SHA-256 digests of the ticket input (title, description,
 * comments, prior clarification answers) and the retrieved repo/context the
 * model saw when it decided whether to ask for clarification (AIW-267).
 * Digests instead of raw content, so the decision stays comparable across
 * runs (same ticket + same context -> same digest) without storing the ticket
 * body a second time. Both inputs go through the same recursively key-sorted,
 * undefined-dropping canonicalJson the workspace fingerprint uses, since a
 * plain JSON.stringify is sensitive to the source object's own key order (the
 * ticket value is spread from an externally-sourced object) and would defeat
 * "same ticket -> same digest".
 */
export function digestClarificationDecisionInputs(
  ticketValue: unknown,
  contextValue: unknown,
): ClarificationDecisionDigest {
  const ticketJson = canonicalJson(ticketValue ?? null);
  const contextJson = canonicalJson(contextValue ?? null);
  return {
    ticketDigest: createHash("sha256").update(ticketJson, "utf8").digest("hex"),
    ticketBytes: Buffer.byteLength(ticketJson, "utf8"),
    contextDigest: createHash("sha256").update(contextJson, "utf8").digest("hex"),
    contextBytes: Buffer.byteLength(contextJson, "utf8"),
  };
}
