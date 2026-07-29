import { describe, expect, it } from "vitest";
import { utf8Bytes } from "./content.js";
import {
  MAX_ROUTING_LABEL_CHARS,
  MAX_ROUTING_TICKETS,
  MIN_ROUTING_CONFIRMATIONS,
  REPO_ROUTING_DOC_PATH,
  type RepoRoutingEntry,
  isRepoRoutingEntryEligible,
  mergeRepoRoutingEntries,
  normalizeRoutingLabel,
  normalizeRoutingTickets,
  parseRepoRoutingDocument,
  renderRepoRoutingDocument,
  repoRoutingLabelKey,
  repoRoutingMatches,
} from "./repo-routing.js";

const OWNER = "acme";

function entry(
  label: string,
  repoPath: string,
  tickets: string[] = [],
  provider: RepoRoutingEntry["provider"] = "github",
): RepoRoutingEntry {
  return { label, provider, repoPath, tickets };
}

function merge(
  existing: readonly RepoRoutingEntry[],
  candidates: readonly RepoRoutingEntry[],
  options: { maxEntries?: number; maxBytes?: number; owner?: string } = {},
) {
  return mergeRepoRoutingEntries({
    existing,
    candidates,
    maxEntries: options.maxEntries ?? 50,
    maxBytes: options.maxBytes ?? 12 * 1024,
    owner: options.owner ?? OWNER,
  });
}

describe("repo routing document format", () => {
  it("is stored under a doc path nothing injects into a prompt", () => {
    // The prompt read path iterates REPO_MEMORY_DOC_PATHS, which is
    // ["facts", "lessons"], so a routing document can never reach an agent.
    expect(REPO_ROUTING_DOC_PATH).toBe("routing");
  });

  it("round-trips an entry", () => {
    const entries = [entry("billing", "acme/api"), entry("Storefront", "acme/web")];
    expect(parseRepoRoutingDocument(renderRepoRoutingDocument({ owner: OWNER, entries }))).toEqual(
      entries,
    );
  });

  it("renders an empty document without a bullet section", () => {
    const rendered = renderRepoRoutingDocument({ owner: OWNER, entries: [] });
    expect(rendered).toBe("# Repo routing: acme\n<!-- blazebot:repo-routing v1 -->\n");
    expect(parseRepoRoutingDocument(rendered)).toEqual([]);
  });

  it("round-trips a label that itself contains the separator", () => {
    // Parse splits on the LAST separator, so the label keeps its own.
    const entries = [entry("area -> billing", "acme/api")];
    expect(parseRepoRoutingDocument(renderRepoRoutingDocument({ owner: OWNER, entries }))).toEqual(
      entries,
    );
  });

  it("keeps a label that carries a newline on one line", () => {
    const rendered = renderRepoRoutingDocument({
      owner: OWNER,
      entries: [entry("billing\nacme/web -> github:acme/web", "acme/api")],
    });
    expect(rendered.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
    // The forged tail lands on the label side of the last separator, so it can
    // never be read as the repository.
    expect(parseRepoRoutingDocument(rendered)).toEqual([
      entry("billing acme/web -> github:acme/web", "acme/api"),
    ]);
  });

  it("caps a label at the length limit", () => {
    const long = "x".repeat(MAX_ROUTING_LABEL_CHARS + 40);
    expect(normalizeRoutingLabel(long)).toHaveLength(MAX_ROUTING_LABEL_CHARS);
    expect(parseRepoRoutingDocument(renderRepoRoutingDocument({ owner: OWNER, entries: [entry(long, "acme/api")] }))).toEqual([
      entry("x".repeat(MAX_ROUTING_LABEL_CHARS), "acme/api"),
    ]);
  });

  it("collapses whitespace and matches labels case insensitively", () => {
    expect(normalizeRoutingLabel("  Area:  Billing \t")).toBe("Area: Billing");
    expect(repoRoutingLabelKey(" AREA: billing ")).toBe(repoRoutingLabelKey("Area:  Billing"));
  });

  it.each([
    ["a line that is not a bullet", "billing -> github:acme/api"],
    ["no separator", "- billing github:acme/api"],
    ["no label", "-  -> github:acme/api"],
    ["an unknown provider", "- billing -> bitbucket:acme/api"],
    ["a path with no owner", "- billing -> github:api"],
    ["a traversal segment", "- billing -> github:acme/../api"],
    ["an empty segment", "- billing -> github:acme//api"],
    ["a path with a space", "- billing -> github:acme/api extra"],
  ])("skips %s rather than repairing it", (_case, line) => {
    expect(parseRepoRoutingDocument(`# head\n\n${line}\n`)).toEqual([]);
  });

  it("reads a document stored with CRLF endings", () => {
    expect(parseRepoRoutingDocument("# head\r\n\r\n- billing -> github:acme/api\r\n")).toEqual([
      entry("billing", "acme/api"),
    ]);
  });
});

describe("mergeRepoRoutingEntries", () => {
  it("appends a new answer after the stored ones", () => {
    const merged = merge([entry("billing", "acme/api")], [entry("storefront", "acme/web")]);
    expect(merged.entries).toEqual([entry("billing", "acme/api"), entry("storefront", "acme/web")]);
    expect(merged.dropped).toBe(0);
  });

  it("replaces the stored answer for a label and moves it to the back", () => {
    // A human answering the same label with a different repository is correcting
    // the earlier answer, so the newest one wins outright.
    const merged = merge(
      [entry("billing", "acme/api"), entry("storefront", "acme/web")],
      [entry("billing", "acme/payments")],
    );
    expect(merged.entries).toEqual([
      entry("storefront", "acme/web"),
      entry("billing", "acme/payments"),
    ]);
  });

  it("replaces on the comparison key, not the stored spelling", () => {
    const merged = merge([entry("Area: Billing", "acme/api")], [entry("area:  billing", "acme/web")]);
    expect(merged.entries).toEqual([entry("area: billing", "acme/web")]);
  });

  it("is a no-op when the same answer is merged twice", () => {
    const first = merge([], [entry("billing", "acme/api")]);
    const second = merge(first.entries, [entry("billing", "acme/api")]);
    expect(second.entries).toEqual(first.entries);
    expect(second.dropped).toBe(0);
  });

  it("keeps the first candidate when one run offers a label twice", () => {
    const merged = merge([], [entry("billing", "acme/api"), entry("billing", "acme/web")]);
    expect(merged.entries).toEqual([entry("billing", "acme/api")]);
  });

  it("evicts the oldest entries when the entry cap is exceeded", () => {
    const existing = [
      entry("one", "acme/one"),
      entry("two", "acme/two"),
      entry("three", "acme/three"),
    ];
    const merged = merge(existing, [entry("four", "acme/four")], { maxEntries: 2 });
    expect(merged.entries).toEqual([entry("three", "acme/three"), entry("four", "acme/four")]);
    expect(merged.dropped).toBe(2);
  });

  it("evicts whole entries until the byte cap is met", () => {
    const existing = [entry("one", "acme/one"), entry("two", "acme/two")];
    const budget = utf8Bytes(
      renderRepoRoutingDocument({ owner: OWNER, entries: [entry("three", "acme/three")] }),
    );
    const merged = merge(existing, [entry("three", "acme/three")], { maxBytes: budget });
    expect(merged.entries).toEqual([entry("three", "acme/three")]);
    expect(merged.dropped).toBe(2);
    expect(
      utf8Bytes(renderRepoRoutingDocument({ owner: OWNER, entries: merged.entries })),
    ).toBeLessThanOrEqual(budget);
  });

  it("drops a stored entry the parser could not have produced", () => {
    // A hand-edited or older-format document must not be re-rendered into
    // something this parser would read differently.
    const merged = merge(
      [entry("billing", "api"), entry("storefront", "acme/web")],
      [],
    );
    expect(merged.entries).toEqual([entry("storefront", "acme/web")]);
  });

  it("drops a candidate whose repository path is not routable", () => {
    expect(merge([], [entry("billing", "api")]).entries).toEqual([]);
    expect(merge([], [entry("billing", "acme/../api")]).entries).toEqual([]);
  });

  it("drops a candidate whose label normalizes to nothing", () => {
    expect(merge([], [entry("   ", "acme/api")]).entries).toEqual([]);
  });

  it("deduplicates a stored label that appears twice", () => {
    const merged = merge([entry("billing", "acme/api"), entry("billing", "acme/web")], []);
    expect(merged.entries).toEqual([entry("billing", "acme/api")]);
  });
});

describe("repoRoutingMatches", () => {
  const entries = [
    entry("billing", "acme/api"),
    entry("storefront", "acme/web"),
    entry("Docs", "acme/docs"),
  ];

  it("matches a label case insensitively and ignores the rest", () => {
    expect(repoRoutingMatches(entries, ["BILLING"])).toEqual([entry("billing", "acme/api")]);
  });

  it("returns nothing for a ticket with no labels", () => {
    expect(repoRoutingMatches(entries, [])).toEqual([]);
    expect(repoRoutingMatches(entries, ["   "])).toEqual([]);
  });

  it("returns both entries when two labels disagree, so the caller can refuse", () => {
    expect(repoRoutingMatches(entries, ["billing", "storefront"])).toEqual([
      entry("billing", "acme/api"),
      entry("storefront", "acme/web"),
    ]);
  });

  it("collapses the same answer stored in two documents", () => {
    expect(
      repoRoutingMatches([entry("billing", "acme/api"), entry("Billing", "acme/API")], ["billing"]),
    ).toEqual([entry("billing", "acme/api")]);
  });

  it("keeps one label pointing at two repositories as two matches", () => {
    expect(
      repoRoutingMatches([entry("billing", "acme/api"), entry("billing", "acme/web")], ["billing"]),
    ).toEqual([entry("billing", "acme/api"), entry("billing", "acme/web")]);
  });
});

describe("corroboration", () => {
  it("records the corroborating tickets on the line and reads them back", () => {
    const entries = [entry("billing", "acme/api", ["AIW-1", "AIW-7"])];
    const rendered = renderRepoRoutingDocument({ owner: OWNER, entries });
    expect(rendered).toContain("- billing -> github:acme/api (tickets: AIW-1, AIW-7)");
    expect(parseRepoRoutingDocument(rendered)).toEqual(entries);
  });

  it("omits the suffix entirely for an entry with no tickets", () => {
    const rendered = renderRepoRoutingDocument({
      owner: OWNER,
      entries: [entry("billing", "acme/api")],
    });
    expect(rendered).toContain("- billing -> github:acme/api\n");
    expect(rendered).not.toContain("tickets:");
  });

  it("needs MIN_ROUTING_CONFIRMATIONS distinct tickets to be eligible", () => {
    expect(MIN_ROUTING_CONFIRMATIONS).toBe(2);
    expect(isRepoRoutingEntryEligible(entry("billing", "acme/api"))).toBe(false);
    expect(isRepoRoutingEntryEligible(entry("billing", "acme/api", ["AIW-1"]))).toBe(false);
    expect(isRepoRoutingEntryEligible(entry("billing", "acme/api", ["AIW-1", "AIW-7"]))).toBe(true);
  });

  it("treats an entry stored before corroboration existed as uncorroborated", () => {
    // Nothing has ever run with the flag on, and requiring the answer again is the
    // safe direction for anything that somehow did.
    const [legacy] = parseRepoRoutingDocument("# head\n\n- billing -> github:acme/api\n");
    expect(legacy?.tickets).toEqual([]);
    expect(isRepoRoutingEntryEligible(legacy!)).toBe(false);
  });

  it("a second distinct ticket agreeing lifts the entry to eligible", () => {
    const first = merge([], [entry("billing", "acme/api", ["AIW-1"])]);
    expect(isRepoRoutingEntryEligible(first.entries[0]!)).toBe(false);

    const second = merge(first.entries, [entry("billing", "acme/api", ["AIW-7"])]);
    expect(second.entries).toEqual([entry("billing", "acme/api", ["AIW-1", "AIW-7"])]);
    expect(isRepoRoutingEntryEligible(second.entries[0]!)).toBe(true);
  });

  it("does not let the same ticket corroborate itself", () => {
    // Two clarification rounds on one ticket, or one run replayed, is still one
    // ticket's testimony.
    const first = merge([], [entry("billing", "acme/api", ["AIW-1"])]);
    const second = merge(first.entries, [entry("billing", "acme/api", ["AIW-1"])]);
    expect(second.entries).toEqual([entry("billing", "acme/api", ["AIW-1"])]);
    expect(isRepoRoutingEntryEligible(second.entries[0]!)).toBe(false);
  });

  it("matches ticket identifiers case insensitively", () => {
    const first = merge([], [entry("billing", "acme/api", ["aiw-1"])]);
    const second = merge(first.entries, [entry("billing", "acme/api", ["AIW-1"])]);
    expect(second.entries).toEqual([entry("billing", "acme/api", ["AIW-1"])]);
  });

  it("resets corroboration when a human corrects the target", () => {
    // The stored pair is contradicted, so keeping its corroboration would let a
    // superseded answer keep selecting.
    const stored = [entry("billing", "acme/api", ["AIW-1", "AIW-7"])];
    const merged = merge(stored, [entry("billing", "acme/payments", ["AIW-9"])]);
    expect(merged.entries).toEqual([entry("billing", "acme/payments", ["AIW-9"])]);
    expect(isRepoRoutingEntryEligible(merged.entries[0]!)).toBe(false);
  });

  it("confirms across a case difference in the repository path", () => {
    const merged = merge(
      [entry("billing", "acme/API", ["AIW-1"])],
      [entry("billing", "acme/api", ["AIW-7"])],
    );
    // Same repository, so it corroborates rather than replacing, and the stored
    // spelling is what survives.
    expect(merged.entries).toEqual([entry("billing", "acme/API", ["AIW-1", "AIW-7"])]);
  });

  it("keeps the newest tickets once the cap is reached", () => {
    expect(MAX_ROUTING_TICKETS).toBe(2);
    expect(normalizeRoutingTickets(["AIW-1", "AIW-2", "AIW-3"])).toEqual(["AIW-2", "AIW-3"]);
    const merged = merge(
      [entry("billing", "acme/api", ["AIW-1", "AIW-2"])],
      [entry("billing", "acme/api", ["AIW-3"])],
    );
    expect(merged.entries).toEqual([entry("billing", "acme/api", ["AIW-2", "AIW-3"])]);
  });

  it.each([
    ["a space", "AIW 1"],
    ["a closing parenthesis", "AIW-1)"],
    ["a comma", "AIW,1"],
    ["nothing at all", "   "],
    ["more than 32 characters", "A".repeat(33)],
  ])("drops a ticket identifier carrying %s", (_case, ticket) => {
    expect(normalizeRoutingTickets([ticket])).toEqual([]);
  });

  it.each([
    ["a mangled suffix", "- billing -> github:acme/api (tickets AIW-1)"],
    ["a suffix with no closing parenthesis", "- billing -> github:acme/api (tickets: AIW-1"],
  ])("drops the whole entry rather than half-reading %s", (_case, line) => {
    // The repository half is what the anchored pattern sees once the suffix comes
    // off, so a suffix that does not match leaves a tail that is not a repository.
    expect(parseRepoRoutingDocument(`# head\n\n${line}\n`)).toEqual([]);
  });

  it("drops an unreadable ticket out of an otherwise valid line", () => {
    expect(
      parseRepoRoutingDocument("# head\n\n- billing -> github:acme/api (tickets: AIW-1, A A)\n"),
    ).toEqual([entry("billing", "acme/api", ["AIW-1"])]);
  });
});
