import { describe, it, expect } from "vitest";
import { formatRunList, formatRunStatus } from "./format.js";

const JIRA_BASE_URL = "https://example.atlassian.net";

describe("formatRunList", () => {
  it("returns empty-state copy when there are no rows", () => {
    expect(formatRunList([], JIRA_BASE_URL)).toBe("No active workflows.");
  });

  it("renders one bullet per ticket with a Jira link and runId", () => {
    const out = formatRunList(
      [
        { ticketKey: "AWT-1", runId: "run_a" },
        { ticketKey: "AWT-2", runId: "run_b" },
      ],
      JIRA_BASE_URL,
    );
    expect(out).toContain(
      "• <https://example.atlassian.net/browse/AWT-1|AWT-1> — runId: `run_a`",
    );
    expect(out).toContain(
      "• <https://example.atlassian.net/browse/AWT-2|AWT-2> — runId: `run_b`",
    );
  });

  it("strips a trailing slash on the Jira base URL", () => {
    const out = formatRunList(
      [{ ticketKey: "AWT-1", runId: "run_a" }],
      "https://example.atlassian.net/",
    );
    expect(out).toContain("https://example.atlassian.net/browse/AWT-1|AWT-1");
    expect(out).not.toContain(".net//browse");
  });
});

describe("formatRunStatus", () => {
  it("renders untracked when runId is null", () => {
    expect(
      formatRunStatus("AWT-1", { runId: null, sandboxId: null }, JIRA_BASE_URL),
    ).toBe("<https://example.atlassian.net/browse/AWT-1|AWT-1>: not tracked.");
  });

  it("renders runId and sandbox presence", () => {
    expect(
      formatRunStatus(
        "AWT-1",
        { runId: "run_a", sandboxId: "sbx_x" },
        JIRA_BASE_URL,
      ),
    ).toBe(
      "<https://example.atlassian.net/browse/AWT-1|AWT-1>: runId `run_a`, sandbox: yes",
    );
  });

  it("renders sandbox: no when sandboxId is null", () => {
    expect(
      formatRunStatus(
        "AWT-1",
        { runId: "run_a", sandboxId: null },
        JIRA_BASE_URL,
      ),
    ).toBe(
      "<https://example.atlassian.net/browse/AWT-1|AWT-1>: runId `run_a`, sandbox: no",
    );
  });
});
