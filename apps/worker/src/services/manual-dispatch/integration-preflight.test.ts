import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";
import type { Adapters } from "../vcs/adapters.js";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { unactivatedRepositoryCatalog } from "../../test-support/repository-catalog.js";
import { deploymentIntegrations } from "../../engine/definition/integration-availability.js";

/**
 * An operator presses "Run manually" on a workflow whose integration is gone.
 *
 * The modal has to say which integration and refuse to start, rather than start
 * a run that dies at the block. The preflight is where it says so.
 */

const mockResolve = vi.hoisted(() => vi.fn());
const mockIntegrations = vi.hoisted(() => vi.fn());

vi.mock("../../infra/vcs-config.js", () => ({
  env: { COLUMN_AI: "AI", JIRA_AI_TRANSITION_ID: undefined, MAX_CONCURRENT_AGENTS: 4 },
}));
vi.mock("./resolve.js", () => ({
  resolveManualDispatch: (...args: unknown[]) => mockResolve(...args),
}));
vi.mock("../workflow-definitions/block-contracts.js", () => ({
  connectedDeploymentIntegrations: () => mockIntegrations(),
}));

const { preflightManualDispatch } = await import("./service.js");

const notify: IntegrationManifest = {
  id: "acmenotify",
  name: "Acme Notify",
  description: "A provider core has never heard of.",
  connection: { fields: [] },
  capabilities: [],
  blocks: [
    {
      type: "acmenotify_announce",
      paramsSchema: { parse: (value: unknown) => value } as never,
      contract: { ports: ["out"], allowsFailurePort: false },
      ui: {
        label: "Announce",
        description: "Announces a milestone.",
        glyph: "A",
        color: "#445566",
        softColor: "#EEF1F4",
      },
      output: { properties: {}, statusVariants: ["sent"] },
    },
  ],
  pages: [],
  health: [{ id: "reachable", label: "Reachable", description: "", critical: true }],
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

let db: Db;
let adapters: Adapters;

beforeEach(async () => {
  db = await createTestDb();
  adapters = {
    issueTracker: {} as Adapters["issueTracker"],
    vcs: {} as Adapters["vcs"],
    messaging: {} as Adapters["messaging"],
    runRegistry: {
      get: vi.fn().mockResolvedValue(null),
      listCapacityConsumers: vi.fn().mockResolvedValue([]),
    } as unknown as Adapters["runRegistry"],
  };
  mockResolve.mockResolvedValue({
    definitionId: 9,
    definitionName: "Announce on pickup",
    definitionVersion: 3,
    triggerNodeId: "trigger",
    triggerType: "trigger_ticket_ai",
    input: { kind: "ticket", ticketKey: "AIW-1" },
    inputKind: "ticket",
    inputPayload: { kind: "ticket", ticketKey: "AIW-1" },
    subjectKey: "AIW-1",
    ticketKey: "AIW-1",
    subjectTitle: "Announce it",
    currentStatus: "To do",
    aiColumn: "AI",
    steps: [],
    blockTypes: ["trigger_ticket_ai", "acmenotify_announce"],
  });
});

function preflight() {
  return preflightManualDispatch({
    db,
    adapters,
    definitionId: 9,
    triggerNodeId: "trigger",
    dispatchInput: { kind: "ticket", ticketKey: "AIW-1" },
    maxConcurrentAgents: 4,
    repositoryCatalog: unactivatedRepositoryCatalog(),
  });
}

describe("running a workflow by hand when its integration is gone", () => {
  it("is runnable while the integration is connected and enabled", async () => {
    mockIntegrations.mockResolvedValue(
      deploymentIntegrations({
        manifests: [notify],
        states: new Map([["acmenotify", state()]]),
      }),
    );

    const response = await preflight();
    expect(response.runnable).toBe(true);
    expect(response.blocker).toBeUndefined();
  });

  it("refuses with `integration_unavailable` and names the integration", async () => {
    mockIntegrations.mockResolvedValue(
      deploymentIntegrations({
        manifests: [notify],
        states: new Map([
          ["acmenotify", state({ enabled: false, status: "disabled", usable: false })],
        ]),
      }),
    );

    const response = await preflight();
    expect(response.runnable).toBe(false);
    expect(response.blocker?.code).toBe("integration_unavailable");
    expect(response.blocker?.message).toContain("Acme Notify is disabled");
  });
});
