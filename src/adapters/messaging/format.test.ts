import { describe, it, expect } from "vitest";
import { formatTicketEvent } from "./format.js";

const JIRA = "https://example.atlassian.net";
const KEY = "AWT-42";
const LINK = `<${JIRA}/browse/${KEY}|${KEY}>`;

describe("formatTicketEvent", () => {
  it("started — links the ticket key", () => {
    expect(formatTicketEvent({ kind: "started" }, KEY, JIRA)).toBe(
      `Task ${LINK} started`,
    );
  });

  it("needs_clarification — without usage report", () => {
    expect(
      formatTicketEvent({ kind: "needs_clarification" }, KEY, JIRA),
    ).toBe(`Task ${LINK} needs clarification`);
  });

  it("needs_clarification — appends usage report on a new line", () => {
    expect(
      formatTicketEvent(
        { kind: "needs_clarification", usageReport: "Phase A: $0.10" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} needs clarification\nPhase A: $0.10`);
  });

  it("needs_clarification — empty usage report is treated as absent", () => {
    expect(
      formatTicketEvent(
        { kind: "needs_clarification", usageReport: "" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} needs clarification`);
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
      `Task ${LINK} PR ready for review — <https://github.com/o/r/pull/123|#123>\nTotal: $0.42`,
    );
  });

  it("failed with phase and reason", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", phase: "research", reason: "phase timed out" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} failed: research — phase timed out`);
  });

  it("failed with reason but no phase", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", reason: "boom" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} failed: boom`);
  });

  it("failed with neither phase nor reason", () => {
    expect(
      formatTicketEvent({ kind: "failed" }, KEY, JIRA),
    ).toBe(`Task ${LINK} failed`);
  });

  it("failed — appends usage report when present", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", phase: "impl", reason: "x", usageReport: "u" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} failed: impl — x\nu`);
  });

  it("canceled — includes reason", () => {
    expect(
      formatTicketEvent(
        { kind: "canceled", reason: "left AI column" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} canceled: left AI column`);
  });

  it("trims a trailing slash on jiraBaseUrl", () => {
    expect(
      formatTicketEvent({ kind: "started" }, KEY, `${JIRA}/`),
    ).toBe(`Task ${LINK} started`);
  });
});
