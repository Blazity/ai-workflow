import { describe, it, expect } from "vitest";
import { formatTicketEvent, formatTicketStatus, neutralizeSlackBroadcasts } from "./format.js";

const ZWSP = "\u200b";

const JIRA = "https://example.atlassian.net";
const KEY = "AWT-42";
const LINK = `<${JIRA}/browse/${KEY}|${KEY}>`;

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
        {
          kind: "pr_ready",
          pr: { url: "https://github.com/o/r/pull/9", number: 9 },
          usageReport: "u",
        },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:white_check_mark: ${LINK} STATUS: PR ready (<https://github.com/o/r/pull/9|#9>)`,
    );
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

  it("pr_ready — includes PR link inline and usage report", () => {
    const text = formatTicketEvent(
      {
        kind: "pr_ready",
        pr: { url: "https://github.com/o/r/pull/123", number: 123 },
        usageReport: "Total: $0.42",
      },
      KEY,
      JIRA,
    );
    expect(text).toBe(
      `:white_check_mark: Task ${LINK} PR ready for review — <https://github.com/o/r/pull/123|#123>\nTotal: $0.42`,
    );
  });

  it("pr_ready: appends extraText after the usage report", () => {
    const text = formatTicketEvent(
      {
        kind: "pr_ready",
        pr: { url: "https://github.com/o/r/pull/5", number: 5 },
        usageReport: "Total: $0.10",
        extraText: "Deployed to staging",
      },
      KEY,
      JIRA,
    );
    expect(text).toBe(
      `:white_check_mark: Task ${LINK} PR ready for review — <https://github.com/o/r/pull/5|#5>\nTotal: $0.10\nDeployed to staging`,
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
        pr: { url: "https://github.com/o/r/pull/7", number: 7 },
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
