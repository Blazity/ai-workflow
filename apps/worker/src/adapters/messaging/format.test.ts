import { describe, it, expect } from "vitest";
import { formatTicketEvent, formatTicketStatus, neutralizeSlackBroadcasts } from "./format.js";
import type { RunPullRequest } from "@shared/contracts";

const ZWSP = "\u200b";

const JIRA = "https://example.atlassian.net";
const KEY = "AWT-42";
const LINK = `<${JIRA}/browse/${KEY}|${KEY}>`;

const ghPr = (id: number, repoPath = "o/r"): RunPullRequest => ({
  provider: "github",
  repoPath,
  id,
  url: `https://github.com/${repoPath}/pull/${id}`,
});

const glPr = (id: number, repoPath = "g/r"): RunPullRequest => ({
  provider: "gitlab",
  repoPath,
  id,
  url: `https://gitlab.com/${repoPath}/-/merge_requests/${id}`,
});

describe("formatTicketStatus", () => {
  it("started → in progress", () => {
    expect(formatTicketStatus({ kind: "started" }, KEY, JIRA)).toBe(
      `:hourglass_flowing_sand: ${LINK} STATUS: in progress`,
    );
  });

  it("needs_clarification → needs clarification (no commentUrl in header)", () => {
    expect(
      formatTicketStatus(
        {
          kind: "needs_clarification",
          commentUrl: `${JIRA}/browse/${KEY}?focusedCommentId=1`,
        },
        KEY,
        JIRA,
      ),
    ).toBe(`:question: ${LINK} STATUS: needs clarification`);
  });

  it("pr_ready → includes PR link inline", () => {
    expect(
      formatTicketStatus(
        { kind: "pr_ready", prs: [ghPr(9)], usageReport: "u" },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:white_check_mark: ${LINK} STATUS: PR ready (<https://github.com/o/r/pull/9|#9>)`,
    );
  });

  it("pr_ready → a lone GitLab MR uses the provider-native ! reference", () => {
    expect(
      formatTicketStatus(
        { kind: "pr_ready", prs: [glPr(9)], usageReport: "u" },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:white_check_mark: ${LINK} STATUS: PR ready (<https://gitlab.com/g/r/-/merge_requests/9|!9>)`,
    );
  });

  it("pr_ready → multi-repo lists every link, each qualified by repo name", () => {
    expect(
      formatTicketStatus(
        {
          kind: "pr_ready",
          prs: [ghPr(12, "acme/backend"), glPr(3, "acme/ops/infra")],
          usageReport: "u",
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:white_check_mark: ${LINK} STATUS: PR ready (` +
        `<https://github.com/acme/backend/pull/12|backend #12>, ` +
        `<https://gitlab.com/acme/ops/infra/-/merge_requests/3|infra !3>)`,
    );
  });

  it("pr_ready → two repos on one provider stay distinguishable", () => {
    expect(
      formatTicketStatus(
        {
          kind: "pr_ready",
          prs: [ghPr(12, "acme/backend"), ghPr(12, "acme/frontend")],
          usageReport: "u",
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:white_check_mark: ${LINK} STATUS: PR ready (` +
        `<https://github.com/acme/backend/pull/12|backend #12>, ` +
        `<https://github.com/acme/frontend/pull/12|frontend #12>)`,
    );
  });

  it("pr_ready → drops the prefix every repo of the run shares", () => {
    expect(
      formatTicketStatus(
        {
          kind: "pr_ready",
          prs: [
            ghPr(24, "blazity/ai-workflow-prod"),
            glPr(6, "filipmaszota3/ai-workflow-integration-test"),
          ],
          usageReport: "u",
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:white_check_mark: ${LINK} STATUS: PR ready (` +
        `<https://github.com/blazity/ai-workflow-prod/pull/24|prod #24>, ` +
        `<https://gitlab.com/filipmaszota3/ai-workflow-integration-test/-/merge_requests/6|integration-test !6>)`,
    );
  });

  it("pr_ready → keeps a shared prefix that would leave a label empty", () => {
    expect(
      formatTicketStatus(
        {
          kind: "pr_ready",
          prs: [ghPr(1, "acme/api"), ghPr(2, "acme/api-gateway")],
          usageReport: "u",
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:white_check_mark: ${LINK} STATUS: PR ready (` +
        `<https://github.com/acme/api/pull/1|api #1>, ` +
        `<https://github.com/acme/api-gateway/pull/2|api-gateway #2>)`,
    );
  });

  it("pr_ready → ellipsizes a repo label too long for the status line", () => {
    const long = `acme/${"repository-with-a-very-long-name"}`;
    const status = formatTicketStatus(
      { kind: "pr_ready", prs: [ghPr(1, long), ghPr(2, "acme/short")], usageReport: "u" },
      KEY,
      JIRA,
    );
    expect(status).toContain("|repository-with-a-very… #1>");
    expect(status).toContain("|short #2>");
  });

  it("pr_ready → an empty list degrades to the bare status, never 'PR ready ()'", () => {
    expect(
      formatTicketStatus({ kind: "pr_ready", prs: [], usageReport: "u" }, KEY, JIRA),
    ).toBe(`:white_check_mark: ${LINK} STATUS: PR ready`);
  });

  it("failed with phase → status names the phase", () => {
    expect(
      formatTicketStatus(
        { kind: "failed", phase: "research", reason: "x" },
        KEY,
        JIRA,
      ),
    ).toBe(`:warning: ${LINK} STATUS: failed (research)`);
  });

  it("failed with pre-PR checks phase → status names the phase", () => {
    expect(
      formatTicketStatus(
        { kind: "failed", phase: "pre-pr-checks", reason: "x" },
        KEY,
        JIRA,
      ),
    ).toBe(`:warning: ${LINK} STATUS: failed (pre-pr-checks)`);
  });

  it("failed without phase → bare failed", () => {
    expect(formatTicketStatus({ kind: "failed" }, KEY, JIRA)).toBe(
      `:warning: ${LINK} STATUS: failed`,
    );
  });

  it("plan_approval_requested → plan awaiting approval (no dashboard link in header)", () => {
    expect(
      formatTicketStatus(
        { kind: "plan_approval_requested", dashboardUrl: "https://app/plan/1" },
        KEY,
        JIRA,
      ),
    ).toBe(`:memo: ${LINK} STATUS: plan awaiting approval`);
  });

  it("canceled → bare canceled (no reason in header)", () => {
    expect(
      formatTicketStatus(
        { kind: "canceled", reason: "left AI column" },
        KEY,
        JIRA,
      ),
    ).toBe(`:no_entry: ${LINK} STATUS: canceled`);
  });
});

describe("identifiers that are not tracker keys", () => {
  // Webhook and scope:any PR runs carry a synthesized identifier. /browse/<it>
  // is always a 404, so it must render as plain text rather than a dead link.
  const SYNTHETIC = "webhook-d0e1f2-9a8b7c6d";

  it("renders a webhook identifier as plain text in the status line", () => {
    expect(formatTicketStatus({ kind: "started" }, SYNTHETIC, JIRA)).toBe(
      `:hourglass_flowing_sand: ${SYNTHETIC} STATUS: in progress`,
    );
  });

  it("renders a webhook identifier as plain text in the event line", () => {
    expect(formatTicketEvent({ kind: "started" }, SYNTHETIC, JIRA)).toBe(
      `:hourglass_flowing_sand: Task ${SYNTHETIC} started`,
    );
  });

  it("renders a PR-shaped subject key as plain text", () => {
    expect(formatTicketStatus({ kind: "started" }, "pr:github:acme/api#42", JIRA)).toBe(
      ":hourglass_flowing_sand: pr:github:acme/api#42 STATUS: in progress",
    );
  });

  it("still links a real tracker key", () => {
    expect(formatTicketStatus({ kind: "started" }, KEY, JIRA)).toBe(
      `:hourglass_flowing_sand: ${LINK} STATUS: in progress`,
    );
    expect(formatTicketEvent({ kind: "started" }, "AWT2-7", JIRA)).toBe(
      `:hourglass_flowing_sand: Task <${JIRA}/browse/AWT2-7|AWT2-7> started`,
    );
  });
});

describe("formatTicketEvent", () => {
  it("started — links the ticket key", () => {
    expect(formatTicketEvent({ kind: "started" }, KEY, JIRA)).toBe(
      `:hourglass_flowing_sand: Task ${LINK} started`,
    );
  });

  it("needs_clarification — without usage report or comment link", () => {
    expect(
      formatTicketEvent({ kind: "needs_clarification" }, KEY, JIRA),
    ).toBe(`:question: Task ${LINK} needs clarification`);
  });

  it("needs_clarification: links to the dashboard when dashboardUrl is provided", () => {
    expect(
      formatTicketEvent(
        {
          kind: "needs_clarification",
          dashboardUrl: "https://app/ticket/AWT-42?run=wrun_9",
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:question: Task ${LINK} needs clarification (<https://app/ticket/AWT-42?run=wrun_9|answer in dashboard>)`,
    );
  });

  it("needs_clarification: dashboardUrl takes priority over commentUrl", () => {
    expect(
      formatTicketEvent(
        {
          kind: "needs_clarification",
          dashboardUrl: "https://app/ticket/AWT-42?run=wrun_9",
          commentUrl: `${JIRA}/browse/${KEY}?focusedCommentId=1`,
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:question: Task ${LINK} needs clarification (<https://app/ticket/AWT-42?run=wrun_9|answer in dashboard>)`,
    );
  });

  it("needs_clarification: links to the Jira comment when only commentUrl is provided", () => {
    expect(
      formatTicketEvent(
        {
          kind: "needs_clarification",
          commentUrl: `${JIRA}/browse/${KEY}?focusedCommentId=98765`,
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:question: Task ${LINK} needs clarification (<${JIRA}/browse/${KEY}?focusedCommentId=98765|view questions>)`,
    );
  });

  it("needs_clarification — appends usage report on a new line", () => {
    expect(
      formatTicketEvent(
        { kind: "needs_clarification", usageReport: "Phase A: $0.10" },
        KEY,
        JIRA,
      ),
    ).toBe(`:question: Task ${LINK} needs clarification\nPhase A: $0.10`);
  });

  it("needs_clarification: combines dashboard link and usage report", () => {
    const dashboardUrl = "https://app/ticket/AWT-42?run=wrun_9";
    expect(
      formatTicketEvent(
        { kind: "needs_clarification", dashboardUrl, usageReport: "u" },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:question: Task ${LINK} needs clarification (<${dashboardUrl}|answer in dashboard>)\nu`,
    );
  });

  it("needs_clarification: renders questions numbered in order after the head", () => {
    expect(
      formatTicketEvent(
        {
          kind: "needs_clarification",
          questions: ["Which repository?", "Which branch?"],
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:question: Task ${LINK} needs clarification\n1. Which repository?\n2. Which branch?`,
    );
  });

  it("needs_clarification: renders suggestedAnswers on a Suggested line", () => {
    expect(
      formatTicketEvent(
        {
          kind: "needs_clarification",
          questions: ["Which repository?"],
          suggestedAnswers: ["the api repo", "the web repo"],
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:question: Task ${LINK} needs clarification\n1. Which repository?\nSuggested: the api repo · the web repo`,
    );
  });

  it("needs_clarification: defangs a broadcast token inside a question", () => {
    const text = formatTicketEvent(
      {
        kind: "needs_clarification",
        questions: ["Ping <!channel> which repo?"],
      },
      KEY,
      JIRA,
    );
    expect(text).not.toContain("<!channel>");
    expect(text).toContain(`1. Ping <${ZWSP}!channel> which repo?`);
  });

  it("needs_clarification — empty usage report is treated as absent", () => {
    expect(
      formatTicketEvent(
        { kind: "needs_clarification", usageReport: "" },
        KEY,
        JIRA,
      ),
    ).toBe(`:question: Task ${LINK} needs clarification`);
  });

  it("pr_ready: includes PR link inline and usage report", () => {
    const text = formatTicketEvent(
      { kind: "pr_ready", prs: [ghPr(123)], usageReport: "Total: $0.42" },
      KEY,
      JIRA,
    );
    expect(text).toBe(
      `:white_check_mark: Task ${LINK} PR ready for review: <https://github.com/o/r/pull/123|#123>\nTotal: $0.42`,
    );
  });

  it("pr_ready: multi-repo lists each PR/MR under provider and repo path", () => {
    const text = formatTicketEvent(
      {
        kind: "pr_ready",
        prs: [ghPr(12, "acme/backend"), glPr(3, "acme/ops/infra")],
        usageReport: "Total: $0.42",
      },
      KEY,
      JIRA,
    );
    expect(text).toBe(
      [
        `:white_check_mark: Task ${LINK} PR/MR ready for review (2):`,
        "• github:acme/backend: <https://github.com/acme/backend/pull/12|#12>",
        "• gitlab:acme/ops/infra: <https://gitlab.com/acme/ops/infra/-/merge_requests/3|!3>",
        "Total: $0.42",
      ].join("\n"),
    );
  });

  it("pr_ready: an empty list drops the link instead of announcing '(0):'", () => {
    const text = formatTicketEvent(
      { kind: "pr_ready", prs: [], usageReport: "Total: $0.42" },
      KEY,
      JIRA,
    );
    expect(text).toBe(
      `:white_check_mark: Task ${LINK} PR ready for review\nTotal: $0.42`,
    );
  });

  it("pr_ready: appends extraText after the usage report", () => {
    const text = formatTicketEvent(
      {
        kind: "pr_ready",
        prs: [ghPr(5)],
        usageReport: "Total: $0.10",
        extraText: "Deployed to staging",
      },
      KEY,
      JIRA,
    );
    expect(text).toBe(
      `:white_check_mark: Task ${LINK} PR ready for review: <https://github.com/o/r/pull/5|#5>\nTotal: $0.10\nDeployed to staging`,
    );
  });

  it("failed with phase and reason", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", phase: "research", reason: "phase timed out" },
        KEY,
        JIRA,
      ),
    ).toBe(`:warning: Task ${LINK} failed: research — phase timed out`);
  });

  it("failed with reason but no phase", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", reason: "boom" },
        KEY,
        JIRA,
      ),
    ).toBe(`:warning: Task ${LINK} failed: boom`);
  });

  it("failed with neither phase nor reason", () => {
    expect(
      formatTicketEvent({ kind: "failed" }, KEY, JIRA),
    ).toBe(`:warning: Task ${LINK} failed`);
  });

  it("failed — appends usage report when present", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", phase: "impl", reason: "x", usageReport: "u" },
        KEY,
        JIRA,
      ),
    ).toBe(`:warning: Task ${LINK} failed: impl — x\nu`);
  });

  it("plan_approval_requested: links to the dashboard when dashboardUrl is provided", () => {
    expect(
      formatTicketEvent(
        { kind: "plan_approval_requested", dashboardUrl: "https://app/plan/1" },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:memo: Task ${LINK} plan awaiting approval (<https://app/plan/1|review plan>)`,
    );
  });

  it("plan_approval_requested: without a dashboard link", () => {
    expect(
      formatTicketEvent({ kind: "plan_approval_requested" }, KEY, JIRA),
    ).toBe(`:memo: Task ${LINK} plan awaiting approval`);
  });

  it("canceled — includes reason", () => {
    expect(
      formatTicketEvent(
        { kind: "canceled", reason: "left AI column" },
        KEY,
        JIRA,
      ),
    ).toBe(`:no_entry: Task ${LINK} canceled: left AI column`);
  });

  it("trims a trailing slash on jiraBaseUrl", () => {
    expect(
      formatTicketEvent({ kind: "started" }, KEY, `${JIRA}/`),
    ).toBe(`:hourglass_flowing_sand: Task ${LINK} started`);
  });

  it("pr_ready: defangs a broadcast token in extraText but keeps our own links", () => {
    const text = formatTicketEvent(
      {
        kind: "pr_ready",
        prs: [ghPr(7)],
        usageReport: "Total: $0.10",
        extraText: "Ship it <!channel>",
      },
      KEY,
      JIRA,
    );
    // Our system-built PR link is untouched; the ticket-derived broadcast token
    // is neutralized so it renders as literal text instead of pinging everyone.
    expect(text).toContain("<https://github.com/o/r/pull/7|#7>");
    expect(text).not.toContain("<!channel>");
    expect(text).toContain(`Ship it <${ZWSP}!channel>`);
  });

  it("note: returns just the message with no system head, defanging broadcasts", () => {
    expect(
      formatTicketEvent({ kind: "note", text: "Deploy done for AWT-42" }, KEY, JIRA),
    ).toBe("Deploy done for AWT-42");
    // No "Task <link>" head or emoji is prefixed to a standalone message.
    expect(
      formatTicketEvent({ kind: "note", text: "Ship it <!channel>" }, KEY, JIRA),
    ).toBe(`Ship it <${ZWSP}!channel>`);
  });
});

describe("neutralizeSlackBroadcasts", () => {
  it("defangs each broadcast token so it renders as literal text", () => {
    expect(neutralizeSlackBroadcasts("<!channel>")).toBe(`<${ZWSP}!channel>`);
    expect(neutralizeSlackBroadcasts("<!here>")).toBe(`<${ZWSP}!here>`);
    expect(neutralizeSlackBroadcasts("<!everyone>")).toBe(`<${ZWSP}!everyone>`);
    expect(neutralizeSlackBroadcasts("<!subteam^S123|@team>")).toBe(
      `<${ZWSP}!subteam^S123|@team>`,
    );
  });

  it("defangs multiple tokens embedded in a sentence", () => {
    expect(
      neutralizeSlackBroadcasts("hey <!here> and <!channel> now"),
    ).toBe(`hey <${ZWSP}!here> and <${ZWSP}!channel> now`);
    // None of the original ping tokens survive verbatim.
    for (const token of ["<!here>", "<!channel>"]) {
      expect(neutralizeSlackBroadcasts("hey <!here> and <!channel> now")).not.toContain(token);
    }
  });

  it("leaves plain text, user mentions, and link labels untouched", () => {
    for (const text of [
      "just a normal message",
      "ping <@U12345> please",
      "see <https://example.com|the docs>",
      "channel and here without brackets",
      "<#C0001|general> heads up",
    ]) {
      expect(neutralizeSlackBroadcasts(text)).toBe(text);
    }
  });
});
