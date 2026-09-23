import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live board on a deployment with no usable issue tracker.
 *
 * The tracker only titles a row, so its absence must not take the board with
 * it: a GitHub-only deployment with a review run in flight used to answer 500,
 * the dashboard fell back to an empty board, and the person read "nothing is
 * running" and dispatched again.
 */
const state = vi.hoisted(() => ({
  tracker: "not_connected" as "not_connected" | "unreadable",
  listAll: vi.fn(),
}));

vi.mock("../../engine/support/adapters.js", async () => {
  const { adaptersFor } = await import("../../test-support/issue-tracker.js");
  return {
    createAdapters: async () =>
      adaptersFor(state.tracker, { runRegistry: { listAll: state.listAll } }),
  };
});
vi.mock("../settings/index.js", () => ({ issueTrackerBaseUrl: async () => "" }));
vi.mock("../overview/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../overview/index.js")>()),
  collectAwaitingRuns: async () => [],
  resolveRunModels: async () => new Map(),
}));

const { listLiveRuns } = await import("./run-reads.js");

describe("listLiveRuns without an issue tracker", () => {
  beforeEach(() => {
    state.listAll.mockResolvedValue([
      {
        subjectKey: "pr:github:acme/api#42",
        ticketKey: null,
        runId: "run-review",
        ownerToken: "owner:run-review",
        state: "bound",
        kind: "pr_trigger",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
  });

  it.each(["not_connected", "unreadable"] as const)(
    "still lists the runs in flight when the tracker is %s",
    async (tracker) => {
      state.tracker = tracker;

      const board = await listLiveRuns();

      expect(board.rows).toHaveLength(1);
      expect(board.rows[0]).toMatchObject({
        id: "run-review",
        status: "running",
        ticket: "pr:github:acme/api#42",
      });
    },
  );
});
