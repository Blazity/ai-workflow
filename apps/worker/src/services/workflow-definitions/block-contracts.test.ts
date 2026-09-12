import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionV2 } from "@shared/contracts";

const mocks = vi.hoisted(() => ({
  contextFromEnv: vi.fn(() => ({
    agentProviders: { claude: true, codex: true },
    llmProviders: { claude: true, codex: true },
    defaultAgent: { provider: "claude" as const, model: "claude-test" },
    vcsProviders: ["github" as const],
    vcsBotIdentities: ["github" as const],
    slackConfigured: true,
    arthurConfigured: true,
    webhookTriggerConfigured: true,
  })),
}));

vi.mock("../../engine/definition/block-contract-environment.js", () => ({
  workflowBlockRegistryContextFromEnv: mocks.contextFromEnv,
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-opus-4-8",
    CODEX_MODEL: "gpt-5.4",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
  },
}));

import { analyzeWorkflowV2Catalog } from "../../workflow-definition/available-values.js";
import { buildWorkflowEditorOptions } from "../../workflow-definition/models.js";
import { validateWorkflowDefinitionCandidate } from "../../workflow-definition/validation.js";
import { currentBlockContracts } from "./block-contracts.js";
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

    const contracts = currentBlockContracts();
    validateWorkflowDefinitionCandidate(
      definition,
      contracts.resolveContract,
      contracts.blockParamsSchemas,
      contracts.configuredVcsProviders,
    );
    analyzeWorkflowV2Catalog(definition, contracts.resolveContract);
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
    currentBlockContracts().blockRegistry();
    currentBlockContracts().blockRegistry();
    expect(mocks.contextFromEnv).toHaveBeenCalledTimes(2);
  });

  it("resolves the editor's block table only when a request reads it", () => {
    mocks.contextFromEnv.mockClear();
    const contracts = currentBlockContracts();
    expect(contracts.blockRegistry()).toBe(contracts.blockRegistry());
    expect(mocks.contextFromEnv).toHaveBeenCalledTimes(1);
  });
});
