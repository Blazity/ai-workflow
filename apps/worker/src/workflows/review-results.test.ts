import { describe, expect, it } from "vitest";
import {
  isCrossRepositoryFinding,
  normalizeReviewResultsInput,
} from "./review-results.js";

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

  it("keeps only repository attribution recognized in this run", () => {
    const result = normalizeReviewResultsInput(
      [
        {
          decision: "request_changes",
          findings: [
            {
              file: "src/a.ts",
              description: "Sibling issue.",
              severity: "High",
              repo: "acme/api",
            },
            {
              file: "src/b.ts",
              description: "Unknown owner.",
              severity: "Medium",
              repo: "api",
            },
            {
              file: "src/c.ts",
              description: "Unknown URL.",
              severity: "Nit",
              repo: "https://github.com/acme/web",
            },
            {
              file: "src/d.ts",
              description: "Not selected in this run.",
              severity: "Nit",
              repo: "acme/other",
            },
          ],
        },
      ],
      { knownRepositories: ["acme/web", "acme/api"] },
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          decision: "request_changes",
          findings: [
            expect.objectContaining({ repo: "acme/api" }),
            expect.not.objectContaining({ repo: expect.anything() }),
            expect.not.objectContaining({ repo: expect.anything() }),
            expect.not.objectContaining({ repo: expect.anything() }),
          ],
        },
      ],
    });
  });

  it("classifies a recognized sibling finding without changing old findings", () => {
    expect(
      isCrossRepositoryFinding(
        {
          file: "src/api.ts",
          description: "The endpoint differs.",
          severity: "High",
          repo: "acme/api",
        },
        "acme/web",
      ),
    ).toBe(true);
    expect(
      isCrossRepositoryFinding(
        {
          file: "src/app.ts",
          description: "The local code differs.",
          severity: "Medium",
        },
        "acme/web",
      ),
    ).toBe(false);
  });
});
