import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReviewThreadFeed } from "../../adapters/vcs/types.js";
import type { ResearchResult } from "../../sandbox/agents/types.js";
import {
  AI_WORKFLOW_COMMENT_MARKER,
  resolvePendingReviewFeedback,
} from "../../adapters/vcs/vcs-bot-identity.js";
import { assembleResearchPlanContext } from "../../sandbox/context.js";
import {
  pendingReviewFeedbackSentence,
  resolveNoChangeAction,
} from "../helpers/review-ledger.js";

/**
 * ONE QUESTION, TWO READERS.
 *
 * "Is somebody still waiting on this run's pull request" decides two things a
 * reviewer feels: the prompt tells the agent the review is the task, and the
 * engine refuses the already-resolved exit. They used to be separate
 * expressions, and they disagreed. A reviewer with an open thread got back a
 * run that closed itself saying nothing needed doing, and a pull request
 * carrying nothing but this workflow's own run summary could never finish at
 * all.
 *
 * Every shape below is asserted against BOTH readers at once, so a change that
 * moves one without the other cannot pass.
 */

const ticket = {
  identifier: "AWP-107",
  title: "Remediate the review",
  description: "The refresh path drops the previous signing key.",
  acceptanceCriteria: "A second deploy keeps existing sessions alive.",
  comments: [],
};

const repositoryA = {
  provider: "github" as const,
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "workflow-owned branch for this ticket",
};
const repositoryB = { ...repositoryA, repoPath: "acme/web" };

const note = (author: string, body: string, isLedgerReply = false) => ({
  author,
  body,
  createdAt: "2026-09-18T10:00:00.000Z",
  isLedgerReply,
});

/** A person asked for something and nobody has answered. */
const openHumanThread = {
  threadId: "PRRT_1",
  alias: "T1",
  source: "human" as const,
  resolvable: true,
  awaitingHuman: false,
  filePath: "src/auth/session.ts",
  line: 42,
  notes: [note("piotr", "The refresh path still reads the rotated key.")],
};

/** We answered; the ball is in the reviewer's court. */
const parkedThread = {
  threadId: "PRRT_2",
  alias: "T2",
  source: "human" as const,
  resolvable: true,
  awaitingHuman: true,
  filePath: "src/db/schema.ts",
  notes: [
    note("carol", "Why is this nullable?"),
    note("ai-workflow", "Already addressed in `src/db/schema.ts`.", true),
  ],
};

/** Another tool's bot, which the ledger never replies to. */
const thirdPartyThread = {
  threadId: "PRRT_3",
  alias: "T3",
  source: "third_party" as const,
  resolvable: true,
  awaitingHuman: false,
  notes: [note("coderabbitai", "Consider extracting this helper.")],
};

const feedOf = (threads: ReviewThreadFeed["threads"]): ReviewThreadFeed => ({
  threads,
  truncated: 0,
  contextTruncated: 0,
  snapshotAt: "2026-09-18T10:05:00.000Z",
});

const humanComment = {
  author: "piotr",
  body: "Please keep the previous key for one deploy.",
  liked: false,
};

/**
 * The review pass's own markers, read out of the adapter that writes them
 * rather than copied here. Copied, they would keep passing after the family was
 * renamed, and this test would go on proving that the predicate handles a
 * marker nothing emits any more.
 */
function markerWrittenBy(relativePath: string, family: string): string {
  const source = readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
  const found = source.match(new RegExp(`<!--\\s*${family}[^>]*-->`));
  if (!found) throw new Error(`${relativePath} no longer writes a ${family} marker`);
  return found[0].replace(/\$\{[^}]*\}/g, "abc123");
}

const reviewFindingMarker = markerWrittenBy(
  "../../adapters/vcs/github.ts",
  "ai-workflow-review-finding:",
);
const reviewHeadMarker = markerWrittenBy(
  "../../adapters/vcs/github.ts",
  "ai-workflow-review-head:",
);

/** What post_pr_comment leaves behind on every workflow-owned pull request. */
const ourOwnNote = {
  author: "ai-workflow",
  body: `Automated fix pushed: 2 files changed.\n\n${AI_WORKFLOW_COMMENT_MARKER}`,
  liked: false,
};

/**
 * What "Quote reply" produces when a reviewer answers the note above: our body
 * copied line by line behind a `>`, marker and all, then the reviewer's own
 * words.
 */
const quoteReplyToOurNote = {
  author: "piotr",
  body: [
    ...ourOwnNote.body.split("\n").map((line) => (line ? `> ${line}` : ">")),
    "",
    "This did not fix it. The button is still dead on mobile.",
  ].join("\n"),
  liked: false,
};

type Context = {
  repository: typeof repositoryA;
  prComments: Array<{ author: string; body: string; liked: boolean }>;
  checkResults: never[];
  hasConflicts: boolean;
  reviewThreads?: ReviewThreadFeed;
};

const contextOf = (
  repository: typeof repositoryA,
  overrides: Partial<Context> = {},
): Context => ({
  repository,
  prComments: [],
  checkResults: [],
  hasConflicts: false,
  ...overrides,
});

const research = (overrides: Partial<ResearchResult> = {}): ResearchResult => ({
  status: "completed",
  body: "The reported crash is already fixed on main.",
  noChangeNeeded: true,
  resolutionEvidence: ["Commit a1b2c3d guards the null branch."],
  writeRepositories: [],
  ...overrides,
});

/** The two sentences the prompt only writes when the review is the task. */
const REMEDIATION_FRAMING = "Human reviewers requested the changes below";
const ALREADY_RESOLVED_EXIT = "## Resolution Check";

function promptFor(contexts: Context[]): string {
  return assembleResearchPlanContext({
    ticket,
    prompt: "",
    branchName: "ai-workflow/AWP-107",
    repositoryContexts: contexts as never,
  });
}

/** What the two readers say, in the words a person would use. */
function readersFor(contexts: Context[]): {
  promptCallsItRemediation: boolean;
  promptOffersTheAlreadyResolvedExit: boolean;
  gate: string;
} {
  const prompt = promptFor(contexts);
  return {
    promptCallsItRemediation: prompt.includes(REMEDIATION_FRAMING),
    promptOffersTheAlreadyResolvedExit: prompt.includes(ALREADY_RESOLVED_EXIT),
    gate: resolveNoChangeAction(research(), contexts as never, false),
  };
}

describe("pending review feedback: the prompt and the no-change gate read one predicate", () => {
  it("does not close a run that a reviewer's open thread is waiting on, even with an empty comment list", () => {
    // THE DRIFT. The thread feed supersedes the flat comment list by design, so
    // a review whose requests all live in threads leaves the flat list empty or
    // fully covered. The gate used to count that list and only that list, so it
    // answered "nothing pending" over an open request and told the reviewer
    // their thread was unnecessary.
    const contexts = [
      contextOf(repositoryA, { reviewThreads: feedOf([openHumanThread]) }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: true,
      reason: "open_review_threads",
      repositories: ["github:acme/api"],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: true,
      promptOffersTheAlreadyResolvedExit: false,
      gate: "retry",
    });
  });

  it("keeps refusing the exit for a person's comment on a pull request with no thread feed", () => {
    const contexts = [contextOf(repositoryA, { prComments: [humanComment] })];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: true,
      reason: "unanswered_pr_comments",
      repositories: ["github:acme/api"],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: true,
      promptOffersTheAlreadyResolvedExit: false,
      gate: "retry",
    });
  });

  it("reads the same request once when the feed and the flat list both carry it", () => {
    const contexts = [
      contextOf(repositoryA, {
        // Exactly the thread's own note, which is how a provider hands the same
        // request over twice.
        prComments: [
          { author: "piotr", body: "The refresh path still reads the rotated key.", liked: false },
        ],
        reviewThreads: feedOf([openHumanThread]),
      }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: true,
      reason: "open_review_threads",
      repositories: ["github:acme/api"],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: true,
      promptOffersTheAlreadyResolvedExit: false,
      gate: "retry",
    });
  });

  it("lets a genuinely finished run stop when every thread is parked on a human or a third party bot", () => {
    const contexts = [
      contextOf(repositoryA, { reviewThreads: feedOf([parkedThread, thirdPartyThread]) }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: false,
      reason: "no_thread_awaits_an_answer",
      repositories: [],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: false,
      promptOffersTheAlreadyResolvedExit: true,
      gate: "no_change",
    });
  });

  it("does not mistake this workflow's own note on the pull request for somebody waiting", () => {
    // The flat list is every note on the PR, this workflow's included. Counting
    // ours made a second run on a finished ticket spend its corrective retry
    // and then fail, on a pull request nobody had said a word on.
    const contexts = [contextOf(repositoryA, { prComments: [ourOwnNote] })];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: false,
      reason: "only_our_own_notes",
      repositories: [],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: false,
      promptOffersTheAlreadyResolvedExit: true,
      gate: "no_change",
    });
  });

  it("hears a reviewer who quoted our note back at us to say it did not work", () => {
    // The only comment on the pull request carries our marker, because "Quote
    // reply" copied it. Reading the marker wherever it appears would file this
    // reviewer as us and answer their request with "nothing needed doing",
    // which is the exact experience this predicate exists to end. What the
    // author wrote is what counts, and they wrote none of the quoted lines.
    const contexts = [contextOf(repositoryA, { prComments: [quoteReplyToOurNote] })];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: true,
      reason: "unanswered_pr_comments",
      repositories: ["github:acme/api"],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: true,
      promptOffersTheAlreadyResolvedExit: false,
      gate: "retry",
    });
  });

  it("still recognises a note of ours that quotes something itself", () => {
    // The mirror of the case above, and the dangerous direction: reading one of
    // our own notes as a person's would refuse the no-op exit on a pull request
    // nobody is waiting on, and no run on it could finish. Our marker is always
    // on a line of our own, however much the note quotes.
    const contexts = [
      contextOf(repositoryA, {
        prComments: [
          {
            author: "ai-workflow",
            body: `> The button is still dead on mobile.\n\nFixed in a1b2c3d.\n\n${AI_WORKFLOW_COMMENT_MARKER}`,
            liked: false,
          },
        ],
      }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: false,
      reason: "only_our_own_notes",
      repositories: [],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: false,
      promptOffersTheAlreadyResolvedExit: true,
      gate: "no_change",
    });
  });

  it("does not read this workflow's own review findings as a person's words", () => {
    // What `getPRComments` returns on any pull request our review pass has
    // touched: the inline findings, which carry the review marker family and
    // no bot marker at all, and the review submission body, which GitHub
    // prefixes with its verdict. Counting these made the remediation framing
    // claim a human had asked for something on every reviewed pull request
    // there is, which is the normal shape rather than an edge.
    const contexts = [
      contextOf(repositoryA, {
        prComments: [
          {
            author: "ai-workflow",
            body: `The refresh path ignores the previous key.\n\n${reviewFindingMarker}`,
            liked: false,
          },
          {
            author: "ai-workflow",
            body: `[Review: CHANGES_REQUESTED] ${reviewHeadMarker}`,
            liked: false,
          },
        ],
      }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: false,
      reason: "only_our_own_notes",
      repositories: [],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: false,
      promptOffersTheAlreadyResolvedExit: true,
      gate: "no_change",
    });
  });

  it("does not let a feed carrying nothing speak for the comments beside it", () => {
    // `fetch-pr-context` leaves an empty feed on the context even where it
    // refuses to build a ledger from one, and "Request changes" with a summary
    // and no inline comment is exactly that shape: the review's words are in
    // the flat list and nowhere else. A feed of no threads supersedes nothing.
    const contexts = [
      contextOf(repositoryA, {
        prComments: [humanComment],
        reviewThreads: feedOf([]),
      }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: true,
      reason: "unanswered_pr_comments",
      repositories: ["github:acme/api"],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: true,
      promptOffersTheAlreadyResolvedExit: false,
      gate: "retry",
    });
  });

  it("still hears a person through this workflow's own notes on the same pull request", () => {
    const contexts = [
      contextOf(repositoryA, { prComments: [ourOwnNote, humanComment, ourOwnNote] }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: true,
      reason: "unanswered_pr_comments",
      repositories: ["github:acme/api"],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: true,
      promptOffersTheAlreadyResolvedExit: false,
      gate: "retry",
    });
  });

  it("stops a run whose pull request carries no feedback at all", () => {
    const contexts = [contextOf(repositoryA)];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: false,
      reason: "no_pull_request_feedback",
      repositories: [],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: false,
      promptOffersTheAlreadyResolvedExit: true,
      gate: "no_change",
    });
  });

  it("hears one repository out of several", () => {
    const contexts = [
      contextOf(repositoryA),
      contextOf(repositoryB, { prComments: [humanComment] }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: true,
      reason: "unanswered_pr_comments",
      repositories: ["github:acme/web"],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: true,
      promptOffersTheAlreadyResolvedExit: false,
      gate: "retry",
    });
  });

  it("does not let a quiet thread feed on one repository silence a person on another", () => {
    // The gate used to hand itself an empty list the moment a run carried a
    // ledger, which threw away every repository the ledger does not cover.
    const contexts = [
      contextOf(repositoryA, { reviewThreads: feedOf([parkedThread]) }),
      contextOf(repositoryB, { prComments: [humanComment] }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: true,
      reason: "unanswered_pr_comments",
      repositories: ["github:acme/web"],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: true,
      promptOffersTheAlreadyResolvedExit: false,
      gate: "retry",
    });
  });

  it("does not resurrect a thread a reviewer resolved, whose comments outlive it in the flat list", () => {
    // A feed carries unresolved threads only, so a resolved thread's comments
    // stay in the flat list forever. A predicate that added the flat remainder
    // to the feed's work items would answer "pending" on a pull request whose
    // conversation is over, and no run on it could ever finish.
    const contexts = [
      contextOf(repositoryA, {
        prComments: [{ author: "piotr", body: "Resolved ages ago, thanks.", liked: false }],
        reviewThreads: feedOf([parkedThread]),
      }),
    ];

    expect(resolvePendingReviewFeedback(contexts)).toEqual({
      pending: false,
      reason: "no_thread_awaits_an_answer",
      repositories: [],
    });
    expect(readersFor(contexts)).toEqual({
      promptCallsItRemediation: false,
      promptOffersTheAlreadyResolvedExit: true,
      gate: "no_change",
    });
  });
});

describe("what a person is told when the run refuses to stop", () => {
  it("names the reason and the pull request, not a fixed sentence", () => {
    expect(
      pendingReviewFeedbackSentence(
        resolvePendingReviewFeedback([
          contextOf(repositoryA, { reviewThreads: feedOf([openHumanThread]) }),
        ]),
      ),
    ).toBe("github:acme/api has review threads still waiting for an answer");

    expect(
      pendingReviewFeedbackSentence(
        resolvePendingReviewFeedback([
          contextOf(repositoryA),
          contextOf(repositoryB, { prComments: [humanComment] }),
        ]),
      ),
    ).toBe("github:acme/web has pull request comments nobody has answered");
  });

  it("still says something useful when the caller passes no repository", () => {
    expect(
      pendingReviewFeedbackSentence(
        resolvePendingReviewFeedback([{ prComments: [humanComment] }]),
      ),
    ).toBe("the ticket's pull request has pull request comments nobody has answered");
  });
});

describe("a refetch must not leave the ledger talking to itself", () => {
  /**
   * Source-level on purpose. The failure is a call site forgetting an argument,
   * and it shows up four phases later as "no disposition survived
   * verification": the contexts lose `reviewThreads`, the prompt renders no
   * alias block, the agent writes dispositions about nothing, and the reviewer
   * gets a red run blaming them for it. Driving that whole loop to catch one
   * missing argument would be a worse test than reading the argument.
   */
  const workflowSource = readFileSync(
    fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
    "utf8",
  );

  it("passes the ledger options at every fetch of the pull request contexts", () => {
    const calls = workflowSource.match(/blockFetchPrContextsStep\([\s\S]*?\n\s*\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call).toContain("reviewLedgerFetchOptions(ctx)");
    }
  });
});

describe("pending review feedback: the three outcomes keep their meanings", () => {
  const openThread = [contextOf(repositoryA, { reviewThreads: feedOf([openHumanThread]) })];

  it("spends exactly one corrective retry before failing", () => {
    expect(resolveNoChangeAction(research(), openThread as never, false)).toBe("retry");
    expect(resolveNoChangeAction(research(), openThread as never, true)).toBe("fail");
  });

  it("leaves a half-filled no-change signal on the normal plan path", () => {
    for (const half of [
      research({ resolutionEvidence: [] }),
      research({ noChangeNeeded: undefined }),
      research({
        writeRepositories: [
          { provider: "github", repoPath: "acme/api", rationale: "fix lives here" },
        ],
      }),
    ]) {
      expect(resolveNoChangeAction(half, openThread as never, false)).toBe("proceed");
    }
  });
});
