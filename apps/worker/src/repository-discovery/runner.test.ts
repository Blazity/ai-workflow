import { describe, expect, it } from "vitest";
import {
  REPOSITORY_DISCOVERY_SCHEMA,
  assembleRepositoryDiscoveryPrompt,
  validateRepositoryExpansionRequests,
} from "./runner.js";

describe("repository discovery harness protocol", () => {
  it("uses a strict bounded output schema", () => {
    const schema = JSON.parse(REPOSITORY_DISCOVERY_SCHEMA);

    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.repositories.anyOf[0].maxItems).toBe(3);
    expect(schema.required).toEqual([
      "status",
      "repositories",
      "confidence",
      "questions",
      "error",
    ]);
  });

  it("includes only bounded catalog metadata and mandatory identities", () => {
    const prompt = assembleRepositoryDiscoveryPrompt({
      ticket: {
        identifier: "AIW-147",
        title: "Research shared workflow",
        description: "Find the owning service",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      discovery: {
        catalog: [
          {
            provider: "github",
            repoPath: "acme/api",
            name: "api",
            defaultBranch: "main",
            description: "API",
            topics: ["typescript"],
            usable: true,
          },
        ],
        mandatoryRepositories: [],
      },
    });

    expect(prompt).toContain('"repoPath":"acme/api"');
    expect(prompt).toContain("at most 3 repositories");
    expect(prompt).not.toContain("cloneUrl");
  });
});

describe("repository expansion validation", () => {
  const catalog = [
    {
      provider: "gitlab" as const,
      repoPath: "acme/shared/contracts",
      name: "contracts",
      defaultBranch: "main",
      description: "",
      topics: [],
      usable: true,
    },
  ];

  it("maps exact fresh-catalog identities to server-owned repository inputs", () => {
    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "Imported types",
          },
        ],
        catalog,
        attached: [{ provider: "github", repoPath: "acme/api" }],
        completedRounds: 0,
      }),
    ).toEqual({
      kind: "attach",
      repositories: [
        {
          provider: "gitlab",
          repoPath: "acme/shared/contracts",
          defaultBranch: "main",
          selectedRationale: "Imported types",
        },
      ],
    });
  });

  it.each([
    {
      name: "third round",
      requests: [
        {
          provider: "gitlab" as const,
          repoPath: "acme/shared/contracts",
          rationale: "imports",
        },
      ],
      attached: [],
      completedRounds: 2,
    },
    {
      name: "unknown repository",
      requests: [
        {
          provider: "github" as const,
          repoPath: "acme/unknown",
          rationale: "guess",
        },
      ],
      attached: [],
      completedRounds: 0,
    },
    {
      name: "already attached repository",
      requests: [
        {
          provider: "gitlab" as const,
          repoPath: "acme/shared/contracts",
          rationale: "imports",
        },
      ],
      attached: [
        { provider: "gitlab" as const, repoPath: "acme/shared/contracts" },
      ],
      completedRounds: 0,
    },
  ])("returns targeted clarification for $name", ({ requests, attached, completedRounds }) => {
    expect(
      validateRepositoryExpansionRequests({
        requests,
        catalog,
        attached,
        completedRounds,
      }).kind,
    ).toBe("clarification_needed");
  });
});
