import { describe, expect, it, vi } from "vitest";
import type {
  ReviewLedgerDurableFeedEntry,
  ReviewLedgerDurableState,
  ReviewThreadDisposition,
  SettleReviewThreadInput,
} from "../adapters/vcs/types.js";
import { postRunFailureNoteForRun, settleReviewThreads } from "./review-ledger-settle.js";

const MARKER_T1 = "<!-- ai-workflow:ledger:th-1 --> <!-- ai-workflow:bot -->";

const SNAPSHOT_AT = "2026-08-21T10:05:00.000Z";

const thread = (alias: string, threadId: string): ReviewLedgerDurableFeedEntry => ({
  threadId,
  alias,
  source: "human",
  resolvable: true,
  awaitingHuman: false,
  filePath: "src/a.ts",
  line: 10,
  snapshotAt: SNAPSHOT_AT,
});

/**
 * Settle consumes the durable projection, never the live ledger: the same input
 * has to work on the hot path and after a cold resume, and only this shape
 * survives the event log.
 */
const ledger = (
  accepted: ReviewThreadDisposition[],
  feedLite?: ReviewLedgerDurableFeedEntry[],
): ReviewLedgerDurableState => ({
  dispositions: accepted,
  declaredWrites: true,
  truncated: 0,
  rejectedCount: 0,
  feedLite: feedLite ?? [
    thread("T1", "th-1"),
    thread("T2", "th-2"),
    thread("T3", "th-3"),
    thread("T4", "th-4"),
  ],
});

const fourDispositions: ReviewThreadDisposition[] = [
  { alias: "T1", disposition: "actionable", reply: "Renamed the helper." },
  {
    alias: "T2",
    disposition: "already_addressed",
    evidence: { filePath: "src/a.ts", quote: "const already = true;" },
  },
  { alias: "T3", disposition: "question", reply: "Which case do you mean?" },
  { alias: "T4", disposition: "out_of_scope", reply: "Tracked separately." },
];

describe("settleReviewThreads", () => {
  it("settles every accepted disposition sequentially and resolves only the actionable one", async () => {
    const calls: SettleReviewThreadInput[] = [];
    const settleReviewThread = vi.fn(async (input: SettleReviewThreadInput) => {
      calls.push(input);
      return { action: input.resolve ? ("replied_and_resolved" as const) : ("replied" as const) };
    });

    const results = await settleReviewThreads({
      ledger: ledger(fourDispositions),
      headSha: "abc1234",
      prId: 7,
      repoPath: "acme/api",
      adapter: { settleReviewThread },
    });

    expect(calls.map((call) => call.thread.threadId)).toEqual(["th-1", "th-2", "th-3", "th-4"]);
    expect(calls.map((call) => call.resolve)).toEqual([true, false, false, false]);
    expect(calls.map((call) => call.prId)).toEqual([7, 7, 7, 7]);
    expect(calls.map((call) => call.snapshotAt)).toEqual([
      "2026-08-21T10:05:00.000Z",
      "2026-08-21T10:05:00.000Z",
      "2026-08-21T10:05:00.000Z",
      "2026-08-21T10:05:00.000Z",
    ]);
    // The reply body is review-ledger.ts's business; all this asserts is that
    // the planned body, pushed sha and thread marker reach the adapter intact.
    expect(calls[0]!.body).toContain("Addressed in `abc1234`.");
    expect(calls[0]!.body).toContain("Renamed the helper.");
    expect(calls[0]!.body).toContain(MARKER_T1);
    expect(results).toEqual([
      { threadId: "th-1", alias: "T1", action: "replied_and_resolved" },
      { threadId: "th-2", alias: "T2", action: "replied" },
      { threadId: "th-3", alias: "T3", action: "replied" },
      { threadId: "th-4", alias: "T4", action: "replied" },
    ]);
  });

  it("keeps settling the remaining threads after one thread fails", async () => {
    const settleReviewThread = vi.fn(async (input: SettleReviewThreadInput) => {
      if (input.thread.threadId === "th-2") throw new Error("  provider 500  ");
      return { action: "replied" as const };
    });

    const results = await settleReviewThreads({
      ledger: ledger(fourDispositions),
      headSha: "abc1234",
      prId: 7,
      repoPath: "acme/api",
      adapter: { settleReviewThread },
    });

    expect(settleReviewThread).toHaveBeenCalledTimes(4);
    expect(results[1]).toEqual({ threadId: "th-2", alias: "T2", error: "provider 500" });
    expect(results.map((entry) => entry.alias)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(results[2]!.error).toBeUndefined();
    expect(results[3]!.error).toBeUndefined();
  });

  it("lets a run control signal stop the loop instead of filing it per thread", async () => {
    // Same serialized shape a cancelled run has after crossing the Workflow VM
    // boundary (blocks/test-support.ts runControlErrorCases).
    const cancelled = new Error('Workflow run "wrun-1" cancelled');
    cancelled.name = "WorkflowRunCancelledError";
    const settleReviewThread = vi.fn(async (input: SettleReviewThreadInput) => {
      if (input.thread.threadId === "th-2") throw cancelled;
      return { action: "replied" as const };
    });

    await expect(
      settleReviewThreads({
        ledger: ledger(fourDispositions),
        headSha: "abc1234",
        prId: 7,
        repoPath: "acme/api",
        adapter: { settleReviewThread },
      }),
    ).rejects.toBe(cancelled);

    expect(settleReviewThread).toHaveBeenCalledTimes(2);
  });

  // Not posting is right (there is no commit to cite), staying quiet about it is
  // not: the reviewer is waiting on an answer to that thread.
  it("reports the actionable thread as an error when nothing was pushed", async () => {
    const settleReviewThread = vi.fn(async () => ({ action: "replied" as const }));

    const results = await settleReviewThreads({
      ledger: ledger(fourDispositions),
      headSha: null,
      prId: 7,
      repoPath: "acme/api",
      adapter: { settleReviewThread },
    });

    expect(results.map((entry) => entry.alias)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(results[0]).toEqual({
      threadId: "th-1",
      alias: "T1",
      error: "no pushed head for acme/api",
    });
    expect(settleReviewThread).toHaveBeenCalledTimes(3);
  });

  it("caps provider writes at 20 and reports the rest as skipped", async () => {
    const threads = Array.from({ length: 25 }, (_, index) =>
      thread(`T${index + 1}`, `th-${index + 1}`),
    );
    const accepted: ReviewThreadDisposition[] = threads.map((entry) => ({
      alias: entry.alias,
      disposition: "question",
      reply: "Answered.",
    }));
    const settleReviewThread = vi.fn(async () => ({ action: "replied" as const }));

    const results = await settleReviewThreads({
      ledger: ledger(accepted, threads),
      headSha: "abc1234",
      prId: 7,
      repoPath: "acme/api",
      adapter: { settleReviewThread },
    });

    expect(settleReviewThread).toHaveBeenCalledTimes(20);
    // Every accepted disposition is accounted for; the five over the cap say why.
    expect(results).toHaveLength(25);
    expect(results.slice(20)).toEqual(
      Array.from({ length: 5 }, (_, index) => ({
        threadId: `th-${index + 21}`,
        alias: `T${index + 21}`,
        skipped: "cap",
      })),
    );
  });

  // The 300 s invocation ceiling is real, and a killed invocation loses the
  // whole publication result; an unanswered thread only waits for the next run.
  it("stops at the deadline and reports the rest as skipped", async () => {
    let clock = 1_000;
    const settleReviewThread = vi.fn(async () => {
      clock += 40_000;
      return { action: "replied" as const };
    });

    const results = await settleReviewThreads({
      ledger: ledger(fourDispositions),
      headSha: "abc1234",
      prId: 7,
      repoPath: "acme/api",
      adapter: { settleReviewThread },
      deadlineMs: 60_000,
      now: () => clock,
    });

    expect(settleReviewThread).toHaveBeenCalledTimes(2);
    expect(results.map((entry) => entry.action ?? entry.skipped)).toEqual([
      "replied",
      "replied",
      "deadline",
      "deadline",
    ]);
  });

  it("reports a thread the feed lost and a third party thread instead of dropping them", async () => {
    const settleReviewThread = vi.fn(async () => ({ action: "replied" as const }));

    const results = await settleReviewThreads({
      ledger: ledger(
        [
          { alias: "T1", threadId: "th-1", disposition: "question", reply: "Yes." },
          { alias: "T2", threadId: "th-2", disposition: "question", reply: "Yes." },
          { alias: "T9", threadId: "th-9", disposition: "question", reply: "Yes." },
        ],
        [thread("T1", "th-1"), { ...thread("T2", "th-2"), source: "third_party" }],
      ),
      headSha: "abc1234",
      prId: 7,
      repoPath: "acme/api",
      adapter: { settleReviewThread },
    });

    expect(settleReviewThread).toHaveBeenCalledOnce();
    expect(results).toEqual([
      { threadId: "th-1", alias: "T1", action: "replied" },
      { threadId: "th-2", alias: "T2", skipped: "third_party" },
      { threadId: "th-9", alias: "T9", skipped: "thread_gone" },
    ]);
  });

  it("settles nothing when the projection carries no dispositions", async () => {
    const settleReviewThread = vi.fn(async () => ({ action: "replied" as const }));

    const results = await settleReviewThreads({
      ledger: ledger([]),
      headSha: "abc1234",
      prId: 7,
      repoPath: "acme/api",
      adapter: { settleReviewThread },
    });

    expect(results).toEqual([]);
    expect(settleReviewThread).not.toHaveBeenCalled();
  });

  it("passes evidencePresent through, so a stale quote is never re-posted", async () => {
    const bodyWith = async (evidencePresent?: (d: ReviewThreadDisposition) => boolean) => {
      const settleReviewThread = vi.fn(async (_input: SettleReviewThreadInput) => ({
        action: "replied" as const,
      }));
      await settleReviewThreads({
        ledger: ledger([fourDispositions[1]!]),
        headSha: "abc1234",
        prId: 7,
        repoPath: "acme/api",
        adapter: { settleReviewThread },
        ...(evidencePresent ? { evidencePresent } : {}),
      });
      return settleReviewThread.mock.calls[0]![0]!.body;
    };

    // The default trusts the disposition, so the reply quotes the evidence.
    expect(await bodyWith()).toContain("const already = true;");
    expect(await bodyWith(() => false)).not.toContain("const already = true;");
  });
});

describe("postRunFailureNoteForRun", () => {
  it("posts the built note on the PR", async () => {
    const postRunFailureNote = vi.fn(async () => {});

    const result = await postRunFailureNoteForRun({
      adapter: { postRunFailureNote },
      prId: 7,
      runId: "wrun_1",
      reason: "sandbox died",
      unsettledAliases: ["T1", "T2"],
    });

    expect(result).toEqual({ posted: true });
    expect(postRunFailureNote).toHaveBeenCalledWith({
      prId: 7,
      runId: "wrun_1",
      body:
        "AI Workflow run `wrun_1` failed before it could address review feedback: sandbox died. " +
        "Threads left open: T1, T2.",
    });
  });

  it("swallows a provider failure so the run's own failure path stays intact", async () => {
    const postRunFailureNote = vi.fn(async () => {
      throw new Error(" note rejected ");
    });

    const result = await postRunFailureNoteForRun({
      adapter: { postRunFailureNote },
      prId: 7,
      runId: "wrun_1",
      reason: "sandbox died",
      unsettledAliases: [],
    });

    expect(result).toEqual({ posted: false, error: "note rejected" });
  });
});
