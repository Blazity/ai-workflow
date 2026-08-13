import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { activeRuns, clarificationRequests, workflowRuns } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  answerHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "./hook-store.js";

const mocks = vi.hoisted(() => ({
  getHookByToken: vi.fn(),
  retryAnsweredResume: vi.fn(),
  retireParkedRun: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getHookByToken: (...args: unknown[]) => mocks.getHookByToken(...args),
}));
vi.mock("./answered-resume.js", () => ({
  retryAnsweredResume: (...args: unknown[]) => mocks.retryAnsweredResume(...args),
}));
vi.mock("./retire-park.js", () => ({
  retireParkedRun: (...args: unknown[]) => mocks.retireParkedRun(...args),
}));

const { retryStalledResumes, RESUME_GIVE_UP_MS } = await import(
  "./stalled-resume-sweep.js"
);

const runRegistry = {} as RunRegistryAdapter;
const issueTracker = {} as IssueTrackerAdapter;

async function answeredPark(
  db: Db,
  opts: {
    runId: string;
    ticketKey?: string | null;
    answeredMsAgo?: number;
    runStatus?: string | null;
    claimState?: "bound" | "cancelling";
  },
): Promise<void> {
  const ticketKey = opts.ticketKey === undefined ? "UP-1" : opts.ticketKey;
  const subjectKey = ticketKey
    ? `ticket:jira:${ticketKey}`
    : `pr:github:acme/api:${opts.runId}`;
  await db.insert(activeRuns).values({
    subjectKey,
    ticketKey,
    ownerToken: `owner-${opts.runId}`,
    runId: opts.runId,
    state: opts.claimState ?? "bound",
    runKind: ticketKey ? "ticket" : "pr",
  });
  const prepared = await prepareHookClarification(db, {
    ticketKey,
    subjectKey,
    runId: opts.runId,
    blockId: "question",
    definitionId: 1,
    definitionVersion: 1,
    questions: ["Which repository?"],
  });
  await publishHookClarification(db, prepared.id);
  await answerHookClarification(db, prepared.id, "use the api repository", {
    id: "user-1",
    label: "Filip",
  });
  await db
    .update(clarificationRequests)
    .set({ answeredAt: new Date(Date.now() - (opts.answeredMsAgo ?? 5 * 60_000)) })
    .where(eq(clarificationRequests.id, prepared.id));
  await db.insert(workflowRuns).values({
    runId: opts.runId,
    subjectKey,
    ticketKey,
    status: opts.runStatus === undefined ? "awaiting" : opts.runStatus,
  });
}

const sweep = (db: Db) => retryStalledResumes({ db, runRegistry, issueTracker });

describe("retryStalledResumes", () => {
  beforeEach(() => {
    mocks.getHookByToken.mockReset();
    mocks.retryAnsweredResume.mockReset();
    mocks.retireParkedRun.mockReset();
    mocks.retryAnsweredResume.mockResolvedValue({ status: "resumed" });
    mocks.retireParkedRun.mockResolvedValue({
      outcome: "cancelled",
      scheduleOccurrenceSettled: null,
    });
  });

  it("redelivers an answer whose resume never landed", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1" });

    expect(await sweep(db)).toEqual({ attempted: 1, resumed: 1, retired: 0 });
    expect(mocks.retryAnsweredResume).toHaveBeenCalledWith(
      expect.objectContaining({ row: expect.objectContaining({ runId: "run-1" }) }),
    );
    // Under the give-up threshold nothing needs to know about the hook.
    expect(mocks.getHookByToken).not.toHaveBeenCalled();
  });

  // The park a comment can never reach: no ticket, so no column move and no Jira
  // delivery, which left the dashboard as its only route back.
  it("covers a ticketless park", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1", ticketKey: null });

    expect(await sweep(db)).toEqual({ attempted: 1, resumed: 1, retired: 0 });
  });

  // A stale "resuming" row is an attempt that died with its invocation. Nothing
  // else ever picks it back up, so the pass has to.
  it("takes over a resume attempt that died mid-flight", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1", runStatus: "resuming" });
    await db
      .update(workflowRuns)
      .set({ updatedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(workflowRuns.runId, "run-1"));

    expect((await sweep(db)).attempted).toBe(1);
  });

  it("leaves a fresh answer to the attempt that may still be in flight", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1", answeredMsAgo: 1_000 });

    expect(await sweep(db)).toEqual({ attempted: 0, resumed: 0, retired: 0 });
    expect(mocks.retryAnsweredResume).not.toHaveBeenCalled();
  });

  it("ignores a run that already resumed", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1", runStatus: "running" });

    expect(await sweep(db)).toEqual({ attempted: 0, resumed: 0, retired: 0 });
  });

  it("ignores a park whose claim is no longer bound", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1", claimState: "cancelling" });

    expect(await sweep(db)).toEqual({ attempted: 0, resumed: 0, retired: 0 });
  });

  it("retires the park once redelivering has run out of time", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1", answeredMsAgo: RESUME_GIVE_UP_MS + 1_000 });
    mocks.getHookByToken.mockResolvedValue({ runId: "run-1" });

    expect(await sweep(db)).toEqual({ attempted: 1, resumed: 0, retired: 1 });
    expect(mocks.retireParkedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        cause: { kind: "resume_undeliverable" },
      }),
    );
    expect(mocks.retryAnsweredResume).not.toHaveBeenCalled();
  });

  // A consumed hook means the run is awake and only its marker was lost. Ending
  // it here would kill a live run, so the retry converges the marker instead.
  it("never retires a park whose hook is already consumed", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1", answeredMsAgo: RESUME_GIVE_UP_MS + 1_000 });
    mocks.getHookByToken.mockResolvedValue(null);

    expect(await sweep(db)).toEqual({ attempted: 1, resumed: 1, retired: 0 });
    expect(mocks.retireParkedRun).not.toHaveBeenCalled();
    expect(mocks.retryAnsweredResume).toHaveBeenCalled();
  });

  it("does nothing at all when the hook cannot be read", async () => {
    const db = await createTestDb();
    await answeredPark(db, { runId: "run-1", answeredMsAgo: RESUME_GIVE_UP_MS + 1_000 });
    mocks.getHookByToken.mockRejectedValue(new Error("Workflow API is down"));

    expect(await sweep(db)).toEqual({ attempted: 1, resumed: 0, retired: 0 });
    expect(mocks.retireParkedRun).not.toHaveBeenCalled();
    expect(mocks.retryAnsweredResume).not.toHaveBeenCalled();
  });

  it("caps how many parks one pass touches", async () => {
    const db = await createTestDb();
    for (const index of [1, 2, 3, 4]) {
      await answeredPark(db, { runId: `run-${index}`, ticketKey: `UP-${index}` });
    }

    expect((await sweep(db)).attempted).toBe(3);
  });
});
