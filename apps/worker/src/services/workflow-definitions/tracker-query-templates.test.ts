import { describe, expect, it } from "vitest";
import type { IntegrationState, WorkflowDefinitionV2 } from "@shared/contracts";
import type { IntegrationManifest, IssueTrackerQueryRule } from "@integrations/sdk";
import { integrationManifests } from "@integrations/registry";
import { integrationRuntime } from "@integrations/registry/worker";
import { deploymentIntegrations, NO_INTEGRATIONS } from "../../engine/definition/integration-availability.js";
import { trackerQueryRuleFor, trackerQueryTemplateFindings } from "./tracker-query-templates.js";

/** Connected and usable, the only state in which a run would send a query. */
function connected(integrationId: string): IntegrationState {
  return {
    integrationId,
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: { latestVersion: 0, activeVersion: null, missingFields: [], complete: false, prepared: null },
    pin: { integrationId, configFingerprint: "abc123abc123" },
    secretsKeyAvailable: true,
  };
}

/**
 * A second tracker whose rule refuses every query, as a tracker with no
 * search does. If core ever judged a template by a tracker nobody chose, a
 * test holding this one would go red.
 */
const REFUSE_ALL: IssueTrackerQueryRule = { problem: () => "This tracker has no search." };
const OTHER_TRACKER: IntegrationManifest = {
  id: "acmetrack",
  name: "Acme Tracker",
  description: "A tracker with no search.",
  connection: { fields: [] },
  capabilities: ["issue_tracker"],
  blocks: [],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "d", critical: true }],
};

function runtimeOf(id: string) {
  return id === OTHER_TRACKER.id ? { issueTrackerQueryRule: REFUSE_ALL } : integrationRuntime(id);
}

function usable(ids: readonly string[]) {
  return deploymentIntegrations({
    manifests: [...integrationManifests, OTHER_TRACKER],
    states: new Map(ids.map((id) => [id, connected(id)])),
  });
}

describe("which tracker's rule a template is judged by", () => {
  it("is the one usable tracker's own", () => {
    const jira = trackerQueryRuleFor(usable(["jira"]), runtimeOf);
    expect(jira?.name).toBe("Jira");
    expect(jira?.rule.problem("summary ~ 'fix)'")).toBeNull();
    expect(trackerQueryRuleFor(usable(["acmetrack"]), runtimeOf)?.rule.problem("anything")).toBe(
      "This tracker has no search.",
    );
  });

  it("is nobody's with two usable trackers and nobody chosen, or with none", () => {
    expect(trackerQueryRuleFor(usable(["jira", "acmetrack"]), runtimeOf)).toBeNull();
    expect(trackerQueryRuleFor(NO_INTEGRATIONS, runtimeOf)).toBeNull();
  });
});

function withTemplate(template: string, nodeId = "look"): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: nodeId,
        type: "investigate",
        x: 0,
        y: 0,
        configuration: { issueTrackerQueryTemplate: template },
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  };
}

/**
 * The tracker refuses what an author writes now and only reports what the
 * deployed version already runs: refusing that would block every other edit,
 * and a rollback or re-enable, over something that runs today.
 */
describe("what the tracker says about each template", () => {
  const jira = trackerQueryRuleFor(usable(["jira"]), runtimeOf);

  it("says nothing of a template Jira runs, quotes and parentheses inside values included", () => {
    expect(trackerQueryTemplateFindings(withTemplate("summary ~ 'fix)'"), jira, null)).toEqual({ refused: [], standing: [] });
    expect(trackerQueryTemplateFindings(withTemplate(`summary ~ 'O"Brien'`), jira, null)).toEqual({ refused: [], standing: [] });
  });

  it("refuses a new template Jira's adapter would drop, saying why", () => {
    const { refused, standing } = trackerQueryTemplateFindings(withTemplate("labels = 'backend"), jira, null);
    expect(standing).toEqual([]);
    expect(refused).toEqual([
      expect.objectContaining({
        code: "tracker_query_refused",
        nodeId: "look",
        path: "/nodes/0/configuration/issueTrackerQueryTemplate",
        message: expect.stringMatching(/^Jira would not run this query, so the block would search without it\. .*never closed/u),
      }),
    ]);
  });

  it("only reports a template the deployed version already runs, on whichever node carries it", () => {
    const deployed = withTemplate("labels = 'backend");
    const { refused, standing } = trackerQueryTemplateFindings(withTemplate(" labels = 'backend ", "copied"), jira, deployed);
    expect(refused).toEqual([]);
    expect(standing).toEqual([
      expect.objectContaining({ code: "tracker_query_not_run", nodeId: "copied", message: expect.stringMatching(/live in the deployed version/u) }),
    ]);
    expect(trackerQueryTemplateFindings(withTemplate("labels = 'x"), jira, deployed).refused).toHaveLength(1);
  });

  it("asks nobody when no single tracker is usable", () => {
    expect(trackerQueryTemplateFindings(withTemplate("labels = 'backend"), null, null)).toEqual({ refused: [], standing: [] });
  });
});
