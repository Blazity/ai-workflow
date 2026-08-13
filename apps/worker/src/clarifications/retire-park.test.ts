import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";

const mocks = vi.hoisted(() => ({
  cancelRunForOperator: vi.fn(),
}));

vi.mock("../lib/cancel-run.js", () => ({
  cancelRunForOperator: (...args: unknown[]) => mocks.cancelRunForOperator(...args),
}));

const { retireParkedRun } = await import("./retire-park.js");

const db = {} as Db;
const runRegistry = {} as RunRegistryAdapter;

function retire() {
  return retireParkedRun({
    db,
    runRegistry,
    runId: "wrun_01KZXATAKMZ655NZA6Y0379HA7",
    cause: { kind: "ticket_deleted", ticketKey: "UP-4839" },
  });
}

describe("retireParkedRun", () => {
  beforeEach(() => {
    mocks.cancelRunForOperator.mockReset();
  });

  it("cancels by run id with a reason naming the ticket that is gone", async () => {
    mocks.cancelRunForOperator.mockResolvedValue({
      outcome: "cancelled",
      subjectKey: "ticket:jira:UP-4839",
      scheduleOccurrenceSettled: null,
    });

    const result = await retire();

    expect(result.outcome).toBe("cancelled");
    const [passedDb, passedRunId, opts] = mocks.cancelRunForOperator.mock.calls[0] as [
      Db,
      string,
      { actorLabel: string; runRegistry: RunRegistryAdapter },
    ];
    expect(passedDb).toBe(db);
    expect(passedRunId).toBe("wrun_01KZXATAKMZ655NZA6Y0379HA7");
    expect(opts.runRegistry).toBe(runRegistry);
    // The label becomes "cancelled by <label>" in workflow_runs.status_reason,
    // which is the only place a person learns why the park disappeared.
    expect(opts.actorLabel).toContain("UP-4839");
    expect(opts.actorLabel).toContain("no longer exists");
  });

  // Passing the outcome through matters to the sweeps built on this: only an
  // unconfirmed cancel left the run untouched and may be retried. Folding it
  // into a generic failure would either strand the park forever or send a sweep
  // back at a run that is already dead.
  it("passes an unconfirmed cancellation through unmapped", async () => {
    mocks.cancelRunForOperator.mockResolvedValue({
      outcome: "unconfirmed",
      subjectKey: "ticket:jira:UP-4839",
      scheduleOccurrenceSettled: null,
    });

    expect((await retire()).outcome).toBe("unconfirmed");
  });
});
