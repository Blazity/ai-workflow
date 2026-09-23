import { describe, expect, it, vi } from "vitest";
import type { IntegrationState, WorkflowDefinitionV2 } from "@shared/contracts";

// The environment module validates every variable at import; nothing here
// reads one.
vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));

vi.mock("../../engine/definition/block-contract-environment.js", () => ({
  builtinCapabilitiesOfDeployment: () => [],
  workflowBlockRegistryContext: (_profile: unknown, integrations: unknown) => ({
    agentProviders: { claude: true, codex: true },
    llmProviders: { claude: true, codex: true },
    defaultAgent: { provider: "claude", model: "claude-test" },
    vcsProviders: [],
    vcsBotIdentities: [],
    webhookTriggerConfigured: true,
    integrations,
  }),
}));

// This deployment: Jira connected and nothing else, answered without a
// database. The prompt half of the editor's validation reads stored prompts,
// which no graph here carries, so it is the plain candidate validation.
vi.mock("./block-contracts.js", async (importActual) => {
  const actual = await importActual<typeof import("./block-contracts.js")>();
  const { integrationManifests } = await import("@integrations/registry");
  const { deploymentIntegrations } = await import("../../engine/definition/integration-availability.js");
  const jira: IntegrationState = {
    integrationId: "jira",
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: { latestVersion: 0, activeVersion: null, missingFields: [], complete: false, prepared: null },
    pin: { integrationId: "jira", configFingerprint: "abc123abc123" },
    secretsKeyAvailable: true,
  };
  return {
    ...actual,
    connectedBlockContracts: async () =>
      actual.blockContractsFor(
        undefined,
        deploymentIntegrations({ manifests: integrationManifests, states: new Map([["jira", jira]]) }),
      ),
  };
});
vi.mock("./prompt-authoring.js", async (importActual) => {
  const actual = await importActual<typeof import("./prompt-authoring.js")>();
  const { validateWorkflowDefinitionCandidate } = await import("../../engine/definition/validation.js");
  return {
    ...actual,
    validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring: async (...args: Parameters<typeof validateWorkflowDefinitionCandidate>) =>
      validateWorkflowDefinitionCandidate(...args),
  };
});

import { validateConnectedDefinitionCandidate } from "./connected-policy-dependencies.js";

function withTemplate(template: string): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "start",
        type: "trigger_plan_approved",
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "look",
        type: "investigate",
        x: 0,
        y: 0,
        configuration: { sources: ["issue_tracker"], issueTrackerQueryTemplate: template },
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [{ id: "start-look", from: "start", to: "look" }],
  };
}

/**
 * The editor's validate panel, the answer the dashboard decides Deploy on. A
 * template the deployed version already runs is said, as a notice, and never
 * counted against `valid`; the same template written new is an issue.
 */
describe("the validate panel on a query template Jira would not run", () => {
  it("reports a template the deployed version runs as a notice and keeps the graph valid", async () => {
    const baseline = await validateConnectedDefinitionCandidate(withTemplate("labels = support"), { deployed: null });
    expect(baseline.response.valid).toBe(true);

    const live = withTemplate("labels = 'backend");
    const validation = await validateConnectedDefinitionCandidate(live, { deployed: live });
    expect(validation.response.valid).toBe(true);
    expect(validation.response.issues).toEqual([]);
    expect(validation.response.notices).toEqual([
      expect.objectContaining({
        code: "tracker_query_not_run",
        nodeId: "look",
        message: expect.stringMatching(/^Jira does not run this query/u),
      }),
    ]);
  });

  it("makes the graph invalid when the template is new", async () => {
    const validation = await validateConnectedDefinitionCandidate(withTemplate("labels = 'x"), {
      deployed: withTemplate("labels = 'backend"),
    });
    expect(validation.response.valid).toBe(false);
    expect(validation.response.issues).toEqual([
      expect.objectContaining({ code: "tracker_query_refused", nodeId: "look" }),
    ]);
    expect(validation.response.notices).toBeUndefined();
  });
});
