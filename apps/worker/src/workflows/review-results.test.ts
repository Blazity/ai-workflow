import { describe, expect, it } from "vitest";
import { normalizeReviewResultsInput } from "./review-results.js";

describe("normalizeReviewResultsInput", () => {
  it("projects compatible envelopes onto the canonical ordered result", () => {
    expect(
      normalizeReviewResultsInput([
        {
          status: "reviewed",
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Handle the rejected input.",
              severity: "Blocker",
              startLine: 10,
              endLine: 12,
              providerMetadata: "discarded",
            },
          ],
          feedback: "One issue.",
          customField: true,
        },
        {
          decision: "approve",
          findings: [],
        },
      ]),
    ).toEqual({
      ok: true,
      value: [
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Handle the rejected input.",
              severity: "Blocker",
              startLine: 10,
              endLine: 12,
            },
          ],
          feedback: "One issue.",
        },
        {
          decision: "approve",
          findings: [],
        },
      ],
    });
  });

  it("rejects empty lists and invalid line ranges", () => {
    expect(normalizeReviewResultsInput([])).toEqual({
      ok: false,
      message: "reviewResults must contain at least one Review Result.",
    });
    expect(
      normalizeReviewResultsInput([
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Bad range.",
              severity: "Blocker",
              startLine: 12,
              endLine: 10,
            },
          ],
        },
      ]),
    ).toEqual({
      ok: false,
      message:
        "reviewResults[0].findings[0].endLine must be greater than or equal to startLine.",
    });
  });
});
