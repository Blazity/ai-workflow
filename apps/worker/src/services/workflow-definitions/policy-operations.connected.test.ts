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

// The settings cluster reads the deployment's environment through this module,
// and its real one validates every variable at import. The contracts below are
// mocked, so an empty environment is all this suite needs.
vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));

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

// The settings snapshot every block contract resolves against. This file is
// about trigger convergence, so it is answered without a database: the stored
// rows are somebody else's test, and reaching for a connection here would make
// this suite need a DATABASE_URL to deploy a definition.
vi.mock("../settings/snapshot.js", () => ({
  loadSettingsSnapshot: async () => ({}),
  loadSettingsSnapshotOn: async () => ({}),
}));

vi.mock("../../engine/definition/block-contract-environment.js", () => ({
  workflowBlockRegistryContext: () => ({
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
  it("returns the deploy result and syncs only after persistence succeeds", async () => {
    const deployedDefinition = {
      id: 41,
      archivedAt: null,
      draftRevision: 2,
      deployedVersion: 1,
      triggerTypes: ["trigger_pr_created"],
    };
    const deployedVersion = { schema: "v2", definition };
    mocks.getDefinition.mockResolvedValue(deployedDefinition);
    mocks.getVersion.mockResolvedValue(deployedVersion);

    const result = await deployConnectedWorkflowDefinition({
      definitionId: 41,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor,
    });

    expect(result).toEqual({ definition: deployedDefinition, version: deployedVersion });
    expect(result.definition).toBe(deployedDefinition);
    expect(mocks.selectDeployment.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sync.mock.invocationCallOrder[0]!,
    );
    expect(mocks.sync).toHaveBeenCalledWith(41);

    vi.clearAllMocks();
    const persistenceError = new Error("deploy persistence failed");
    mocks.selectDeployment.mockRejectedValue(persistenceError);
    await expect(deployConnectedWorkflowDefinition({
      definitionId: 41,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor,
    })).rejects.toBe(persistenceError);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("returns the rollback result and syncs only after persistence succeeds", async () => {
    const rolledBackDefinition = {
      id: 42,
      archivedAt: null,
      draftRevision: 2,
      deployedVersion: 2,
      triggerTypes: ["trigger_pr_created"],
    };
    const rolledBackVersion = { schema: "v2", definition };
    mocks.getDefinition.mockResolvedValue(rolledBackDefinition);
    mocks.getVersion.mockResolvedValue(rolledBackVersion);

    const result = await rollbackConnectedWorkflowDefinition({
      definitionId: 42,
      version: 1,
      expectedDeployedVersion: 2,
      actor,
    });

    expect(result).toEqual({ definition: rolledBackDefinition, version: rolledBackVersion });
    expect(result.definition).toBe(rolledBackDefinition);
    expect(mocks.selectRollback.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sync.mock.invocationCallOrder[0]!,
    );
    expect(mocks.sync).toHaveBeenCalledWith(42);

    vi.clearAllMocks();
    const persistenceError = new Error("rollback persistence failed");
    mocks.selectRollback.mockRejectedValue(persistenceError);
    await expect(rollbackConnectedWorkflowDefinition({
      definitionId: 42,
      version: 1,
      expectedDeployedVersion: 2,
      actor,
    })).rejects.toBe(persistenceError);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("returns the enabled result and syncs only after persistence succeeds", async () => {
    const enabledDefinition = {
      id: 43,
      archivedAt: null,
      draftRevision: 2,
      deployedVersion: 2,
      triggerTypes: ["trigger_pr_created"],
      enabled: true,
    };
    mocks.getDefinition.mockResolvedValue(enabledDefinition);

    const result = await updateConnectedWorkflowDefinition({
      definitionId: 43,
      enabled: true,
      actor,
    });

    expect(result).toBe(enabledDefinition);
    expect(mocks.updateLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sync.mock.invocationCallOrder[0]!,
    );
    expect(mocks.sync).toHaveBeenCalledWith(43);

    vi.clearAllMocks();
    const persistenceError = new Error("enable persistence failed");
    mocks.updateLifecycle.mockRejectedValue(persistenceError);
    await expect(updateConnectedWorkflowDefinition({
      definitionId: 43,
      enabled: true,
      actor,
    })).rejects.toBe(persistenceError);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
