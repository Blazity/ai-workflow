/**
 * CHARACTERIZATION: how the built-in store's facts and lessons format behaves
 * today, written down before the memory module moves it (stage 4) and before
 * 6b changes what "the same entry" means.
 *
 * Every expected value here is spelled out by hand from the format as it is
 * stored in production, never computed with the functions under test, so a
 * move that changes a byte turns a test red. A test named "changes in <stage>"
 * describes behaviour the plan will change on purpose; rewrite it in that
 * stage, never quietly.
 */
import { describe, expect, it } from "vitest";
import {
  mergeRepoMemoryItems,
  parseRepoMemoryDocument,
  renderRepoMemoryDocument,
  repoMemoryComparisonKey,
  stripRepoMemoryProvenance,
  type RepoMemoryItem,
} from "./repo-memory.js";

const HEAD = "# Repo facts: acme/api\n<!-- blazebot:repo-memory v1 -->\n";

function merge(
  existing: RepoMemoryItem[],
  candidates: string[],
  contradicted: string[],
  limits: { maxItems?: number; maxBytes?: number } = {},
) {
  return mergeRepoMemoryItems({
    existing,
    candidates,
    contradicted,
    runId: "run_2",
    maxItems: limits.maxItems ?? 40,
    maxBytes: limits.maxBytes ?? 12 * 1024,
    subject: "acme/api",
    kind: "facts",
  });
}

describe("the three merge outcomes a run's observation can have", () => {
  it("a contradicted claim that matches nothing stored removes nothing and re-stamps nothing", () => {
    // Mistake that turns this red: counting an unmatched retraction as a
    // removal, or touching the provenance of items the run never mentioned.
    const existing: RepoMemoryItem[] = [
      { text: "Run tests with: pnpm test", runId: "run_0" },
      { text: "Uses Node 20", runId: "run_1" },
    ];

    const merged = merge(existing, [], ["The API is served over GraphQL"]);

    expect(merged).toStrictEqual({
      items: [
        { text: "Run tests with: pnpm test", runId: "run_0" },
        { text: "Uses Node 20", runId: "run_1" },
      ],
      dropped: 0,
      removed: 0,
    });
  });

  it("an entry the same run both asserts and contradicts is stored nowhere, and its stored twin is deleted", () => {
    // Mistake: letting the assertion win (the run re-adds what it disproved),
    // or keeping the stored copy because the candidate "confirmed" it.
    const existing: RepoMemoryItem[] = [
      { text: "Build with make", runId: "run_0" },
      { text: "Uses Node 20", runId: "run_0" },
    ];

    const merged = merge(
      existing,
      ["build with make.", "Lint with eslint"],
      ["Build with make", "lint with ESLINT"],
    );

    expect(merged).toStrictEqual({
      items: [{ text: "Uses Node 20", runId: "run_0" }],
      dropped: 0,
      removed: 1,
    });
  });

  it("a reasserted fact keeps the spelling stored first, moves to the tail and carries the confirming run", () => {
    // Mistake: rewriting the stored spelling, leaving the item where it was
    // (so cap pressure evicts what a run just confirmed), or dropping the
    // seed's pin mark when a run restates a derived fact.
    const existing: RepoMemoryItem[] = [
      { text: "Package manager is pnpm.", runId: "run_0", pinned: true },
      { text: "Uses Node 20", runId: "run_0" },
      { text: "CI runs on GitHub Actions", runId: "run_1" },
    ];

    const merged = merge(existing, ["  - uses node 20.  ", "package manager is PNPM", "Deploys with Vercel"], []);

    expect(merged).toStrictEqual({
      items: [
        { text: "CI runs on GitHub Actions", runId: "run_1" },
        { text: "Package manager is pnpm.", runId: "run_2", pinned: true },
        { text: "Uses Node 20", runId: "run_2" },
        { text: "Deploys with Vercel", runId: "run_2" },
      ],
      dropped: 0,
      removed: 0,
    });
  });
});

describe("what a merge keeps under the caps", () => {
  it("evicts the least recently confirmed unpinned item first, and counts it as dropped", () => {
    const existing: RepoMemoryItem[] = [
      { text: "Package manager is pnpm.", runId: "run_0", pinned: true },
      { text: "Old model prose", runId: "run_0" },
      { text: "Newer model prose", runId: "run_1" },
    ];

    const merged = merge(existing, ["Fresh fact"], [], { maxItems: 3 });

    expect(merged).toStrictEqual({
      items: [
        { text: "Package manager is pnpm.", runId: "run_0", pinned: true },
        { text: "Newer model prose", runId: "run_1" },
        { text: "Fresh fact", runId: "run_2" },
      ],
      dropped: 1,
      removed: 0,
    });
  });

  it("evicts pinned items from the head once nothing else is left to give up", () => {
    const existing: RepoMemoryItem[] = [
      { text: "Package manager is pnpm.", runId: "run_0", pinned: true },
      { text: "Run tests with: pnpm test", runId: "run_0", pinned: true },
    ];

    const merged = merge(existing, [], [], { maxItems: 1 });

    expect(merged.items).toStrictEqual([
      { text: "Run tests with: pnpm test", runId: "run_0", pinned: true },
    ]);
    expect(merged.dropped).toBe(1);
  });

  it("drops whole items, never a cut one, against the bytes of the rendered document", () => {
    // The document head is 56 bytes, and one 100-character bullet with its
    // provenance comment takes the render to 179, past 150: the item goes
    // whole rather than being cut to fit.
    const merged = merge([], ["x".repeat(100)], [], { maxBytes: 150 });

    expect(merged).toStrictEqual({ items: [], dropped: 1, removed: 0 });
  });

  it("splits a multi-line candidate into one item per line and strips one bullet marker", () => {
    const merged = merge([], ["- Uses pnpm\n* Uses Node 20\n\n  "], []);

    expect(merged.items).toStrictEqual([
      { text: "Uses pnpm", runId: "run_2" },
      { text: "Uses Node 20", runId: "run_2" },
    ]);
  });
});

describe("what counts as the same entry (changes in 6b: one definition replaces three)", () => {
  it("folds case, runs of whitespace, leading bullet markers and one trailing period", () => {
    expect(repoMemoryComparisonKey("  - * Run tests with:   pnpm test.  ")).toBe(
      "run tests with: pnpm test",
    );
    // One period only: an ellipsis keeps two of its three.
    expect(repoMemoryComparisonKey("Wait for it...")).toBe("wait for it..");
    // Punctuation other than a final period is significant.
    expect(repoMemoryComparisonKey("Uses pnpm!")).not.toBe(repoMemoryComparisonKey("Uses pnpm"));
  });
});

describe("v1 provenance suffix parsing", () => {
  it("reads the run id and the pin mark from the comment anchored at the end of a bullet", () => {
    const parsed = parseRepoMemoryDocument(
      `${HEAD}\n- Uses Node 20 <!-- run:run_1 -->\n- Package manager is pnpm. <!-- run:wrun_01ABC-x_9 pin -->\n- Legacy item stored before provenance\n`,
    );

    // toStrictEqual: an unmarked item has no `pinned` key at all, which every
    // `toEqual` against a parsed document in this codebase relies on.
    expect(parsed).toStrictEqual([
      { text: "Uses Node 20", runId: "run_1" },
      { text: "Package manager is pnpm.", runId: "wrun_01ABC-x_9", pinned: true },
      { text: "Legacy item stored before provenance", runId: null },
    ]);
  });

  it("keeps a comment that is not the anchored suffix as part of the text", () => {
    const parsed = parseRepoMemoryDocument(
      [
        "- See <!-- run:run_1 --> in the middle",
        "- Id with a dot <!-- run:run.1 -->",
        "- No space before it<!-- run:run_1 -->",
        "- Unknown mark <!-- run:run_1 keep -->",
      ].join("\n"),
    );

    expect(parsed).toStrictEqual([
      { text: "See <!-- run:run_1 --> in the middle", runId: null },
      { text: "Id with a dot <!-- run:run.1 -->", runId: null },
      { text: "No space before it<!-- run:run_1 -->", runId: null },
      { text: "Unknown mark <!-- run:run_1 keep -->", runId: null },
    ]);
  });

  it("honours only the last of two suffixes, handing the inner one back as text", () => {
    expect(parseRepoMemoryDocument("- Text <!-- run:inner --> <!-- run:outer -->")).toStrictEqual([
      { text: "Text <!-- run:inner -->", runId: "outer" },
    ]);
  });

  it("reads CRLF documents, skips blank bullets and lines that are not bullets", () => {
    expect(
      parseRepoMemoryDocument("# Repo facts: acme/api\r\n-   \r\n-not a bullet\r\n- Uses pnpm <!-- run:run_1 -->\r\n"),
    ).toStrictEqual([{ text: "Uses pnpm", runId: "run_1" }]);
  });

  it("renders the header, a blank line, and one suffix per item that has a writable run id", () => {
    expect(
      renderRepoMemoryDocument({
        subject: "acme/api",
        kind: "facts",
        items: [
          { text: "Uses Node 20", runId: "run_1" },
          { text: "Package manager is pnpm.", runId: "run_0", pinned: true },
          { text: "Legacy", runId: null },
          { text: "Pinned but no id", runId: null, pinned: true },
          { text: "Bad id", runId: "run 1" },
          { text: "Two\nlines", runId: "run_1" },
        ],
      }),
    ).toBe(
      `${HEAD}\n` +
        "- Uses Node 20 <!-- run:run_1 -->\n" +
        "- Package manager is pnpm. <!-- run:run_0 pin -->\n" +
        "- Legacy\n" +
        "- Pinned but no id\n" +
        "- Bad id\n" +
        "- Two lines <!-- run:run_1 -->\n",
    );
    expect(renderRepoMemoryDocument({ subject: "acme/api", kind: "lessons", items: [] })).toBe(
      "# Repo lessons: acme/api\n<!-- blazebot:repo-memory v1 -->\n",
    );
  });

  it("strips every trailing suffix from bullets only, keeping a CR and every other line byte for byte", () => {
    expect(
      stripRepoMemoryProvenance(
        "# Head <!-- run:head -->\r\n- A <!-- run:x --> <!-- run:y pin -->\r\n- B <!-- run:z -->\n",
      ),
    ).toBe("# Head <!-- run:head -->\r\n- A\r\n- B\n");
  });
});
