import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import { canonicalizeWorkflowBlockTypes } from "./workflow-graph.js";

/**
 * `investigate`'s parameters moved from provider names to capability ids
 * (`providers`/`jira`/`slack` to `sources`/`issue_tracker`/`chat`). A stored
 * definition the one-off rewrite has not reached, and a run suspended before
 * the rename replaying its recorded plan, both still hand this function the
 * old words, so it has to keep reading them.
 */

function investigateNode(configuration: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "investigate",
        type: "investigate",
        name: "Gather evidence",
        x: 0,
        y: 0,
        configuration,
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  };
}

describe("canonicalizeWorkflowBlockTypes: investigate parameter rename", () => {
  it("rewrites the old parameter names and provider values to the new vocabulary", () => {
    const raw = investigateNode({
      providers: ["jira", "slack"],
      slackChannels: ["C_SUPPORT"],
      slackLookbackDays: 30,
      jiraJqlTemplate: "project = ENG",
      maxResults: 10,
    });

    const result = canonicalizeWorkflowBlockTypes(raw) as typeof raw;

    expect(result.nodes[0]!.configuration).toEqual({
      sources: ["issue_tracker", "chat"],
      chatChannels: ["C_SUPPORT"],
      chatLookbackDays: 30,
      issueTrackerQueryTemplate: "project = ENG",
      maxResults: 10,
    });
  });

  it("leaves a graph that already carries the new vocabulary unchanged, by reference", () => {
    const raw = investigateNode({
      sources: ["issue_tracker", "chat"],
      chatChannels: ["C_SUPPORT"],
      chatLookbackDays: 30,
      issueTrackerQueryTemplate: "project = ENG",
      maxResults: 10,
    });

    const result = canonicalizeWorkflowBlockTypes(raw);

    expect(result).toBe(raw);
  });

  it("renames only the source values that need it, leaving an already-canonical one alone", () => {
    const raw = investigateNode({ sources: ["jira", "chat"] });

    const result = canonicalizeWorkflowBlockTypes(raw) as typeof raw;

    expect(result.nodes[0]!.configuration).toEqual({
      sources: ["issue_tracker", "chat"],
    });
  });

  it("does not touch a node of a different type carrying an unrelated `providers` key", () => {
    const raw = {
      schemaVersion: 2,
      nodes: [
        {
          id: "other",
          type: "transform",
          name: "Unrelated",
          x: 0,
          y: 0,
          configuration: { providers: ["jira"] },
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [],
    };

    const result = canonicalizeWorkflowBlockTypes(raw);

    expect(result).toBe(raw);
  });
});
