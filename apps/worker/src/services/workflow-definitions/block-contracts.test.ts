import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionV2 } from "@shared/contracts";

import type { IntegrationState } from "@shared/contracts";
import { integrationManifests } from "@integrations/registry";
import {
  deploymentIntegrations,
  NO_INTEGRATIONS,
  type DeploymentIntegrations,
} from "../../engine/definition/integration-availability.js";
import { MESSAGING_CONNECTED } from "../../engine/definition/messaging-deployment.fixture.js";

const mocks = vi.hoisted(() => ({
  contextFromEnv: vi.fn((_profile?: unknown, integrations?: unknown) => ({
    agentProviders: { claude: true, codex: true },
    llmProviders: { claude: true, codex: true },
    defaultAgent: { provider: "claude" as const, model: "claude-test" },
    vcsProviders: ["github" as const],
    vcsBotIdentities: ["github" as const],
    webhookTriggerConfigured: true,
    integrations: integrations ?? MESSAGING_CONNECTED,
  })),
}));

vi.mock("../../engine/definition/block-contract-environment.js", () => ({
  workflowBlockRegistryContext: mocks.contextFromEnv,
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
  },
}));

import { analyzeWorkflowV2Catalog } from "@shared/workflow-graph";
import { buildWorkflowEditorOptions } from "../../engine/definition/models.js";
import { validateWorkflowDefinitionCandidate } from "../../engine/definition/validation.js";
import { blockContractsFor } from "./block-contracts.js";
import { testSettingsSnapshot } from "../../test-support/settings.js";

const definition: WorkflowDefinitionV2 = {
  schemaVersion: 2,
  nodes: [{
    id: "entry",
    type: "trigger_ticket_ai",
    x: 0,
    y: 0,
    configuration: {},
    inputs: {},
    additionalInputs: [],
  }],
  edges: [],
};

describe("block contracts per request", () => {
  it("builds the resolver once when validation, available values and models are all consulted", () => {
    mocks.contextFromEnv.mockClear();

    const contracts = blockContractsFor(undefined, NO_INTEGRATIONS);
    validateWorkflowDefinitionCandidate(
      definition,
      contracts.resolveContract,
      contracts.blockParamsSchemas,
      contracts.configuredVcsProviders,
      contracts.analyzeValues,
    );
    analyzeWorkflowV2Catalog(contracts.analyzeValues(definition));
    const options = buildWorkflowEditorOptions(
      testSettingsSnapshot(),
      { claude: [], codex: [] },
      [],
      contracts.blockRegistry(),
    );

    expect(options.blockRegistry.trigger_ticket_ai.availability.available).toBe(true);
    expect(mocks.contextFromEnv).toHaveBeenCalledTimes(1);
  });

  it("reads the environment again for the next request", () => {
    mocks.contextFromEnv.mockClear();
    blockContractsFor(undefined, NO_INTEGRATIONS).blockRegistry();
    blockContractsFor(undefined, NO_INTEGRATIONS).blockRegistry();
    expect(mocks.contextFromEnv).toHaveBeenCalledTimes(2);
  });

  it("resolves the editor's block table only when a request reads it", () => {
    mocks.contextFromEnv.mockClear();
    const contracts = blockContractsFor(undefined, NO_INTEGRATIONS);
    expect(contracts.blockRegistry()).toBe(contracts.blockRegistry());
    expect(mocks.contextFromEnv).toHaveBeenCalledTimes(1);
  });
});

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
 * The investigate block's query template is written in the tracker's own
 * language, so saving a definition asks that tracker, through the rule its
 * adapter applies before it sends one. Before, core kept its own copy, which
 * refused valid JQL (`summary ~ 'fix)'`) and saved templates Jira's adapter
 * then dropped at run time, so the block searched without them and nobody was
 * told.
 */
describe("a query template is checked by the tracker it will be sent to", () => {
  const jira = deploymentIntegrations({
    manifests: integrationManifests,
    states: new Map([["jira", connected("jira")]]),
  });

  function templateIssues(template: string, integrations: DeploymentIntegrations) {
    const contracts = blockContractsFor(undefined, integrations);
    const candidate: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [{
        id: "look",
        type: "investigate",
        x: 0,
        y: 0,
        configuration: { issueTrackerQueryTemplate: template },
        inputs: {},
        additionalInputs: [],
      }],
      edges: [],
    };
    const { response } = validateWorkflowDefinitionCandidate(
      candidate,
      contracts.resolveContract,
      contracts.blockParamsSchemas,
      contracts.configuredVcsProviders,
      contracts.analyzeValues,
    );
    return response.issues.filter((issue) => /issueTrackerQueryTemplate/u.test(issue.path ?? ""));
  }

  it("saves a template Jira runs, quotes and parentheses inside values included", () => {
    expect(templateIssues("summary ~ 'fix)'", jira)).toEqual([]);
    expect(templateIssues(`summary ~ 'O"Brien'`, jira)).toEqual([]);
  });

  it("refuses a template Jira's adapter would drop, saying why", () => {
    const refused = templateIssues("labels = 'backend", jira);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toMatch(/Jira would not run this query, so the block would search without it\. .*never closed/u);
    expect(templateIssues(String.raw`summary ~ foo\-bar`, jira)[0]!.message).toMatch(/backslash outside a quoted value/u);
  });

  it("checks only the length when no tracker is connected to ask", () => {
    expect(templateIssues("labels = 'backend", NO_INTEGRATIONS)).toEqual([]);
  });
});
