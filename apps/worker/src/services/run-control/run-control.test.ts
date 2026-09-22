/**
 * What `/ai-workflow` actually does to a run.
 *
 * These cases came with the logic from `services/slack/handlers.ts`, where they
 * were assertions about a Slack string. The command is core's now and answers
 * in values, so they assert the value: the same behaviour, one layer below the
 * words, and a second provider of the same command inherits it.
 *
 * Cancellation is the part with consequences. A claim cleared over a run that
 * is still going strands the ticket, and an unconfirmed cancellation reported
 * as done is the production defect this repository has already had once
 * (AIW-240): ownership is kept so a retry is safe, and the answer says so.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
  ThreadStore,
} from "../../adapters/run-registry/types.js";
import type { RunControlDeps } from "./execute.js";
import { executeRunControlCommand } from "./execute.js";

vi.mock("../../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// This deployment has an issue tracker connected. Which one, and what it is
// wired to, is an integration connection since S12 and is resolved from the
// database; this suite is about what happens to a RUN, so it says the one
// thing it means and leaves the resolution to its own tests.
vi.mock("../../engine/support/issue-tracker-runtime.js", async () => {
  const support = await import("../../test-support/issue-tracker.js");
  return support.connectedIssueTracker({});
});

const TRACKER = "https://example.atlassian.net";

function registryWith(
  overrides: Partial<RunRegistryAdapter & ThreadStore> = {},
): RunRegistryAdapter & ThreadStore {
  return {
    reserve: vi.fn(),
    commitStartedRun: vi.fn(),
    markRunEntryStarted: vi.fn(),
    bindRun: vi.fn(),
    beginParking: vi.fn(),
    finishParking: vi.fn(),
    handoff: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    beginCancellation: vi.fn().mockResolvedValue(true),
    releaseCancellation: vi.fn().mockResolvedValue(true),
    releaseReservation: vi.fn().mockResolvedValue(true),
    release: vi.fn(),
    listAll: vi.fn().mockResolvedValue([]),
    listAllFailed: vi.fn().mockResolvedValue([]),
    registerSandbox: vi.fn().mockResolvedValue(undefined),
    listSandboxes: vi.fn().mockResolvedValue([]),
    markFailed: vi.fn().mockResolvedValue(undefined),
    isTicketFailed: vi.fn().mockResolvedValue(false),
    clearFailedMark: vi.fn().mockResolvedValue(undefined),
    getParent: vi.fn().mockResolvedValue(null),
    setParent: vi.fn().mockResolvedValue(undefined),
    clearParent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RunRegistryAdapter & ThreadStore;
}

function deps(
  registry: RunRegistryAdapter & ThreadStore,
  cancelRun = vi.fn().mockResolvedValue(true),
): RunControlDeps & { cancelRun: ReturnType<typeof vi.fn> } {
  return { registry, cancelRun, trackerBaseUrl: TRACKER } as never;
}

function active(ticketKey: string, overrides: Partial<ActiveRunEntry> = {}): ActiveRunEntry {
  return {
    subjectKey: `ticket:jira:${ticketKey}`,
    ticketKey,
    ownerToken: `owner:${ticketKey}`,
    runId: `run:${ticketKey}`,
    state: "bound",
    kind: "ticket",
    createdAt: Date.parse("2026-09-20T08:00:00.000Z"),
    updatedAt: Date.parse("2026-09-20T08:00:00.000Z"),
    ...overrides,
  } as ActiveRunEntry;
}

describe("list", () => {
  it("answers with the live runs, and with none when there are none", async () => {
    const answer = await executeRunControlCommand({ kind: "list" }, deps(registryWith()));
    expect(answer).toEqual({ kind: "runs", runs: [] });
  });

  it("leaves out a reservation nothing has started yet", async () => {
    // A reserved row is a dispatch that has not begun. Listing it as a run
    // invites somebody to cancel a run that does not exist.
    const registry = registryWith({
      listAll: vi
        .fn()
        .mockResolvedValue([
          active("AWT-1", { runId: "run_real" }),
          active("AWT-2", { state: "reserved", runId: null }),
        ]),
    });

    const answer = await executeRunControlCommand({ kind: "list" }, deps(registry));

    expect(answer).toEqual({
      kind: "runs",
      runs: [
        {
          ticketKey: "AWT-1",
          runId: "run_real",
          ticketUrl: `${TRACKER}/browse/AWT-1`,
        },
      ],
    });
  });

  it("counts a parked run as live, because it is", async () => {
    // Parked is waiting for a person to answer, not finished. It has to be
    // listable and cancellable, which is how a stuck park gets cleared.
    const registry = registryWith({
      listAll: vi.fn().mockResolvedValue([active("AWT-3", { state: "parked", runId: "run_p" })]),
    });

    const answer = await executeRunControlCommand({ kind: "list" }, deps(registry));

    expect(answer).toMatchObject({ runs: [{ ticketKey: "AWT-3", runId: "run_p" }] });
  });
});

describe("status", () => {
  it("says nothing is tracked rather than inventing a run", async () => {
    const answer = await executeRunControlCommand(
      { kind: "status", ticketKey: "AWT-99" },
      deps(registryWith()),
    );

    expect(answer).toEqual({
      kind: "run_status",
      ticketKey: "AWT-99",
      ticketUrl: `${TRACKER}/browse/AWT-99`,
      runId: null,
      hasSandbox: false,
    });
  });

  it("reports the run and whether a sandbox is still up", async () => {
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
      listSandboxes: vi.fn().mockResolvedValue(["sbx_z"]),
    });

    expect(
      await executeRunControlCommand({ kind: "status", ticketKey: "AWT-1" }, deps(registry)),
    ).toMatchObject({ runId: "run_a", hasSandbox: true });
  });

  it("still reports the run when the sandbox lookup fails", async () => {
    // The sandbox line is a detail; the run id is the thing somebody asked
    // for, and losing it to a transient lookup would be the worse answer.
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
      listSandboxes: vi.fn().mockRejectedValue(new Error("sandbox api down")),
    });

    expect(
      await executeRunControlCommand({ kind: "status", ticketKey: "AWT-1" }, deps(registry)),
    ).toMatchObject({ runId: "run_a", hasSandbox: false });
  });
});

describe("cancel", () => {
  it("cancels nothing when nothing holds the ticket", async () => {
    const registry = registryWith();
    const d = deps(registry);

    const answer = await executeRunControlCommand(
      { kind: "cancel", ticketKey: "AWT-1", actor: "U1" },
      d,
    );

    expect(answer).toMatchObject({ kind: "cancelled", outcome: "not_tracked", runId: null });
    expect(d.cancelRun).not.toHaveBeenCalled();
  });

  it("names who asked, in the reason the run record and the ticket keep", async () => {
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
    });
    const d = deps(registry);

    const answer = await executeRunControlCommand(
      { kind: "cancel", ticketKey: "AWT-1", actor: "U123" },
      d,
    );

    expect(d.cancelRun).toHaveBeenCalledWith(
      "AWT-1",
      { ownerToken: "owner:AWT-1", runId: "run_a" },
      registry,
      undefined,
      undefined,
      undefined,
      // Who, not where from: the next provider of this command writes the same
      // sentence for the same act.
      "Cancelled by U123 through a run control command",
    );
    expect(answer).toMatchObject({ outcome: "cancelled", runId: "run_a" });
  });

  it("keeps ownership and says so when the cancellation was not confirmed", async () => {
    // The production defect this replaces reported success over a run that was
    // still going. Unconfirmed means retry, and the answer has to say that.
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
    });

    const answer = await executeRunControlCommand(
      { kind: "cancel", ticketKey: "AWT-1", actor: "U1" },
      deps(registry, vi.fn().mockResolvedValue(false)),
    );

    expect(answer).toMatchObject({ outcome: "unconfirmed", runId: "run_a" });
  });

  it("routes a dispatch that has not started through the same durable cancel", async () => {
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { state: "reserved", runId: null })),
    });
    const d = deps(registry);

    const answer = await executeRunControlCommand(
      { kind: "cancel", ticketKey: "AWT-1", actor: "U1" },
      d,
    );

    expect(d.cancelRun).toHaveBeenCalledWith(
      "AWT-1",
      { ownerToken: "owner:AWT-1", runId: null },
      registry,
      undefined,
      undefined,
      undefined,
      "Cancelled by U1 through a run control command",
    );
    expect(answer).toMatchObject({ outcome: "cancelled_mid_dispatch", runId: null });
  });

  it("reports a claim it could not clear as exactly that", async () => {
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { state: "reserved", runId: null })),
    });

    expect(
      await executeRunControlCommand(
        { kind: "cancel", ticketKey: "AWT-1", actor: "U1" },
        deps(registry, vi.fn().mockResolvedValue(false)),
      ),
    ).toMatchObject({ outcome: "claim_not_cleared" });
  });
});

describe("reset", () => {
  it("clears what it can and refuses to unclaim a live run", async () => {
    // Clearing the claim of a run that is going leaves the run going with
    // nothing holding its ticket, which is how two runs end up on one ticket.
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
    });

    const answer = await executeRunControlCommand({ kind: "reset", ticketKey: "AWT-1" }, deps(registry));

    expect(answer).toMatchObject({
      kind: "reset",
      outcome: {
        blockedByActiveRun: true,
        cleared: ["failure_mark", "conversation"],
        failures: [],
      },
    });
    expect(registry.releaseReservation).not.toHaveBeenCalled();
  });

  it("releases a reservation nobody started, and says what it cleared", async () => {
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { state: "reserved", runId: null })),
    });

    expect(
      await executeRunControlCommand({ kind: "reset", ticketKey: "AWT-1" }, deps(registry)),
    ).toMatchObject({
      outcome: {
        blockedByActiveRun: false,
        cleared: ["reservation", "failure_mark", "conversation"],
        failures: [],
      },
    });
  });

  it("reports the half that failed instead of a clean reset", async () => {
    const registry = registryWith({
      clearFailedMark: vi.fn().mockRejectedValue(new Error("the database refused")),
    });

    expect(
      await executeRunControlCommand({ kind: "reset", ticketKey: "AWT-1" }, deps(registry)),
    ).toMatchObject({
      outcome: {
        cleared: ["conversation"],
        failures: [{ target: "failure_mark", reason: "the database refused" }],
      },
    });
  });
});

describe("summary", () => {
  it("answers with the live runs and the failure markers together", async () => {
    const registry = registryWith({
      listAll: vi.fn().mockResolvedValue([active("AWT-1", { runId: "run_a" })]),
      listAllFailed: vi.fn().mockResolvedValue([
        {
          ticketKey: "AWT-9",
          meta: { runId: "run_f", failedAt: "2026-09-19T10:00:00.000Z" },
        },
      ]),
    });

    expect(
      await executeRunControlCommand({ kind: "summary" }, deps(registry)),
    ).toEqual({
      kind: "registry",
      active: [{ ticketKey: "AWT-1", runId: "run_a", ticketUrl: `${TRACKER}/browse/AWT-1` }],
      failed: [
        {
          ticketKey: "AWT-9",
          runId: "run_f",
          ticketUrl: `${TRACKER}/browse/AWT-9`,
          failedAt: "2026-09-19T10:00:00.000Z",
        },
      ],
    });
  });

  it("answers with the half it could read when the other half throws", async () => {
    const registry = registryWith({
      listAll: vi.fn().mockResolvedValue([active("AWT-1", { runId: "run_a" })]),
      listAllFailed: vi.fn().mockRejectedValue(new Error("the database refused")),
    });

    expect(await executeRunControlCommand({ kind: "summary" }, deps(registry))).toMatchObject({
      active: [{ ticketKey: "AWT-1" }],
      failed: [],
    });
  });
});

describe("inspect", () => {
  it("answers with the whole entry, including the conversation it is anchored to", async () => {
    const registry = registryWith({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
      listSandboxes: vi.fn().mockResolvedValue(["sbx_z", "sbx_child"]),
      getParent: vi.fn().mockResolvedValue("1758300000.000100"),
      isTicketFailed: vi.fn().mockResolvedValue(true),
    });

    expect(
      await executeRunControlCommand({ kind: "inspect", ticketKey: "AWT-1" }, deps(registry)),
    ).toEqual({
      kind: "entry",
      entry: {
        ticketKey: "AWT-1",
        ticketUrl: `${TRACKER}/browse/AWT-1`,
        runId: "run_a",
        sandboxId: "sbx_z",
        claimedAt: "2026-09-20T08:00:00.000Z",
        conversation: "1758300000.000100",
        failed: true,
      },
    });
  });
});
