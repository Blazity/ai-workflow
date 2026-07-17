import { describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
  RunReservation,
} from "../adapters/run-registry/types.js";
import { claimSubjectRun } from "./dispatch.js";

vi.mock("../../env.js", () => ({
  env: { JIRA_PROJECT_KEY: "PROJ", COLUMN_AI: "AI" },
}));

function registry(): RunRegistryAdapter {
  const rows = new Map<string, ActiveRunEntry>();
  return {
    reserve: vi.fn(async (reservation: RunReservation) => {
      if (rows.has(reservation.subjectKey)) return false;
      const now = Date.now();
      rows.set(reservation.subjectKey, {
        ...reservation,
        runId: null,
        state: "reserved",
        createdAt: now,
        updatedAt: now,
      });
      return true;
    }),
    bindRun: vi.fn(async (subjectKey, ownerToken, runId) => {
      const current = rows.get(subjectKey);
      if (!current || current.state !== "reserved" || current.ownerToken !== ownerToken) return false;
      rows.set(subjectKey, { ...current, state: "bound", runId, updatedAt: Date.now() });
      return true;
    }),
    handoff: vi.fn(),
    get: vi.fn(async (subjectKey) => rows.get(subjectKey) ?? null),
    releaseReservation: vi.fn(async (subjectKey, ownerToken) => {
      const current = rows.get(subjectKey);
      if (!current || current.state !== "reserved" || current.ownerToken !== ownerToken) return false;
      rows.delete(subjectKey);
      return true;
    }),
    release: vi.fn(async (subjectKey, ownerToken, runId) => {
      const current = rows.get(subjectKey);
      if (
        !current || current.state !== "bound" || current.ownerToken !== ownerToken ||
        current.runId !== runId
      ) return false;
      rows.delete(subjectKey);
      return true;
    }),
    listAll: vi.fn(async () => [...rows.values()]),
    registerSandbox: vi.fn(),
    listSandboxes: vi.fn(),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  };
}

const subject = {
  subjectKey: "pr:github:acme/app#7",
  ticketKey: null,
  kind: "pr_trigger" as const,
};

describe("PR trigger coalescing with owner-CAS", () => {
  it("coalesces while the first owner is bound and starts after its terminal release", async () => {
    const runRegistry = registry();
    let firstOwner = "";
    const first = await claimSubjectRun(subject, runRegistry, 3, {
      startWorkflow: async (ownerToken) => {
        firstOwner = ownerToken;
        return "run-1";
      },
    });
    expect(first).toEqual({ started: true, runId: "run-1" });
    expect(await runRegistry.bindRun(subject.subjectKey, firstOwner, "run-1")).toBe(true);

    const secondStart = vi.fn();
    expect(
      await claimSubjectRun(subject, runRegistry, 3, { startWorkflow: secondStart }),
    ).toEqual({ started: false, reason: "already_claimed" });
    expect(secondStart).not.toHaveBeenCalled();

    expect(await runRegistry.release(subject.subjectKey, firstOwner, "run-1")).toBe(true);
    expect(
      await claimSubjectRun(subject, runRegistry, 3, {
        startWorkflow: async () => "run-2",
      }),
    ).toEqual({ started: true, runId: "run-2" });
  });

  it("a stale predecessor cannot release a successor reservation", async () => {
    const runRegistry = registry();
    let predecessorOwner = "";
    await claimSubjectRun(subject, runRegistry, 3, {
      startWorkflow: async (ownerToken) => {
        predecessorOwner = ownerToken;
        return "run-1";
      },
    });
    await runRegistry.bindRun(subject.subjectKey, predecessorOwner, "run-1");
    await runRegistry.release(subject.subjectKey, predecessorOwner, "run-1");

    await claimSubjectRun(subject, runRegistry, 3, {
      startWorkflow: async () => "run-2",
    });
    expect(await runRegistry.release(subject.subjectKey, predecessorOwner, "run-1")).toBe(false);
    expect(await runRegistry.get(subject.subjectKey)).not.toBeNull();
  });
});
