/**
 * How core links a ticket beside a run: with the tracker's own answer, or the
 * one the run recorded, and never with a URL it spelled itself.
 */
import { describe, expect, it, vi } from "vitest";
import { NO_TICKET_LINKS, ticketLinkFor, ticketLinksOf } from "./ticket-url.js";

/** A tracker whose pages are nothing like Jira's. */
const tracker = {
  ticketUrl: (key: string) => (key.startsWith("AWT-") ? `https://tracker.example/t/${key}` : null),
};

describe("the tracker's links", () => {
  it("are the tracker's own answer, for its tickets and nothing else", () => {
    const links = ticketLinksOf(tracker);

    expect(links("AWT-42")).toBe("https://tracker.example/t/AWT-42");
    expect(links("pr:acme/api#128")).toBeNull();
  });

  it("are none from no tracker, and from a tracker that gives none", () => {
    expect(ticketLinksOf(null)("AWT-42")).toBeNull();
    expect(ticketLinksOf({})("AWT-42")).toBeNull();
    expect(NO_TICKET_LINKS("AWT-42")).toBeNull();
  });

  it("are none, rather than a broken page, when the tracker throws, and the throw is reported", () => {
    const throwing = {
      ticketUrl: () => {
        throw new Error("the integration's own bug");
      },
    };
    const reported = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(ticketLinksOf(throwing)("AWT-42")).toBeNull();
    expect(reported).toHaveBeenCalledWith(
      "ticket_link_failed",
      expect.objectContaining({ ticketKey: "AWT-42", error: "the integration's own bug" }),
    );
    reported.mockRestore();
  });

  it("are none when the tracker answers something that is not a link", () => {
    // Integration code is typed at compile time only; a page must never render
    // an object, a number or an empty string as an href.
    const odd = { ticketUrl: () => ({ href: "https://tracker.example/t/1" }) as never };
    expect(ticketLinksOf(odd)("AWT-42")).toBeNull();
    expect(ticketLinksOf({ ticketUrl: () => "" })("AWT-42")).toBeNull();
  });
});

describe("the link a run is shown with", () => {
  it("keeps the link the run recorded when the tracker now links another site", () => {
    // Reconnected to another site since, or another tracker: the run's ticket
    // lives where it was read.
    expect(
      ticketLinkFor("https://acme.atlassian.net/browse/AWT-7", "AWT-7", ticketLinksOf(tracker)),
    ).toBe("https://acme.atlassian.net/browse/AWT-7");
  });

  it("repairs a recorded link when the tracker links the same site differently", () => {
    // Core once spelled `<Site URL>/browse/KEY`, and a Site URL saved with a
    // path recorded a page that does not exist. The same site's tracker knows
    // the page.
    const jira = { ticketUrl: (key: string) => `https://acme.atlassian.net/browse/${key}` };
    expect(
      ticketLinkFor("https://acme.atlassian.net/jira/browse/AWT-7", "AWT-7", ticketLinksOf(jira)),
    ).toBe("https://acme.atlassian.net/browse/AWT-7");
  });

  it("keeps the recorded link when no tracker answers any more", () => {
    expect(
      ticketLinkFor("https://acme.atlassian.net/jira/browse/AWT-7", "AWT-7", NO_TICKET_LINKS),
    ).toBe("https://acme.atlassian.net/jira/browse/AWT-7");
  });

  it("asks the tracker in force for a run that recorded none", () => {
    expect(ticketLinkFor(null, "AWT-7", ticketLinksOf(tracker))).toBe(
      "https://tracker.example/t/AWT-7",
    );
    expect(ticketLinkFor(undefined, null, ticketLinksOf(tracker))).toBeNull();
    expect(ticketLinkFor(null, "AWT-7", NO_TICKET_LINKS)).toBeNull();
  });
});
