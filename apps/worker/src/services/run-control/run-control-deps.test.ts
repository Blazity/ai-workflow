import { describe, expect, it, vi } from "vitest";

/**
 * `/ai-workflow` on a deployment with no usable issue tracker.
 *
 * Listing and cancelling runs is about the runs, so the command must still be
 * answerable: a cancel has no ticket to move back and nothing to link to,
 * which `RunControlDeps` already allows by leaving both out.
 */
const registry = { listAll: vi.fn() };

vi.mock("../../engine/support/adapters.js", async () => {
  const { adaptersFor } = await import("../../test-support/issue-tracker.js");
  return { createAdapters: async () => adaptersFor("not_connected", { runRegistry: registry }) };
});
vi.mock("../run-lifecycle/index.js", () => ({ cancelRun: vi.fn() }));
vi.mock("../settings/index.js", () => ({
  loadSettingsSnapshot: vi.fn(),
  ticketBoardOf: vi.fn(),
}));

const { runControlDeps } = await import("./execute.js");

describe("runControlDeps without an issue tracker", () => {
  it("answers with the run registry and no tracker, ticket move or link", async () => {
    const deps = await runControlDeps();

    expect(deps.registry).toBe(registry);
    expect(deps.issueTracker).toBeUndefined();
    expect(deps.backlog).toBeUndefined();
    expect(deps.trackerBaseUrl).toBe("");
  });
});
