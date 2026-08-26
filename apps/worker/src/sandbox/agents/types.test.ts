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

  // Top-level key parity says the field exists on both sides, nothing about what
  // an entry may contain. The two copies are hand-kept twins, so a disposition
  // kind, an alias rule or an evidence field added to one and not the other would
  // pass every test above and only show up as a rejected agent payload in a run.
  const reviewThreadsArraySchema = (schema: string) => {
    const property = JSON.parse(schema).properties.reviewThreads;
    const array = property.anyOf.find(
      (option: { type?: string }) => option.type === "array",
    );
    expect(array).toBeDefined();
    return array;
  };

  const cases = [
    {
      name: "AGENT_SCHEMA",
      json: AGENT_SCHEMA,
      accepts: (reviewThreads: unknown[]) =>
        agentOutputSchema.safeParse({ result: "implemented", reviewThreads }).success,
    },
    {
      name: "RESEARCH_SCHEMA",
      json: RESEARCH_SCHEMA,
      accepts: (reviewThreads: unknown[]) =>
        researchOutputSchema.safeParse({
          status: "completed",
          plan: "Done.",
          reviewThreads,
        }).success,
    },
  ];

  for (const { name, json, accepts } of cases) {
    it(`${name} declares the same reviewThreads entry the zod schema accepts`, () => {
      const array = reviewThreadsArraySchema(json);
      const entry = array.items;

      // Strict mode: every declared key is required and nothing else is allowed.
      expect(Object.keys(entry.properties).sort()).toEqual([
        "alias",
        "disposition",
        "evidence",
        "reply",
      ]);
      expect([...entry.required].sort()).toEqual(Object.keys(entry.properties).sort());
      expect(entry.additionalProperties).toBe(false);

      const withEntry = (overrides: Record<string, unknown>) => [
        { alias: "T1", disposition: "actionable", reply: null, evidence: null, ...overrides },
      ];

      // Every disposition the JSON copy offers is one zod takes, and no other.
      expect(entry.properties.disposition.enum).toEqual([
        "actionable",
        "already_addressed",
        "question",
        "out_of_scope",
      ]);
      for (const disposition of entry.properties.disposition.enum) {
        expect(accepts(withEntry({ disposition }))).toBe(true);
      }
      expect(accepts(withEntry({ disposition: "bogus" }))).toBe(false);

      // The alias rule is the same rule on both sides.
      const alias = new RegExp(entry.properties.alias.pattern);
      expect([alias.test("T12"), alias.test("X1")]).toEqual([true, false]);
      expect(accepts(withEntry({ alias: "T12" }))).toBe(true);
      expect(accepts(withEntry({ alias: "X1" }))).toBe(false);

      // Evidence: the same two fields, both required, nothing else.
      const evidence = entry.properties.evidence.anyOf.find(
        (option: { type?: string }) => option.type === "object",
      );
      expect(Object.keys(evidence.properties).sort()).toEqual(["filePath", "quote"]);
      expect([...evidence.required].sort()).toEqual(["filePath", "quote"]);
      expect(evidence.additionalProperties).toBe(false);
      expect(
        accepts(withEntry({ evidence: { filePath: "src/a.ts", quote: "return x;" } })),
      ).toBe(true);
      expect(
        accepts(
          withEntry({ evidence: { filePath: "src/a.ts", quote: "return x;", line: 3 } }),
        ),
      ).toBe(false);

      // The cap the prompt promises is the cap the parser enforces.
      const entries = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
          alias: `T${index + 1}`,
          disposition: "actionable",
          reply: null,
          evidence: null,
        }));
      expect(array.maxItems).toBe(20);
      expect(accepts(entries(array.maxItems))).toBe(true);
      expect(accepts(entries(array.maxItems + 1))).toBe(false);
    });
  }
});
