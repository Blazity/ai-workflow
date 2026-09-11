import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  readHead: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../db/repositories/definitions.js", () => ({
  createDefinitionsRepository: vi.fn(),
  getWorkflowDefinition: vi.fn(),
}));
vi.mock("../../db/repositories/definitions/connected.js", () => ({
  getConnectedWorkflowDefinition: mocks.getDefinition,
  revokeConnectedScheduleAndCancelWaiting: vi.fn(),
}));
vi.mock("../../db/repositories/schedule-triggers.js", () => ({
  listConnectedSchedulesForDefinition: vi.fn(),
  mintConnectedSchedulesForLiveHead: vi.fn(),
}));
vi.mock("../../db/repositories/webhook-trigger-endpoints.js", () => ({
  mintConnectedWebhookEndpointsForDefinition: vi.fn(),
}));
vi.mock("../../schedule-trigger/schedule-store.js", () => ({
  listSchedulesForDefinition: vi.fn(),
  mintSchedulesForLiveHead: vi.fn(),
}));
vi.mock("../../webhook-trigger/endpoint-store.js", () => ({
  mintWebhookEndpointsForDefinition: vi.fn(),
}));
vi.mock("../settings/index.js", () => ({
  webhookTriggerEncryptionKey: vi.fn(() => null),
}));
vi.mock("../../engine/stored-definition-reads.js", () => ({
  readConnectedDeployedWorkflowDefinitionVersion: mocks.readHead,
  readDeployedWorkflowDefinitionVersion: vi.fn(),
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { warn: mocks.warn },
}));

import { syncConnectedLiveDefinitionTriggers } from "./live-trigger-sync.js";

describe("connected live trigger convergence", () => {
  it("does not fail an already-persisted transition when its follow-up read fails", async () => {
    mocks.getDefinition.mockRejectedValueOnce(new Error("read unavailable"));

    await expect(syncConnectedLiveDefinitionTriggers(41)).resolves.toBeUndefined();

    expect(mocks.readHead).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      { definitionId: 41, err: "read unavailable" },
      "live_trigger_sync_failed",
    );
  });
});
