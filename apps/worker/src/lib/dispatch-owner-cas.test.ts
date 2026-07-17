import { describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
} from "../adapters/run-registry/types.js";

vi.mock("../../env.js", () => ({
  env: { JIRA_PROJECT_KEY: "PROJ", COLUMN_AI: "AI" },
}));
vi.mock("workflow/api", () => ({ start: vi.fn(), getRun: vi.fn() }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: vi.fn() }));

function registry(): RunRegistryAdapter {
  const entries = new Map<string, ActiveRunEntry>();
  return {
    reserve: vi.fn(async (reservation) => {
      if (entries.has(reservation.subjectKey)) return false;
      const now = Date.now();
      entries.set(reservation.subjectKey, {
        ...reservation,
        runId: null,
        state: "reserved",
        createdAt: now,
        updatedAt: now,
      });
      return true;
    }),
    bindRun: vi.fn(async () => false),
    handoff: vi.fn(async () => false),
    get: vi.fn(async (key) => entries.get(key) ?? null),
    releaseReservation: vi.fn(async (key, owner) => {
      const entry = entries.get(key);
      if (!entry || entry.ownerToken !== owner || entry.state !== "reserved") return false;
      entries.delete(key);
      return true;
    }),
    release: vi.fn(async () => false),
    listAll: vi.fn(async () => [...entries.values()]),
    registerSandbox: vi.fn(async () => {}),
    listSandboxes: vi.fn(async () => []),
    markFailed: vi.fn(async () => {}),
    isTicketFailed: vi.fn(async () => false),
    listAllFailed: vi.fn(async () => []),
    clearFailedMark: vi.fn(async () => {}),
  };
}

describe("claimSubjectRun", () => {
  it("reserves before start and passes the immutable owner token to the workflow input", async () => {
    const { claimSubjectRun } = await import("./dispatch.js");
    const runRegistry = registry();
    const order: string[] = [];
    vi.mocked(runRegistry.reserve).mockImplementationOnce(async () => {
      order.push("reserve");
      return true;
    });
    const startWorkflow = vi.fn(async (ownerToken: string) => {
      order.push("start");
      expect(ownerToken).toMatch(/^owner:/);
      return "run-a";
    });

    const result = await claimSubjectRun(
      {
        subjectKey: "ticket:jira:PROJ-1",
        ticketKey: "PROJ-1",
        kind: "ticket",
      },
      runRegistry,
      2,
      { startWorkflow },
    );

    expect(result).toEqual({ started: true, runId: "run-a" });
    expect(order).toEqual(["reserve", "start"]);
    expect(runRegistry.bindRun).not.toHaveBeenCalled();
  });

  it("releases only its unbound reservation when a post-reservation guard bails", async () => {
    const { claimSubjectRun } = await import("./dispatch.js");
    const runRegistry = registry();
    let guardedOwnerToken: string | null = null;
    const result = await claimSubjectRun(
      {
        subjectKey: "ticket:jira:PROJ-1",
        ticketKey: "PROJ-1",
        kind: "ticket",
      },
      runRegistry,
      2,
      {
        postClaimGuard: async (ownerToken) => {
          guardedOwnerToken = ownerToken;
          return { started: false, reason: "not_in_ai_column" };
        },
        startWorkflow: vi.fn(),
      },
    );

    expect(result).toEqual({ started: false, reason: "not_in_ai_column" });
    expect(guardedOwnerToken).toMatch(/^owner:/);
    expect(runRegistry.releaseReservation).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      guardedOwnerToken,
    );
  });

  it("does not let a second dispatcher start for the same subject", async () => {
    const { claimSubjectRun } = await import("./dispatch.js");
    const runRegistry = registry();
    const firstStart = vi.fn(async () => "run-a");
    expect(
      await claimSubjectRun(
        { subjectKey: "pr:github:acme/api#7", ticketKey: null, kind: "pr_trigger" },
        runRegistry,
        2,
        { startWorkflow: firstStart },
      ),
    ).toEqual({ started: true, runId: "run-a" });

    const secondStart = vi.fn(async () => "run-b");
    expect(
      await claimSubjectRun(
        { subjectKey: "pr:github:acme/api#7", ticketKey: null, kind: "pr_trigger" },
        runRegistry,
        2,
        { startWorkflow: secondStart },
      ),
    ).toEqual({ started: false, reason: "already_claimed" });
    expect(secondStart).not.toHaveBeenCalled();
  });
});
