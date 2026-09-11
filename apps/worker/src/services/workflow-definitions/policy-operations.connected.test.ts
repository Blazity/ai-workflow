import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deploy: vi.fn(),
  rollback: vi.fn(),
  update: vi.fn(),
  getDefinition: vi.fn(),
  getVersion: vi.fn(),
  sync: vi.fn(),
  validatePrompts: vi.fn(),
  selectDeployment: vi.fn(),
  selectRollback: vi.fn(),
  updateLifecycle: vi.fn(),
}));

vi.mock("../../db/repositories/definitions/connected.js", () => ({
  archiveConnectedDefinition: vi.fn(),
  createConnectedDefinition: vi.fn(),
  createConnectedDefinitionDraft: vi.fn(),
  deployConnectedDefinition: mocks.deploy,
  getConnectedWorkflowDefinition: mocks.getDefinition,
  getConnectedWorkflowDefinitionVersion: mocks.getVersion,
  readConnectedTriggerBinding: vi.fn().mockResolvedValue(null),
  listConnectedEnabledTriggerBindingCandidates: vi.fn().mockResolvedValue([]),
  claimConnectedTriggerBindingIfMissing: vi.fn(),
  deleteConnectedObservedTriggerBinding: vi.fn(),
  rollbackConnectedDefinition: mocks.rollback,
  saveConnectedDefinitionDraft: vi.fn(),
  saveConnectedDefinitionLayout: vi.fn(),
  updateConnectedDefinition: mocks.update,
  selectConnectedDefinitionDeployment: mocks.selectDeployment,
  selectConnectedDefinitionRollback: mocks.selectRollback,
  updateConnectedDefinitionLifecycle: mocks.updateLifecycle,
  updateConnectedDefinitionName: vi.fn(),
}));

vi.mock("./live-trigger-sync.js", () => ({
  syncLiveDefinitionTriggers: vi.fn(),
  syncConnectedLiveDefinitionTriggers: mocks.sync,
}));

vi.mock("./connected-policy-dependencies.js", () => ({
  dispatchConnectedDefinitionManual: vi.fn(),
  preflightConnectedDefinitionManual: vi.fn(),
  previewConnectedDefinitionPrompt: vi.fn(),
  readConnectedDefinitionTriggerRejections: vi.fn(),
  readConnectedDefinitionWebhookRejections: vi.fn(),
  validateConnectedDefinitionCandidate: vi.fn(),
  validateConnectedDefinitionPromptAuthoring: mocks.validatePrompts,
}));

vi.mock("../../workflow-definition/models.js", () => ({
  workflowBlockRegistryContextFromEnv: () => ({
    agentProviders: { claude: true, codex: true },
    llmProviders: { claude: true, codex: true },
    defaultAgent: { provider: "codex", model: "codex-test" },
    vcsProviders: ["github"],
    vcsBotIdentities: ["github"],
    slackConfigured: true,
    arthurConfigured: true,
    webhookTriggerConfigured: true,
  }),
}));

import {
  deployConnectedWorkflowDefinition,
  rollbackConnectedWorkflowDefinition,
  updateConnectedWorkflowDefinition,
} from "./policy-operations.js";

const actor = { id: "admin_1", label: "Admin", role: "admin" as const };
const definition = {
  schemaVersion: 2 as const,
  nodes: [{
    id: "trigger",
    type: "trigger_pr_created" as const,
    x: 0,
    y: 0,
    configuration: {},
    inputs: {},
    additionalInputs: [],
  }],
  edges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validatePrompts.mockResolvedValue([]);
  mocks.getDefinition.mockImplementation(async (id: number) => ({
    id,
    archivedAt: null,
    draftRevision: 2,
    deployedVersion: id === 43 ? 2 : id === 42 ? 2 : 1,
    triggerTypes: ["trigger_pr_created"],
  }));
  mocks.getVersion.mockResolvedValue({ schema: "v2", definition });
  mocks.selectDeployment.mockResolvedValue({ id: 41, version: 2 });
  mocks.selectRollback.mockResolvedValue({ id: 42, version: 1 });
  mocks.updateLifecycle.mockResolvedValue(43);
});

describe("connected workflow definition trigger convergence", () => {
  it("syncs after deploy", async () => {
    mocks.deploy.mockResolvedValue({ definition: { id: 41 } });

    await deployConnectedWorkflowDefinition({
      definitionId: 41,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor,
    });

    expect(mocks.sync).toHaveBeenCalledWith(41);
  });

  it("syncs after rollback", async () => {
    mocks.rollback.mockResolvedValue({ definition: { id: 42 } });

    await rollbackConnectedWorkflowDefinition({
      definitionId: 42,
      version: 1,
      expectedDeployedVersion: 2,
      actor,
    });

    expect(mocks.sync).toHaveBeenCalledWith(42);
  });

  it("syncs after enabling", async () => {
    mocks.update.mockResolvedValue({ id: 43, enabled: true });

    await updateConnectedWorkflowDefinition({
      definitionId: 43,
      enabled: true,
      actor,
    });

    expect(mocks.sync).toHaveBeenCalledWith(43);
  });
});
