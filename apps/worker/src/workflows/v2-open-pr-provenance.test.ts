import { describe, expect, it } from "vitest";
import type {
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { v2OpenPrRepositoriesProvenanceIssue } from "./agent.js";

const repositories = [
  {
    provider: "github" as const,
    repoPath: "acme/app",
    branchName: "ai-workflow/AIW-120",
    defaultBranch: "main",
    expectedHead: "before",
    pushedHead: "after",
  },
];

function openNode(): WorkflowDefinitionV2Node {
  return {
    id: "open",
    type: "open_pr",
    x: 0,
    y: 0,
    configuration: {},
    inputs: {
      repositories: {
        kind: "reference",
        reference: "steps.finalize.output.repositories",
      },
    },
    additionalInputs: [],
  };
}

function definition(open = openNode()): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "trigger",
        type: "trigger_ticket_ai",
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "finalize",
        type: "finalize_workspace",
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
      open,
    ],
    edges: [],
  };
}

describe("v2 Open PR Finalize provenance", () => {
  it("accepts only the exact bound output from the matching finalized boundary", () => {
    expect(
      v2OpenPrRepositoriesProvenanceIssue({
        node: openNode(),
        definition: definition(),
        steps: {
          finalize: {
            output: { status: "finalized", repositories },
          },
        },
        resolvedInputs: { repositories },
        publication: {
          status: "finalized",
          repositories,
          prs: [],
        },
      }),
    ).toBeNull();
  });

  it("rejects literals, forged values, and missing finalized state", () => {
    const literal = openNode();
    literal.inputs.repositories = {
      kind: "literal",
      value: repositories,
    };
    expect(
      v2OpenPrRepositoriesProvenanceIssue({
        node: literal,
        definition: definition(literal),
        steps: {},
        resolvedInputs: { repositories },
        publication: null,
      }),
    ).toContain("must come from");

    expect(
      v2OpenPrRepositoriesProvenanceIssue({
        node: openNode(),
        definition: definition(),
        steps: {
          finalize: {
            output: { status: "finalized", repositories },
          },
        },
        resolvedInputs: {
          repositories: [{ ...repositories[0], pushedHead: "forged" }],
        },
        publication: {
          status: "finalized",
          repositories,
          prs: [],
        },
      }),
    ).toContain("do not match");

    expect(
      v2OpenPrRepositoriesProvenanceIssue({
        node: openNode(),
        definition: definition(),
        steps: {
          finalize: {
            output: { status: "finalized", repositories },
          },
        },
        resolvedInputs: { repositories },
        publication: null,
      }),
    ).toContain("no matching finalized");
  });
});
