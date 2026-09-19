import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState, WorkflowDefinitionV2 } from "@shared/contracts";

/**
 * Loading the plan of a run whose workflow uses an integration.
 *
 * This is where the run either starts or dies, and the two failures it can hide
 * are opposites. Resolving nothing makes every integration block look like a
 * block nothing provides, and the run dies as an "invalid definition": one log
 * line, no failure reason and no ticket comment, for a workflow whose
 * integration is connected and healthy. Resolving but not recording leaves the
 * run with no pin, so a connection that changes underneath it is followed
 * silently.
 */

const states = vi.hoisted(() => vi.fn());

const manifest: IntegrationManifest = {
  id: "acmenotify",
  name: "Acme Notify",
  description: "A provider core has never heard of.",
  connection: { fields: [] },
  capabilities: [],
  blocks: [
    {
      type: "acmenotify_announce",
      paramsSchema: z.object({ channel: z.string().min(1) }).strict(),
      contract: { ports: ["out"], allowsFailurePort: false },
      ui: {
        label: "Announce",
        description: "Announces a milestone.",
        glyph: "A",
        color: "#445566",
        softColor: "#EEF1F4",
      },
      defaults: { channel: "general" },
      output: { properties: {}, statusVariants: ["sent"] },
    },
  ],
  pages: [],
  health: [{ id: "reachable", label: "Reachable", description: "", critical: true }],
};

vi.mock("@integrations/registry", () => ({
  integrationManifests: [manifest],
  integrationManifest: (id: string) => (id === "acmenotify" ? manifest : undefined),
  integrationBlock: (type: string) =>
    type === "acmenotify_announce"
      ? { integrationId: "acmenotify", block: manifest.blocks[0] }
      : undefined,
  hasIntegration: (id: string) => id === "acmenotify",
}));
vi.mock("../../services/integrations/runtime.js", () => ({
  readIntegrationStates: () => states(),
}));
vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
    GITHUB_APP_ID: 1,
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_INSTALLATION_ID: 2,
    CHAT_SDK_SLACK_TOKEN: "slack-token",
    CHAT_SDK_CHANNEL_ID: "channel",
    JIRA_BASE_URL: "https://tracker.example",
    JIRA_API_TOKEN: "token",
    JIRA_PROJECT_KEY: "AIW",
  },
}));
vi.mock("../../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const deployedVersion = vi.hoisted(() => vi.fn());
vi.mock("../../db/repositories/definitions/connected.js", () => ({
  getConnectedCurrentWorkflowDefinitionVersion: deployedVersion,
  getConnectedDeployedWorkflowDefinitionVersion: deployedVersion,
  getConnectedWorkflowDefinition: vi.fn(),
  getConnectedWorkflowDefinitionVersion: deployedVersion,
  getConnectedEnabledWorkflowDefinitionForTrigger: vi.fn(),
}));
vi.mock("../definition-trigger-routing.js", () => ({
  getConnectedEnabledWorkflowDefinitionForTrigger: vi.fn(),
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadWorkflowDefinitionFor } = await import("./definition-step.js");
const { testSettingsSnapshot } = await import("../../test-support/settings.js");

const definition: WorkflowDefinitionV2 = {
  schemaVersion: 2,
  nodes: [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      name: "Ticket enters the AI column",
      x: 40,
      y: 280,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
    {
      id: "announce",
      type: "acmenotify_announce" as WorkflowDefinitionV2["nodes"][number]["type"],
      name: "Announce",
      x: 300,
      y: 280,
      configuration: { channel: "releases" },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [{ id: "trigger-out-announce", from: "trigger", to: "announce" }],
};

function state(overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: "acmenotify",
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: {
      latestVersion: 0,
      activeVersion: null,
      missingFields: [],
      complete: false,
      prepared: null,
    },
    pin: { integrationId: "acmenotify", configFingerprint: "site-one" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

function load() {
  return loadWorkflowDefinitionFor(testSettingsSnapshot(), "trigger_ticket_ai", 1, 3);
}

beforeEach(() => {
  deployedVersion.mockReset();
  deployedVersion.mockResolvedValue({
    definitionId: 1,
    version: 3,
    schema: "v2" as const,
    definition,
    createdAt: new Date(),
    createdById: "u1",
    createdByLabel: "User One",
    restoredFromVersion: null,
  });
  states.mockReset();
  states.mockResolvedValue(new Map([["acmenotify", state()]]));
});

describe("loading a plan whose workflow uses an integration", () => {
  it("loads, and pins the connection the run starts with", async () => {
    const plan = await load();

    expect(plan).not.toBeNull();
    expect(plan?.integrationPins).toEqual([
      { integrationId: "acmenotify", configFingerprint: "site-one" },
    ]);
    expect(plan?.integrationBlocker).toBeUndefined();
  });

  it("loads and carries the blocker when the integration is disabled, rather than dying as invalid", async () => {
    // The run has to reach the failure exit that comments on the ticket. A null
    // plan here means one log line and silence for the person waiting.
    states.mockResolvedValue(
      new Map([["acmenotify", state({ enabled: false, status: "disabled", usable: false })]]),
    );

    const plan = await load();

    expect(plan).not.toBeNull();
    expect(plan?.integrationBlocker).toMatchObject({ integrationId: "acmenotify" });
    expect(plan?.integrationBlocker?.message).toContain("Acme Notify is disabled");
  });

  it("refuses parameters the integration's own schema rejects, rather than finding out mid-run", async () => {
    // The load-time check has to use the block's schema, not core's map. With
    // core's map an integration block's parameters are never looked at, the run
    // starts, and the refusal lands at the block instead, after everything
    // before it already ran.
    deployedVersion.mockResolvedValue({
      definitionId: 1,
      version: 3,
      schema: "v2" as const,
      definition: {
        ...definition,
        nodes: [
          definition.nodes[0]!,
          { ...definition.nodes[1]!, configuration: { channel: "" } },
        ],
      },
      createdAt: new Date(),
      createdById: "u1",
      createdByLabel: "User One",
      restoredFromVersion: null,
    });

    expect(await load()).toBeNull();
  });

  it("refuses a plan whose block type this build no longer provides", async () => {
    states.mockResolvedValue(new Map());
    deployedVersion.mockResolvedValue({
      definitionId: 1,
      version: 3,
      schema: "v2" as const,
      definition: {
        ...definition,
        nodes: [
          definition.nodes[0]!,
          { ...definition.nodes[1]!, type: "goneaway_send" as never },
        ],
      },
      createdAt: new Date(),
      createdById: "u1",
      createdByLabel: "User One",
      restoredFromVersion: null,
    });

    expect(await load()).toBeNull();
  });
});
