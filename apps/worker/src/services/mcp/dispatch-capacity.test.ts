// Regression for AIW-373 / AIW-385: the production MCP factory
// (createConnectedMcpToolServices) used to bind preflightManualDispatch and
// dispatchManualWorkflow to the manual-dispatch service functions directly,
// without supplying maxConcurrentAgents. Those functions REQUIRE the field,
// so at runtime it arrived as undefined and the capacity gate never tripped
// (`count >= undefined` is always false). The test factory
// (createMcpToolServices) already wrapped both calls correctly, which is why
// no earlier test caught the production factory's gap.
//
// This is the fallback shape from the stage brief: the connected factory
// cannot be exercised against the pglite test database without pulling in
// the whole dispatch/index.js trigger and rate-limit graph (service.ts
// imports it for the real capacity check), so this test mocks
// manual-dispatch/service.js and asserts, for BOTH factories, that the
// wrapper actually reaching the service functions carries the settings
// value and never undefined.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettingsSnapshot, type SettingsSnapshot } from "@shared/contracts";
import type { Adapters } from "../../engine/support/adapters.js";
import { createTestDb } from "../../db/test-db.js";
import { unactivatedRepositoryCatalog } from "../../test-support/repository-catalog.js";
import { maxConcurrentAgents } from "../settings/runtime-settings.js";

vi.mock("../../infra/vcs-config.js", () => ({
  env: { MAX_CONCURRENT_AGENTS: 6 },
}));

const dispatchService = vi.hoisted(() => ({
  preflightManualDispatch: vi.fn(),
  dispatchManualWorkflow: vi.fn(),
  preflightConnectedManualDispatch: vi.fn(),
  dispatchConnectedManualWorkflow: vi.fn(),
}));
vi.mock("../manual-dispatch/service.js", () => dispatchService);

const { createMcpToolServices } = await import("./tool-services.js");
const { createConnectedMcpToolServices } = await import("./connected-tool-services.js");

const SETTINGS: SettingsSnapshot = {
  ...defaultSettingsSnapshot(),
  MAX_CONCURRENT_AGENTS: 6,
};

function preflightInput() {
  return {
    adapters: {} as Adapters,
    definitionId: 9,
    triggerNodeId: "ticket-trigger",
    dispatchInput: { kind: "ticket" as const, ticketKey: "AIW-500" },
    repositoryCatalog: unactivatedRepositoryCatalog(),
  };
}

function dispatchWorkflowInput() {
  return {
    adapters: {} as Adapters,
    definitionId: 9,
    triggerNodeId: "ticket-trigger",
    request: {
      requestId: "11111111-1111-1111-1111-111111111111",
      expectedDeployedVersion: 3,
      input: { kind: "ticket" as const, ticketKey: "AIW-500" },
    },
    actor: { id: "user-admin", label: "Karol" },
    repositoryCatalog: unactivatedRepositoryCatalog(),
  };
}

describe.each([
  {
    name: "createMcpToolServices (test factory)",
    build: async () => createMcpToolServices(await createTestDb(), SETTINGS),
    preflightSpy: dispatchService.preflightManualDispatch,
    dispatchSpy: dispatchService.dispatchManualWorkflow,
  },
  {
    name: "createConnectedMcpToolServices (production factory)",
    build: async () => createConnectedMcpToolServices(SETTINGS),
    preflightSpy: dispatchService.preflightConnectedManualDispatch,
    dispatchSpy: dispatchService.dispatchConnectedManualWorkflow,
  },
])("$name honours the settings capacity limit", ({ build, preflightSpy, dispatchSpy }) => {
  beforeEach(() => {
    preflightSpy.mockReset().mockResolvedValue({ runnable: true });
    dispatchSpy.mockReset().mockResolvedValue({
      requestId: "r",
      status: "started",
      runId: "run-1",
    });
  });

  it("wires the settings capacity limit into preflightManualDispatch, never undefined", async () => {
    const services = await build();
    await services.preflightManualDispatch(preflightInput());

    expect(preflightSpy).toHaveBeenCalledTimes(1);
    const received = preflightSpy.mock.calls[0]![0] as { maxConcurrentAgents?: number };
    expect(received.maxConcurrentAgents).not.toBeUndefined();
    expect(received.maxConcurrentAgents).toBe(maxConcurrentAgents(SETTINGS));
  });

  it("wires the settings capacity limit into dispatchManualWorkflow, never undefined", async () => {
    const services = await build();
    await services.dispatchManualWorkflow(dispatchWorkflowInput());

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const received = dispatchSpy.mock.calls[0]![0] as { maxConcurrentAgents?: number };
    expect(received.maxConcurrentAgents).not.toBeUndefined();
    expect(received.maxConcurrentAgents).toBe(maxConcurrentAgents(SETTINGS));
  });
});
