import { describe, it, expect } from "vitest";
import { foldResearchOutput, researchOutputSchema, type ResearchOutput } from "./types.js";

describe("foldResearchOutput", () => {
  it("round-trips noChangeNeeded and resolutionEvidence on the completed branch", () => {
    const output: ResearchOutput = {
      status: "completed",
      plan: "Already fixed in a prior commit.",
      noChangeNeeded: true,
      resolutionEvidence: [
        "Commit a1b2c3d fixes the reported crash.",
        'Ticket comment: "Fixed" by jdoe.',
      ],
    };

    expect(foldResearchOutput(output)).toEqual({
      status: "completed",
      body: "Already fixed in a prior commit.",
      noChangeNeeded: true,
      resolutionEvidence: [
        "Commit a1b2c3d fixes the reported crash.",
        'Ticket comment: "Fixed" by jdoe.',
      ],
    });
  });

  it("omits noChangeNeeded and resolutionEvidence when absent", () => {
    const output: ResearchOutput = {
      status: "completed",
      plan: "Implement the feature.",
      writeRepositories: [
        { provider: "github", repoPath: "org/repo", rationale: "Owns the code." },
      ],
    };

    const result = foldResearchOutput(output);
    expect(result).toEqual({
      status: "completed",
      body: "Implement the feature.",
      writeRepositories: [
        { provider: "github", repoPath: "org/repo", rationale: "Owns the code." },
      ],
    });
    expect(result).not.toHaveProperty("noChangeNeeded");
    expect(result).not.toHaveProperty("resolutionEvidence");
  });
});

describe("researchOutputSchema", () => {
  it("accepts a payload with both new fields set", () => {
    const result = researchOutputSchema.safeParse({
      status: "completed",
      plan: "Already resolved.",
      noChangeNeeded: true,
      resolutionEvidence: ["Commit a1b2c3d fixes the issue."],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a legacy payload without the new keys at all", () => {
    const result = researchOutputSchema.safeParse({
      status: "completed",
      plan: "Implement the feature.",
      writeRepositories: [
        { provider: "github", repoPath: "org/repo", rationale: "Owns the code." },
      ],
      repositoryEvidence: ["src/index.ts contains the affected logic."],
    });
    expect(result.success).toBe(true);
  });

  it("accepts noChangeNeeded=true with missing resolutionEvidence (no cross-field rejection)", () => {
    const result = researchOutputSchema.safeParse({
      status: "completed",
      plan: "Already resolved.",
      noChangeNeeded: true,
    });
    expect(result.success).toBe(true);
  });
});
