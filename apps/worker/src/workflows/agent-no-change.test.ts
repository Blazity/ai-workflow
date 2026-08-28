import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchResult } from "../sandbox/agents/types.js";
import type {
  ReviewLedgerState,
  ReviewThread,
  ReviewThreadDisposition,
} from "../adapters/vcs/types.js";
import type { SettledThread } from "./review-ledger-settle.js";
import { buildReviewLedgerDurableState } from "./review-ledger.js";
import {
  applyReviewLedgerGate,
  buildLedgerNoChangeComment,
  buildResolutionEvidenceComment,
  countSettleOutcomes,
  entryNeedsTicketStatusReplay,
  postReviewLedgerFailureNoteStep,
  resolveNoChangeAction,
  runLedgerEvidenceSecondPass,
  settledAnswerCount,
  settleReviewLedgerThreads,
  unsettledWorkItemAliases,
  type ReviewLedgerMetrics,
} from "./agent.js";
import { makeCtx, makePrPayload } from "./blocks/test-support.js";

// The failure note is the only step here that talks to a provider; everything
// else in this file is pure. Mocked at module level so the note's body can be
// read off the adapter it would have posted to.
const vcs = vi.hoisted(() => ({ postRunFailureNote: vi.fn() }));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVCS: () => vcs,
}));
// Only the settle step is replaced; the failure note helper next to it stays
// real, because the tests below assert on the body it builds.
const settle = vi.hoisted(() => ({ settleReviewLedgerStep: vi.fn() }));
vi.mock("./review-ledger-settle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-ledger-settle.js")>()),
  settleReviewLedgerStep: settle.settleReviewLedgerStep,
}));

const research = (overrides: Partial<ResearchResult> = {}): ResearchResult => ({
  status: "completed",
  body: "The reported crash is already fixed on main.",
  noChangeNeeded: true,
  resolutionEvidence: [
    "Commit a1b2c3d guards the null branch.",
    "PR #412 shipped the same fix.",
  ],
  writeRepositories: [],
  ...overrides,
});

describe("buildResolutionEvidenceComment", () => {
  it("states the no-op, quotes the research body, and bullets every evidence entry", () => {
    expect(buildResolutionEvidenceComment(research())).toBe(
      [
        "This ticket appears to be already resolved, so no code changes were made by this run.",
        "",
        "The reported crash is already fixed on main.",
        "",
        "Evidence:",
        "- Commit a1b2c3d guards the null branch.",
        "- PR #412 shipped the same fix.",
      ].join("\n"),
    );
  });

  it("keeps the copy free of en and em dashes", () => {
    const comment = buildResolutionEvidenceComment(
      research({
        body: "Nothing to do, the fix landed earlier.",
        resolutionEvidence: ["Ticket comment: Fixed in 9f8e7d6."],
      }),
    );
    // U+2013 en dash and U+2014 em dash, matched by escape so this file does
    // not spell them out either.
    expect(comment).not.toMatch(/[\u2013\u2014]/);
  });

  it("drops the evidence section when there is none to list", () => {
    const withEmpty = buildResolutionEvidenceComment(
      research({ resolutionEvidence: [] }),
    );
    const withMissing = buildResolutionEvidenceComment(
      research({ resolutionEvidence: undefined }),
    );
    expect(withEmpty).toBe(
      [
        "This ticket appears to be already resolved, so no code changes were made by this run.",
        "",
        "The reported crash is already fixed on main.",
      ].join("\n"),
    );
    expect(withMissing).toBe(withEmpty);
  });
});

describe("resolveNoChangeAction", () => {
  const contextWith = (prComments: Array<{ author: string; body: string; liked: boolean }>) => [
    { prComments },
  ];
  const humanComment = [
    { author: "Bob", body: "please add the missing null check", liked: false },
  ];

  it("returns no_change for a complete signal with no repository contexts", () => {
    expect(resolveNoChangeAction(research(), [], false)).toBe("no_change");
  });

  it("returns no_change when the ticket's PR has no comments", () => {
    expect(resolveNoChangeAction(research(), contextWith([]), false)).toBe(
      "no_change",
    );
  });

  it("returns retry on the first declaration against pending PR feedback", () => {
    expect(
      resolveNoChangeAction(research(), contextWith(humanComment), false),
    ).toBe("retry");
  });

  it("returns fail when the retry was already spent", () => {
    expect(
      resolveNoChangeAction(research(), contextWith(humanComment), true),
    ).toBe("fail");
  });

  it("returns proceed for a half-filled signal even with pending PR feedback", () => {
    expect(
      resolveNoChangeAction(
        research({ resolutionEvidence: [] }),
        contextWith(humanComment),
        false,
      ),
    ).toBe("proceed");
    expect(
      resolveNoChangeAction(
        research({
          writeRepositories: [
            { provider: "github", repoPath: "acme/api", rationale: "fix lives here" },
          ],
        }),
        contextWith(humanComment),
        false,
      ),
    ).toBe("proceed");
    expect(
      resolveNoChangeAction(
        research({ noChangeNeeded: undefined }),
        contextWith(humanComment),
        false,
      ),
    ).toBe("proceed");
  });
});

describe("review ledger gate", () => {
  const thread = (
    overrides: Partial<ReviewThread> & Pick<ReviewThread, "threadId" | "alias">,
  ): ReviewThread => ({
    source: "human",
    resolvable: true,
    awaitingHuman: false,
    notes: [
      {
        author: "alice",
        body: "restore the null check",
        createdAt: "2026-08-20T10:00:00.000Z",
        isLedgerReply: false,
      },
    ],
    ...overrides,
  });

  const ledgerWith = (
    threads: ReviewThread[],
    truncated = 0,
  ): ReviewLedgerState => ({
    feed: { threads, truncated, contextTruncated: 0, snapshotAt: "2026-08-21T09:00:00.000Z" },
    dispositions: [],
    verification: null,
  });

  const deps = (
    overrides: Partial<Parameters<typeof applyReviewLedgerGate>[1]> = {},
  ) => ({
    readFile: vi.fn().mockResolvedValue(null),
    settle: vi.fn().mockResolvedValue([] as SettledThread[]),
    log: vi.fn(),
    ...overrides,
  });

  const disposition = (
    alias: string,
    overrides: Partial<ReviewThreadDisposition> = {},
  ): ReviewThreadDisposition => ({
    alias,
    disposition: "actionable",
    reply: "will fix",
    ...overrides,
  });

  const noWorkItems = () =>
    ledgerWith([
      thread({ threadId: "d-1", alias: "T1", awaitingHuman: true }),
      thread({ threadId: "d-2", alias: "T2", source: "third_party" }),
    ]);

  it("ends a review re-trigger with nothing to answer as a clean no_change", async () => {
    // Round C: no new comment, every thread already carries our reply. The
    // pre-ledger path would read the PR's comment list as pending feedback and
    // drive this into retry then fail; the ledger is the only definition now.
    const ledger = noWorkItems();
    const gateDeps = deps();

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [],
        declaresWrites: false,
        retryUsed: false,
        reviewDriven: true,
      },
      gateDeps,
    );

    expect(outcome?.kind).toBe("no_change");
    const comment = outcome?.kind === "no_change" ? outcome.comment : "";
    expect(comment).toContain("already waiting on a human reply");
    expect(comment).not.toContain("already resolved");
    expect(gateDeps.settle).toHaveBeenCalledTimes(1);
    expect(gateDeps.log).toHaveBeenCalledWith(
      expect.objectContaining({ workItems: 0, gate: "no_change" }),
    );
  });

  it("hands the decision back when the feed carries no thread at all", async () => {
    // A review that only left a summary produces an empty feed. Answering it
    // with a clean no_change would throw away a plan the reviewer asked for, so
    // an empty ledger never decides anything.
    const ledger = ledgerWith([]);
    const gateDeps = deps();

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [],
        declaresWrites: false,
        retryUsed: false,
        reviewDriven: true,
      },
      gateDeps,
    );

    expect(outcome).toBeNull();
    expect(gateDeps.settle).not.toHaveBeenCalled();
    expect(gateDeps.log).not.toHaveBeenCalled();
  });

  it("hands the decision back when the run was not started by a review", async () => {
    // A failing-checks run on the same PR has its own reason to exist, so an
    // empty work-item list must not short circuit it into a no-op.
    const ledger = noWorkItems();
    const gateDeps = deps();

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [],
        declaresWrites: false,
        retryUsed: false,
        reviewDriven: false,
      },
      gateDeps,
    );

    expect(outcome).toBeNull();
    expect(ledger.verification).toBeNull();
    expect(gateDeps.settle).not.toHaveBeenCalled();
  });

  it("proceeds on an accepted actionable disposition and stamps the thread id", async () => {
    const ledger = ledgerWith([thread({ threadId: "d-1", alias: "T1" })]);

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [disposition("T1")],
        declaresWrites: true,
        retryUsed: false,
        reviewDriven: true,
      },
      deps(),
    );

    expect(outcome).toEqual({ kind: "proceed" });
    expect(ledger.verification?.accepted).toEqual([
      { alias: "T1", disposition: "actionable", reply: "will fix", threadId: "d-1" },
    ]);
    expect(ledger.researchDeclaresWrites).toBe(true);
  });

  it("ignores an answer aimed at a context-only thread instead of rejecting it", async () => {
    // The prompt lists awaiting-human and third party threads too, so a model
    // that answers one is confused rather than lying about a thread that does
    // not exist. Rejecting it would burn the retry over a thread nobody has to
    // answer.
    const ledger = ledgerWith([
      thread({ threadId: "d-1", alias: "T1" }),
      thread({ threadId: "d-2", alias: "T2", awaitingHuman: true }),
      thread({ threadId: "d-3", alias: "T3", source: "third_party" }),
    ]);

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [disposition("T1"), disposition("T2"), disposition("T3")],
        declaresWrites: true,
        retryUsed: false,
        reviewDriven: true,
      },
      deps(),
    );

    expect(outcome).toEqual({ kind: "proceed" });
    expect(ledger.verification?.rejected).toEqual([]);
    expect(ledger.verification?.ignoredContextAliases).toEqual(["T2", "T3"]);
  });

  it("buys one retry and names every rejected alias with its reason", async () => {
    const ledger = ledgerWith([
      thread({ threadId: "d-1", alias: "T1" }),
      thread({ threadId: "d-2", alias: "T2" }),
    ]);

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        // T1 answered, T2 skipped entirely, plus an alias nobody asked about.
        dispositions: [disposition("T1"), disposition("T9")],
        declaresWrites: false,
        retryUsed: false,
        reviewDriven: true,
      },
      deps(),
    );

    expect(outcome?.kind).toBe("retry");
    const note = outcome?.kind === "retry" ? outcome.correctionNote : "";
    expect(note).toContain("T2: no disposition");
    expect(note).toContain("T9: unknown alias");
    expect(note).toContain("already_addressed");
  });

  it("fails with the rejected aliases once the retry is spent", async () => {
    const ledger = ledgerWith([thread({ threadId: "d-1", alias: "T1" })]);

    const outcome = await applyReviewLedgerGate(
      { ledger, dispositions: [], declaresWrites: false, retryUsed: true, reviewDriven: true },
      deps(),
    );

    expect(outcome?.kind).toBe("fail");
    const reason = outcome?.kind === "fail" ? outcome.reason : "";
    expect(reason).toContain("T1 (no disposition)");
    expect(reason).toContain("rejected twice");
  });

  it("settles the threads and reports what it answered on a clean no_change", async () => {
    const ledger = ledgerWith(
      [
        thread({ threadId: "d-1", alias: "T1" }),
        thread({ threadId: "d-2", alias: "T2" }),
      ],
      4,
    );
    const settled: SettledThread[] = [
      { threadId: "d-1", alias: "T1", action: "replied" },
      { threadId: "d-2", alias: "T2", action: "replied" },
    ];
    const gateDeps = deps({ settle: vi.fn().mockResolvedValue(settled) });

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [
          disposition("T1", { disposition: "question", reply: "Yes, on purpose." }),
          disposition("T2", { disposition: "out_of_scope", reply: "Different service." }),
        ],
        declaresWrites: false,
        retryUsed: false,
        reviewDriven: true,
      },
      gateDeps,
    );

    expect(gateDeps.settle).toHaveBeenCalledTimes(1);
    expect(outcome?.kind).toBe("no_change");
    const comment = outcome?.kind === "no_change" ? outcome.comment : "";
    expect(comment).toContain("I answered 2 review threads");
    expect(comment).toContain("1 answered as a question");
    expect(comment).toContain("1 declined as out of scope");
    expect(comment).toContain("4 further threads did not fit into this run");
    expect(comment).not.toContain("already resolved");
    expect(outcome?.kind === "no_change" && outcome.settled).toBe(settled);
  });

  it("keeps writing when the research declares writes despite no actionable thread", async () => {
    const ledger = ledgerWith([thread({ threadId: "d-1", alias: "T1" })]);
    const gateDeps = deps();

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [
          disposition("T1", { disposition: "question", reply: "Yes, on purpose." }),
        ],
        declaresWrites: true,
        retryUsed: false,
        reviewDriven: true,
      },
      gateDeps,
    );

    expect(outcome).toEqual({ kind: "proceed" });
    expect(gateDeps.settle).not.toHaveBeenCalled();
  });

  it("logs the review_ledger metric once, with settle outcomes when it settled", async () => {
    const ledger = ledgerWith([thread({ threadId: "d-1", alias: "T1" })], 2);
    const log = vi.fn();
    const gateDeps = deps({
      log,
      settle: vi.fn().mockResolvedValue([
        { threadId: "d-1", alias: "T1", action: "replied" },
        { threadId: "d-2", alias: "T2", error: "boom" },
      ] as SettledThread[]),
    });

    await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [
          disposition("T1", { disposition: "question", reply: "Yes, on purpose." }),
        ],
        declaresWrites: false,
        retryUsed: false,
        reviewDriven: true,
      },
      gateDeps,
    );

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0] as ReviewLedgerMetrics).toEqual({
      event: "review_ledger",
      workItems: 1,
      truncated: 2,
      rejected: 0,
      gate: "no_change",
      dispositions: { question: 1 },
      settled: { replied: 1, error: 1 },
    });
  });

  it("verifies already_addressed evidence against the branch the run is on", async () => {
    const ledger = ledgerWith([
      thread({ threadId: "d-1", alias: "T1", filePath: "src/a.ts", line: 3 }),
    ]);
    const readFile = vi
      .fn()
      .mockResolvedValue("line one\nline two\nif (user == null) return null;\n");

    const outcome = await applyReviewLedgerGate(
      {
        ledger,
        dispositions: [
          disposition("T1", {
            disposition: "already_addressed",
            evidence: { filePath: "src/a.ts", quote: "if (user == null) return null;" },
          }),
        ],
        declaresWrites: false,
        retryUsed: false,
        reviewDriven: true,
      },
      deps({ readFile }),
    );

    expect(readFile).toHaveBeenCalledWith("src/a.ts");
    expect(outcome?.kind).toBe("no_change");
  });
});

describe("unsettledWorkItemAliases", () => {
  const workItem = (threadId: string, alias: string): ReviewThread => ({
    threadId,
    alias,
    source: "human",
    resolvable: true,
    awaitingHuman: false,
    notes: [],
  });

  const ledger: ReviewLedgerState = {
    feed: {
      threads: [workItem("d-1", "T1"), workItem("d-2", "T2"), workItem("d-3", "T3")],
      truncated: 0,
      contextTruncated: 0,
      snapshotAt: "2026-08-21T09:00:00.000Z",
    },
    dispositions: [],
    verification: null,
  };

  it("drops the threads settle already answered and keeps the failures", () => {
    expect(
      unsettledWorkItemAliases(ledger, [
        { threadId: "d-1", alias: "T1", action: "replied_and_resolved" },
        { threadId: "d-2", alias: "T2", error: "provider 500" },
      ]),
    ).toEqual(["T2", "T3"]);
  });

  it("names every work item when nothing settled at all", () => {
    expect(unsettledWorkItemAliases(ledger, [])).toEqual(["T1", "T2", "T3"]);
  });
});

describe("settledAnswerCount", () => {
  it("counts only the threads that really got a reply", () => {
    // The same predicate unsettledWorkItemAliases uses, from the other side: a
    // skip and a provider error are not answers, and a note claiming they were
    // would contradict the thread the reviewer is looking at.
    expect(
      settledAnswerCount([
        { threadId: "d-1", alias: "T1", action: "replied_and_resolved" },
        { threadId: "d-2", alias: "T2", action: "replied" },
        { threadId: "d-3", alias: "T3", skipped: "cap" },
        { threadId: "d-4", alias: "T4", error: "provider 500" },
        { threadId: "d-5", alias: "T5", action: "replied", error: "provider 500" },
      ]),
    ).toBe(2);
  });

  it("counts nothing when settlement never ran", () => {
    expect(settledAnswerCount([])).toBe(0);
  });
});

describe("buildLedgerNoChangeComment", () => {
  const parkedThread = (
    overrides: Partial<ReviewThread> & Pick<ReviewThread, "threadId" | "alias">,
  ): ReviewThread => ({
    source: "human",
    resolvable: true,
    awaitingHuman: true,
    notes: [],
    ...overrides,
  });

  const nothingAnswered = (threads: ReviewThread[]): ReviewLedgerState => ({
    feed: { threads, truncated: 0, contextTruncated: 0, snapshotAt: "2026-08-21T09:00:00.000Z" },
    dispositions: [],
    verification: { accepted: [], rejected: [] },
  });

  it("says the threads wait on a human only when some really do", () => {
    expect(
      buildLedgerNoChangeComment(nothingAnswered([parkedThread({ threadId: "d-1", alias: "T1" })])),
    ).toContain("already waiting on a human reply");
  });

  it("names another tool's bot when that is the only thing left open", () => {
    // Telling the reviewer their answer is awaited, when the only open thread
    // belongs to a scanner bot, sends them looking for a question nobody asked.
    const comment = buildLedgerNoChangeComment(
      nothingAnswered([
        parkedThread({
          threadId: "d-1",
          alias: "T1",
          source: "third_party",
          awaitingHuman: false,
        }),
      ]),
    );
    expect(comment).toContain("owned by another tool's bot");
    expect(comment).not.toContain("waiting on a human");
  });

  it("names both reasons when the feed carries both", () => {
    const comment = buildLedgerNoChangeComment(
      nothingAnswered([
        parkedThread({ threadId: "d-1", alias: "T1" }),
        parkedThread({
          threadId: "d-2",
          alias: "T2",
          source: "third_party",
          awaitingHuman: false,
        }),
      ]),
    );
    expect(comment).toContain("already waiting on a human reply or owned by another tool's bot");
  });

  it("keeps the copy free of en and em dashes", () => {
    const comment = buildLedgerNoChangeComment({
      feed: { threads: [], truncated: 1, contextTruncated: 0, snapshotAt: "2026-08-21T09:00:00.000Z" },
      dispositions: [],
      verification: {
        accepted: [{ alias: "T1", disposition: "already_addressed" }],
        rejected: [],
      },
    });
    expect(comment).not.toMatch(/[–—]/);
    expect(comment).toContain("1 already addressed on the branch");
  });
});

describe("countSettleOutcomes", () => {
  it("counts actions, skips and errors side by side", () => {
    expect(
      countSettleOutcomes([
        { threadId: "d-1", alias: "T1", action: "replied_and_resolved" },
        { threadId: "d-2", alias: "T2", action: "replied_stale" },
        { threadId: "d-3", alias: "T3", skipped: "cap" },
        { threadId: "d-4", alias: "T4", skipped: "third_party" },
        { threadId: "d-5", alias: "T5", error: "provider 500" },
      ]),
    ).toEqual({
      replied_and_resolved: 1,
      replied_stale: 1,
      skipped_cap: 1,
      skipped_third_party: 1,
      error: 1,
    });
  });
});

describe("settleReviewLedgerThreads", () => {
  beforeEach(() => {
    settle.settleReviewLedgerStep.mockReset().mockResolvedValue([]);
  });

  const reviewCtx = () => {
    const ctx = makeCtx({
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr: makePrPayload(),
      },
    });
    ctx.reviewLedger = {
      feed: {
        threads: [
          {
            threadId: "d-1",
            alias: "T1",
            source: "human",
            resolvable: true,
            awaitingHuman: false,
            notes: [],
          },
        ],
        truncated: 0,
        contextTruncated: 0,
        snapshotAt: "2026-08-21T09:00:00.000Z",
      },
      dispositions: [],
      verification: {
        accepted: [
          { alias: "T1", threadId: "d-1", disposition: "question", reply: "answered" },
        ],
        rejected: [],
      },
    };
    return ctx;
  };

  it("answers through the shared settle step, with the durable projection only", async () => {
    // The same step finalize calls. Two implementations of "reply to a thread"
    // would drift, and provider writes replayed in workflow scope are the
    // AIW-251 shape: every resume redoing up to twenty round trips.
    const ctx = reviewCtx();

    await settleReviewLedgerThreads(ctx, null);

    expect(settle.settleReviewLedgerStep).toHaveBeenCalledWith({
      ledger: expect.objectContaining({
        dispositions: [
          { alias: "T1", threadId: "d-1", disposition: "question", reply: "answered" },
        ],
      }),
      headSha: null,
      prId: 7,
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });
    // Full threads with note bodies would be a step input, so they must not be
    // anywhere in what crosses the boundary.
    const input = settle.settleReviewLedgerStep.mock.calls[0]?.[0] as { ledger: unknown };
    expect(JSON.stringify(input.ledger)).not.toContain("notes");
  });

  it("stays silent on a run that never had a ledger", async () => {
    const ctx = reviewCtx();
    ctx.reviewLedger = undefined;

    expect(await settleReviewLedgerThreads(ctx, null)).toEqual([]);
    expect(settle.settleReviewLedgerStep).not.toHaveBeenCalled();
  });
});

describe("entryNeedsTicketStatusReplay", () => {
  it("replays the configured move for a run the ticket column dispatched", () => {
    // Dispatch has no post-success dedup, so a ticket left in the AI column
    // after a no-op terminal would be picked up again.
    expect(entryNeedsTicketStatusReplay("ticket")).toBe(true);
  });

  it("leaves the ticket where it is for every follow-up run", () => {
    // A review comment on a pull request must not move a ticket that is very
    // likely already done, and no such run can be re-picked off the column.
    expect(entryNeedsTicketStatusReplay("pr_trigger")).toBe(false);
    expect(entryNeedsTicketStatusReplay("plan_approved")).toBe(false);
    expect(entryNeedsTicketStatusReplay("webhook_trigger")).toBe(false);
    expect(entryNeedsTicketStatusReplay("schedule")).toBe(false);
  });
});

describe("runLedgerEvidenceSecondPass", () => {
  const quote = "if (value === null) return fallback;";
  const branchFile = [
    "export function read(value: string | null) {",
    "  // restored after the review",
    "",
    `  ${quote}`,
    "}",
  ].join("\n");

  const claimed = (): ReviewLedgerState => ({
    feed: {
      threads: [
        {
          threadId: "d-1",
          alias: "T1",
          source: "human",
          resolvable: true,
          awaitingHuman: false,
          filePath: "src/a.ts",
          line: 4,
          notes: [],
        },
      ],
      truncated: 0,
      contextTruncated: 0,
      snapshotAt: "2026-08-21T09:00:00.000Z",
    },
    dispositions: [],
    verification: {
      accepted: [
        {
          alias: "T1",
          threadId: "d-1",
          disposition: "already_addressed",
          evidence: { filePath: "src/a.ts", quote },
        },
      ],
      rejected: [],
    },
  });

  it("keeps the thread on the evidence list when the quote is still on the branch", async () => {
    const ledger = claimed();

    await runLedgerEvidenceSecondPass(ledger, async () => branchFile);

    expect(ledger.evidencePresentThreadIds).toEqual(["d-1"]);
    expect(ledger.verification?.accepted[0]).not.toHaveProperty("evidenceUnverified");
  });

  it("drops the thread from the evidence list when the quote is gone", async () => {
    const ledger = claimed();

    await runLedgerEvidenceSecondPass(ledger, async () => "export function read() {}\n");

    expect(ledger.evidencePresentThreadIds).toEqual([]);
    expect(ledger.verification?.accepted[0]).not.toHaveProperty("evidenceUnverified");
  });

  it("flags the disposition instead of claiming evidence the run could not read", async () => {
    // An implementation sandbox without the PR's repository reads nothing at
    // all. The settler has to say "I could not read this file" rather than tell
    // the reviewer the fragment moved, which is a different, false claim.
    const ledger = claimed();

    await runLedgerEvidenceSecondPass(ledger, async () => null);

    expect(ledger.evidencePresentThreadIds).toEqual([]);
    expect(ledger.verification?.accepted).toEqual([
      expect.objectContaining({ alias: "T1", threadId: "d-1", evidenceUnverified: true }),
    ]);
    // The durable projection is what a settle after a cold resume answers from.
    expect(buildReviewLedgerDurableState(ledger).dispositions[0]).toMatchObject({
      evidenceUnverified: true,
    });
  });
});

describe("postReviewLedgerFailureNoteStep", () => {
  const pr = {
    provider: "github" as const,
    repoPath: "acme/api",
    baseRef: "main",
    prNumber: 7,
  };
  const postedBody = (): string =>
    (vcs.postRunFailureNote.mock.calls[0]?.[0] as { body: string }).body;

  beforeEach(() => {
    vcs.postRunFailureNote.mockReset().mockResolvedValue(undefined);
  });

  it("names every unanswered thread by the place the reviewer is looking at", async () => {
    // "T1" means nothing outside this run: the reviewer never saw an alias.
    const result = await postReviewLedgerFailureNoteStep({
      pr,
      runId: "wrun_1",
      reason: "sandbox died",
      unsettledAliases: ["T1", "T3"],
      variant: "threads",
      workItems: [
        { alias: "T1", threadId: "d-1", filePath: "src/a.ts", line: 42 },
        { alias: "T3", threadId: "d-3" },
      ],
      pushedHead: null,
      answeredCount: 0,
    });

    expect(result).toEqual({ posted: true });
    expect(postedBody()).toContain("T1 (src/a.ts:42)");
    expect(postedBody()).toContain("T3 (general comment)");
  });

  it("credits the push when the run answered nothing but did reach the branch", async () => {
    // The checks block is where a fix run usually dies, and by then the fix is
    // on the branch. "failed before it could address review feedback" would send
    // the reviewer looking for changes that are already in front of them.
    await postReviewLedgerFailureNoteStep({
      pr,
      runId: "wrun_1",
      reason: "checks did not finish",
      unsettledAliases: ["T1"],
      variant: "threads",
      workItems: [{ alias: "T1", threadId: "d-1", filePath: "src/a.ts", line: 42 }],
      pushedHead: "def456",
      answeredCount: 0,
    });

    expect(postedBody()).toContain("pushed `def456`");
    expect(postedBody()).toContain("T1 (src/a.ts:42)");
  });

  it("credits the replies already posted when no thread was left open", async () => {
    // finalize answered every thread and the run died afterwards. Telling the
    // reviewer it "failed before it could address review feedback" sends them
    // looking for replies that are already sitting in their threads.
    await postReviewLedgerFailureNoteStep({
      pr,
      runId: "wrun_1",
      reason: "pre-PR checks did not pass",
      unsettledAliases: [],
      variant: "threads",
      workItems: [{ alias: "T1", threadId: "d-1" }],
      pushedHead: null,
      answeredCount: 2,
    });

    expect(postedBody()).toContain("answered all 2 open review threads");
    expect(postedBody()).not.toContain("before it could address review feedback");
  });

  it("claims nothing about threads when the run never had a ledger", async () => {
    // Two runs land here: one that died before reading the feed, and one whose
    // review opened no thread at all. A note that names threads would be wrong
    // for the second, so this variant talks about neither.
    await postReviewLedgerFailureNoteStep({
      pr,
      runId: "wrun_1",
      reason: "clone failed",
      unsettledAliases: [],
      variant: "pre_feed",
      workItems: [],
      pushedHead: null,
      answeredCount: 0,
    });

    expect(postedBody()).toContain("`wrun_1` failed on this pull request");
    expect(postedBody()).toContain("clone failed");
    expect(postedBody()).not.toContain("thread");
    expect(postedBody()).not.toContain("pushed");
  });

  it("says what it pushed before dying, so the note never implies an untouched branch", async () => {
    await postReviewLedgerFailureNoteStep({
      pr,
      runId: "wrun_1",
      reason: "checks did not finish",
      unsettledAliases: [],
      variant: "pre_feed",
      workItems: [],
      pushedHead: "def456",
      answeredCount: 0,
    });

    expect(postedBody()).toContain("pushed `def456`");
  });
});

/**
 * Source tripwire, deliberately narrow.
 *
 * postReviewLedgerFailureNoteOnFailureExit is a closure inside
 * agentWorkflowBody, which is not exported, so no test can invoke it to prove
 * that a flag-off run posts no failure note. What follows therefore asserts
 * ONLY that a REVIEW_LEDGER_ENABLED reference still sits on the lines above
 * the postReviewLedgerFailureNoteStep call. It cannot tell a live guard from a
 * dead local, and it cannot see work hoisted above the guard. It catches one
 * thing: the flag check being deleted or moved below the call, which would
 * post a ledger-failure note on a run with the flag off (prod: run
 * wrun_01M0Z24PJ92043J4Z4BZE7PZSK on MR !11). Treat a failure as "go read the
 * call site", not as a behavioral regression.
 */
describe("postReviewLedgerFailureNoteOnFailureExit flag gate", () => {
  const agentLines = readFileSync(
    fileURLToPath(new URL("./agent.ts", import.meta.url)),
    "utf8",
  ).split("\n");

  it("still checks REVIEW_LEDGER_ENABLED before posting a failure note on a failed trigger_pr_review run", () => {
    const index = agentLines.findIndex((line) =>
      line.includes("postReviewLedgerFailureNoteStep({"),
    );
    expect(index, "postReviewLedgerFailureNoteStep is no longer called in agent.ts").toBeGreaterThan(-1);

    const window = agentLines.slice(Math.max(0, index - 20), index);
    expect(
      window.some((line) => line.includes("env.REVIEW_LEDGER_ENABLED")),
      "no REVIEW_LEDGER_ENABLED reference guards postReviewLedgerFailureNoteStep, so a flag-off run still posts the failure note",
    ).toBe(true);
  });
});

describe("planning analysis report provenance", () => {
  const agentLines = readFileSync(
    fileURLToPath(new URL("./agent.ts", import.meta.url)),
    "utf8",
  ).split("\n");

  it("captures the research manifest before write-scope promotion", () => {
    const snapshotIndex = agentLines.findIndex((line) =>
      line.includes("const researchWorkspaceManifest = ctx.workspaceManifest;"),
    );
    const promotionIndex = agentLines.findIndex(
      (line, index) =>
        index > snapshotIndex &&
        line.includes("const promotion = await promoteWorkspaceWrites("),
    );
    const reportIndex = agentLines.findIndex((line) =>
      line.includes("workspaceManifest: researchWorkspaceManifest,"),
    );

    expect(snapshotIndex, "research manifest snapshot is missing").toBeGreaterThan(-1);
    expect(promotionIndex, "planning promotion is missing").toBeGreaterThan(snapshotIndex);
    expect(reportIndex, "report does not use the pre-promotion manifest").toBeGreaterThan(promotionIndex);
  });
});
