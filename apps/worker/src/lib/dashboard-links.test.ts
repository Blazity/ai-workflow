import { describe, it, expect } from "vitest";
import { ticketRunUrl, ticketPageUrl, hasDashboardLinkComment } from "./dashboard-links.js";

const ORIGIN = "https://dashboard.example.com";

describe("ticketRunUrl", () => {
  it("builds a ticket view URL with the run preselected", () => {
    expect(ticketRunUrl(ORIGIN, "AWT-42", "wrun_9")).toBe(
      "https://dashboard.example.com/ticket/AWT-42?run=wrun_9",
    );
  });

  it("strips trailing slashes on the origin", () => {
    expect(ticketRunUrl(`${ORIGIN}///`, "AWT-42", "wrun_9")).toBe(
      "https://dashboard.example.com/ticket/AWT-42?run=wrun_9",
    );
  });

  it("encodes the ticket key and run id", () => {
    expect(ticketRunUrl(ORIGIN, "A B/C", "run 1")).toBe(
      "https://dashboard.example.com/ticket/A%20B%2FC?run=run%201",
    );
  });
});

describe("ticketPageUrl", () => {
  it("builds a ticket view URL without a run param", () => {
    expect(ticketPageUrl(ORIGIN, "AWT-42")).toBe(
      "https://dashboard.example.com/ticket/AWT-42",
    );
  });

  it("strips trailing slashes on the origin", () => {
    expect(ticketPageUrl(`${ORIGIN}/`, "AWT-42")).toBe(
      "https://dashboard.example.com/ticket/AWT-42",
    );
  });

  it("encodes the ticket key", () => {
    expect(ticketPageUrl(ORIGIN, "A B/C")).toBe(
      "https://dashboard.example.com/ticket/A%20B%2FC",
    );
  });
});

describe("hasDashboardLinkComment", () => {
  it("detects the deep-link marker in a comment body", () => {
    const comments = [
      { body: "unrelated" },
      { body: `Follow progress here: ${ticketPageUrl(ORIGIN, "AWT-42")}` },
    ];
    expect(hasDashboardLinkComment(comments, "AWT-42")).toBe(true);
  });

  it("returns false when no comment links to the ticket", () => {
    expect(
      hasDashboardLinkComment([{ body: "nothing here" }, { body: "still nothing" }], "AWT-42"),
    ).toBe(false);
  });

  it("returns false for an empty comment list", () => {
    expect(hasDashboardLinkComment([], "AWT-42")).toBe(false);
  });

  it("does not match a different ticket's link", () => {
    const comments = [{ body: `see ${ticketPageUrl(ORIGIN, "AWT-99")}` }];
    expect(hasDashboardLinkComment(comments, "AWT-42")).toBe(false);
  });

  it("does not match a key that is a prefix of another ticket's link", () => {
    const comments = [{ body: `see ${ticketPageUrl(ORIGIN, "AWT-42")}` }];
    expect(hasDashboardLinkComment(comments, "AWT-4")).toBe(false);
  });

  it("matches when the link carries a run query param", () => {
    const comments = [{ body: `see ${ticketRunUrl(ORIGIN, "AWT-42", "wrun_9")}` }];
    expect(hasDashboardLinkComment(comments, "AWT-42")).toBe(true);
  });
});
