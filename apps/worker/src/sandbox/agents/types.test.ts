import { describe, it, expect } from "vitest";
import {
  AGENT_SCHEMA,
  RESEARCH_SCHEMA,
  agentOutputSchema,
  foldResearchOutput,
  researchOutputSchema,
  type ResearchOutput,
} from "./types.js";

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

  it("accepts a valid reviewThreads entry", () => {
    const result = researchOutputSchema.safeParse({
      status: "completed",
      plan: "Done.",
      reviewThreads: [
        { alias: "T1", disposition: "actionable" },
        {
          alias: "T2",
          disposition: "already_addressed",
          evidence: { filePath: "src/index.ts", quote: "return x;" },
        },
        { alias: "T3", disposition: "question", reply: "Can you clarify?" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a reviewThreads alias that does not match ^T[0-9]+$", () => {
    const result = researchOutputSchema.safeParse({
      status: "completed",
      plan: "Done.",
      reviewThreads: [{ alias: "X1", disposition: "actionable" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown reviewThreads disposition kind", () => {
    const result = researchOutputSchema.safeParse({
      status: "completed",
      plan: "Done.",
      reviewThreads: [{ alias: "T1", disposition: "bogus" }],
    });
    expect(result.success).toBe(false);
  });

  // Optional like its siblings (noChangeNeeded, resolutionEvidence, ...): absent
  // parses to undefined, not a schema-level default. Callers fall back with
  // `?? []`, same as those; see foldResearchOutput below.
  it("leaves reviewThreads undefined when absent, like its sibling optional fields", () => {
    const result = researchOutputSchema.parse({
      status: "completed",
      plan: "Done.",
    });
    expect(result.reviewThreads).toBeUndefined();
  });

  it("rejects more than 20 reviewThreads entries", () => {
    const reviewThreads = Array.from({ length: 21 }, (_, i) => ({
      alias: `T${i + 1}`,
      disposition: "actionable" as const,
    }));
    const result = researchOutputSchema.safeParse({
      status: "completed",
      plan: "Done.",
      reviewThreads,
    });
    expect(result.success).toBe(false);
  });
});

describe("agentOutputSchema reviewThreads", () => {
  it("accepts a valid reviewThreads entry", () => {
    const result = agentOutputSchema.safeParse({
      result: "implemented",
      reviewThreads: [{ alias: "T1", disposition: "out_of_scope", reply: "Not in scope." }],
    });
    expect(result.success).toBe(true);
  });

  it("leaves reviewThreads undefined when absent, like its sibling optional fields", () => {
    const result = agentOutputSchema.parse({ result: "implemented" });
    expect(result.reviewThreads).toBeUndefined();
  });
});

describe("reviewThreads zod/JSON schema key parity", () => {
  it("AGENT_SCHEMA properties match agentOutputSchema's keys", () => {
    const jsonKeys = Object.keys(JSON.parse(AGENT_SCHEMA).properties).sort();
    const zodKeys = Object.keys(agentOutputSchema.shape).sort();
    expect(jsonKeys).toEqual(zodKeys);
  });

  it("RESEARCH_SCHEMA properties match researchOutputSchema's keys", () => {
    const jsonKeys = Object.keys(JSON.parse(RESEARCH_SCHEMA).properties).sort();
    const zodKeys = Object.keys(researchOutputSchema.shape).sort();
    expect(jsonKeys).toEqual(zodKeys);
  });
});
