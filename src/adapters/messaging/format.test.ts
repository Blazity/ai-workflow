import { describe, it, expect } from "vitest";
import { formatTicketEvent } from "./format.js";

const JIRA = "https://example.atlassian.net";
const KEY = "AWT-42";
const LINK = `<${JIRA}/browse/${KEY}|${KEY}>`;

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

  it("needs_clarification — links to the Jira comment when commentUrl is provided", () => {
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
      `:question: Task ${LINK} needs clarification — <${JIRA}/browse/${KEY}?focusedCommentId=98765|view questions>`,
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

  it("needs_clarification — combines comment link and usage report", () => {
    const commentUrl = `${JIRA}/browse/${KEY}?focusedCommentId=1`;
    expect(
      formatTicketEvent(
        { kind: "needs_clarification", commentUrl, usageReport: "u" },
        KEY,
        JIRA,
      ),
    ).toBe(
      `:question: Task ${LINK} needs clarification — <${commentUrl}|view questions>\nu`,
    );
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
});
