import { describe, it, expect, vi, beforeEach } from "vitest";
import { connectedIssueTracker } from "../test-support/issue-tracker.js";
import type { WorkflowDefinition } from "@shared/contracts";

// One file, the definition loader's edge cases. The GitHub webhook route that
// used to be the fifth area left with the GitHub integration in S11, and its
// cases live in `integrations/github/webhook.test.ts` and in the generic route
// suite `routes/webhooks/integration-webhook.test.ts`.
// vi.mock is hoisted and file-scoped, so we mock vi.mock is hoisted and file-scoped, so we mock
// the union of every dependency once. The runtime environment module is
// shared by all areas; the bot-login helper has its own mock because it resolves
// provider configuration through the config module.
const H = vi.hoisted(() => ({
  env: {
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    MAX_CONCURRENT_AGENTS: 3,
    VCS_BOT_LOGIN: undefined as string | undefined,
  },
}));
// This deployment's integrations, stated. The plan load reads them inside the
// step so a run carries the connection it started with; this file is about
// which definition the step picks, so it says "none" in one line rather than
// standing up a database to find out.
vi.mock("../services/integrations/runtime.js", () => ({
  readIntegrationStates: async () => new Map(),
}));
// A deployment with a tracker connected, which is what a ticket trigger
// needs to exist at all. The choice of tracker is proved elsewhere.
vi.mock("./support/issue-tracker-runtime.js", () => connectedIssueTracker());
vi.mock("../infra/vcs-config.js", () => ({
  env: H.env,
}));

const mockGetCurrentVersion = vi.fn();
const mockGetDeployedVersion = vi.fn();
const mockGetDefinition = vi.fn();
const mockGetVersion = vi.fn();
const mockGetEnabled = vi.fn();
vi.mock("./definition-trigger-routing.js", () => ({
  getConnectedEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));
vi.mock("../db/repositories/definitions.js", () => ({
  getCurrentWorkflowDefinitionVersion: (...args: any[]) => mockGetCurrentVersion(...args),
  getDeployedWorkflowDefinitionVersion: (...args: any[]) => mockGetDeployedVersion(...args),
  getWorkflowDefinition: (...args: any[]) => mockGetDefinition(...args),
  getWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));
vi.mock("../db/repositories/definitions/connected.js", () => ({
  getConnectedCurrentWorkflowDefinitionVersion: (...args: any[]) =>
    mockGetCurrentVersion(...args),
  getConnectedDeployedWorkflowDefinitionVersion: (...args: any[]) =>
    mockGetDeployedVersion(...args),
  getConnectedWorkflowDefinition: (...args: any[]) => mockGetDefinition(...args),
  getConnectedWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
  getConnectedWorkflowDefinitionName: async () => ({ name: "Edge case workflow" }),
  getConnectedEnabledWorkflowDefinitionForTrigger: (...args: any[]) =>
    mockGetEnabled(...args),
}));

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
vi.mock("../infra/logger.js", () => ({
  logger: {
    info: (...a: any[]) => loggerInfo(...a),
    warn: (...a: any[]) => loggerWarn(...a),
    error: (...a: any[]) => loggerError(...a),
  },
}));

vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../db/repositories/settings.js", () => ({
  // The ingress route loads one settings snapshot per request. This file hands
  // the handler a stub database, and an empty settings table is what a
  // deployment that has stored no decision has, so every value still resolves
  // from the mocked environment exactly as it did before the snapshot existed.
  readAllConnectedSettings: async () => [],
}));
vi.mock("../db/repositories/repository-catalog.js", () => ({
  // Same story as the settings table: the ingress route now also loads one
  // repository catalog snapshot per request, and an empty catalog nobody
  // activated is the bridge, which passes every repository. These cases are
  // about trigger normalization, not about who may be dispatched.
  listConnectedRepositoryCatalogKeys: async () => [],
  getConnectedRepositoryCatalogStateRow: async () => ({
    activated: false,
    activatedAt: null,
    activatedById: null,
    activatedByLabel: null,
  }),
}));

import { loadWorkflowDefinitionFor } from "./steps/definition-step.js";
import { testSettingsSnapshot } from "../test-support/settings.js";

/** The settings this run started under; these cases are about the loader, not
 *  about any one key, so they take the registry defaults. */
const settings = testSettingsSnapshot();

// ---------------------------------------------------------------------------
// Area 2: loadWorkflowDefinitionFor
// ---------------------------------------------------------------------------
function row(definition: WorkflowDefinition, version = 3, definitionId = 1) {
  return {
    definitionId,
    version,
    schema: "v2" as const,
    definition,
    createdAt: new Date(),
    createdById: "u1",
    createdByLabel: "User One",
    restoredFromVersion: null,
  };
}

function enabled(definition: WorkflowDefinition, version = 3, definitionId = 1) {
  return { definition: { id: definitionId }, current: row(definition, version, definitionId) };
}

describe("loadWorkflowDefinitionFor edge cases", () => {
  beforeEach(() => {
    mockGetCurrentVersion.mockReset();
    mockGetDeployedVersion.mockReset();
    mockGetDefinition.mockReset();
    mockGetEnabled.mockReset();
    loggerError.mockReset();
    loggerInfo.mockReset();
  });

  it("returns null for a non-ticket trigger when the pinned definition row is missing", async () => {
    mockGetDeployedVersion.mockResolvedValue(null);
    mockGetDefinition.mockResolvedValue(null);

    const plan = await loadWorkflowDefinitionFor(settings, "trigger_pr_created", 999);

    expect(plan).toBeNull();
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("returns null and logs an error for a non-ticket trigger whose stored row is invalid", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ schemaVersion: 2, nodes: [], edges: [] } as unknown as WorkflowDefinition, 9, 5),
    );

    const plan = await loadWorkflowDefinitionFor(settings, "trigger_pr_created");

    expect(plan).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 9, definitionId: 5 });
  });

  it("treats a matched enabled record with a null current version as no definition", async () => {
    mockGetEnabled.mockResolvedValue({ definition: { id: 1 }, current: null });

    // Ticket trigger falls back to the built-in default...
    const ticketPlan = await loadWorkflowDefinitionFor(settings, "trigger_ticket_ai");
    expect(ticketPlan).not.toBeNull();
    expect(ticketPlan!.definitionId).toBeNull();

    // ...but a non-ticket trigger returns null.
    const otherPlan = await loadWorkflowDefinitionFor(settings, "planning_agent");
    expect(otherPlan).toBeNull();
  });

  it("loads a valid stored ticket definition without injecting Prepare", async () => {
    const validNoPrepare: WorkflowDefinition = {
      schemaVersion: 2,
      nodes: [
        {
          id: "t",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
        {
          id: "planning",
          type: "planning_agent",
          x: 100,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [{ id: "t-planning", from: "t", to: "planning" }],
    };
    mockGetEnabled.mockResolvedValue(enabled(validNoPrepare, 8, 4));

    const plan = await loadWorkflowDefinitionFor(settings, "trigger_ticket_ai");

    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(8);
    expect(plan!.definitionId).toBe(4);
    expect(plan!.nodes.map((n) => n.type)).toEqual(["trigger_ticket_ai", "planning_agent"]);
    expect(loggerError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Durable trigger dispatch and owner-CAS reconciliation now have dedicated
// focused suites: services/dispatch/dispatch-trigger.test.ts and
// services/run-lifecycle/reconcile.test.ts.
// ---------------------------------------------------------------------------
