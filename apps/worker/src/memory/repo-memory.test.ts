import { describe, expect, it } from "vitest";
import { orgSubjectKey, repoOwner, repoSubjectKey } from "../lib/subject-key.js";
import { utf8Bytes } from "./content.js";
import {
  REPO_MEMORY_DOC_PATHS,
  type RepoMemoryItem,
  mergeRepoMemoryItems,
  parseRepoMemoryDocument,
  renderRepoMemoryDocument,
  repoMemoryComparisonKey,
  stripRepoMemoryProvenance,
} from "./repo-memory.js";

const SUBJECT = "github:Blazity/ai-workflow";
/** The run doing the merging in every test that does not name its own. */
const RUN = "wrun_current";

function item(text: string, runId: string | null = null): RepoMemoryItem {
  return { text, runId };
}

/** Items the way a document written before provenance existed parses back. */
function stored(...texts: string[]): RepoMemoryItem[] {
  return texts.map((text) => item(text));
}

/** Items the way the current run's merge stamps them. */
function asserted(...texts: string[]): RepoMemoryItem[] {
  return texts.map((text) => item(text, RUN));
}

/** The run that seeded the repository, which is over by the time any of these
 * merges happen: nothing re-derives its facts once it is. */
const SEED_RUN = "wrun_seed";

/** Items the way the seed stamps what it derived from the repository itself. */
function derived(...texts: string[]): RepoMemoryItem[] {
  return texts.map((text) => ({ text, runId: SEED_RUN, pinned: true as const }));
}

function merge(
  existing: readonly RepoMemoryItem[],
  candidates: readonly string[],
  options: {
    maxItems?: number;
    maxBytes?: number;
    contradicted?: readonly string[];
    runId?: string;
  } = {},
): { items: RepoMemoryItem[]; dropped: number; removed: number } {
  return mergeRepoMemoryItems({
    existing,
    candidates,
    contradicted: options.contradicted ?? [],
    runId: options.runId ?? RUN,
    maxItems: options.maxItems ?? 50,
    maxBytes: options.maxBytes ?? 64 * 1024,
    subject: SUBJECT,
    kind: "facts",
  });
}

function budgetFor(items: readonly RepoMemoryItem[]): number {
  return utf8Bytes(renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items }));
}

describe("repo memory document format", () => {
  it("renders the header, the version marker and one bullet per item", () => {
    expect(
      renderRepoMemoryDocument({
        subject: SUBJECT,
        kind: "facts",
        items: stored("first item", "second item"),
      }),
    ).toBe(
      `# Repo facts: ${SUBJECT}\n<!-- blazebot:repo-memory v1 -->\n\n- first item\n- second item\n`,
    );
  });

  it("stamps each item that has a run with a trailing provenance comment", () => {
    expect(
      renderRepoMemoryDocument({
        subject: SUBJECT,
        kind: "facts",
        items: [item("Package manager is pnpm", "wrun_abc123"), item("Node 22 in CI")],
      }),
    ).toBe(
      `# Repo facts: ${SUBJECT}\n<!-- blazebot:repo-memory v1 -->\n\n` +
        "- Package manager is pnpm <!-- run:wrun_abc123 -->\n- Node 22 in CI\n",
    );
  });

  it("renders header and marker only when there are no items", () => {
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "lessons", items: [] });
    expect(doc).toBe(`# Repo lessons: ${SUBJECT}\n<!-- blazebot:repo-memory v1 -->\n`);
    expect(parseRepoMemoryDocument(doc)).toEqual([]);
  });

  it("round-trips markdown, unicode, internal double spaces and outer padding", () => {
    const items = [
      item("Run `pnpm test` from **apps/worker**", "wrun_a"),
      item("zażółć gęślą jaźń: build w CI"),
      item("two  spaces  inside stay intact", "wrun_b"),
      // Item text is stored verbatim, so leading and trailing padding survives
      // both with a provenance comment after it and without one.
      item("  padded  ", "wrun_c"),
      item("  padded plain  "),
      item("Vitest globs src/**/*.test.ts"),
    ];
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items });
    expect(parseRepoMemoryDocument(doc)).toEqual(items);
  });

  it("ignores every line that is not a bullet", () => {
    const doc = [
      `# Repo facts: ${SUBJECT}`,
      "<!-- blazebot:repo-memory v1 -->",
      "",
      "- kept",
      "stray prose",
      "-  ",
      "- ",
      "* other marker",
      "- also kept <!-- run:wrun_a -->",
    ].join("\n");
    expect(parseRepoMemoryDocument(doc)).toEqual([item("kept"), item("also kept", "wrun_a")]);
  });

  it("parses a document stored with CRLF line endings", () => {
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "facts",
      items: [item("first item", "wrun_a"), item("second item")],
    }).replace(/\n/g, "\r\n");
    expect(parseRepoMemoryDocument(doc)).toEqual([
      item("first item", "wrun_a"),
      item("second item"),
    ]);
  });

  it("collapses line breaks inside an item instead of forging bullets", () => {
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "facts",
      items: stored("line one\nline two", "kept"),
    });
    expect(parseRepoMemoryDocument(doc)).toEqual(stored("line one line two", "kept"));
  });

  it("collapses line breaks in the subject, so it cannot inject an item", () => {
    const doc = renderRepoMemoryDocument({
      subject: "github:acme/web\n- injected",
      kind: "facts",
      items: stored("real item"),
    });
    expect(doc).toContain("# Repo facts: github:acme/web - injected\n");
    expect(parseRepoMemoryDocument(doc)).toEqual(stored("real item"));
  });

  it("keeps comment-like item text out of the provenance suffix", () => {
    const items = [
      item("Docs use <!-- prettier-ignore --> around the table"),
      item("An item may end with a comment <!-- note -->"),
      item("A run marker with a space is not one <!-- run:not an id -->"),
      item("Both at once <!-- note -->", "wrun_a"),
    ];
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items });
    expect(parseRepoMemoryDocument(doc)).toEqual(items);
  });

  it("writes no provenance for a run id that would not parse back", () => {
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "facts",
      items: [item("a fact", "wrun bad --> - injected")],
    });
    expect(doc).toContain("\n- a fact\n");
    expect(parseRepoMemoryDocument(doc)).toEqual(stored("a fact"));
  });

  it("names both document kinds", () => {
    expect(REPO_MEMORY_DOC_PATHS).toEqual(["facts", "lessons"]);
  });

  it("carries the eviction mark inside the provenance comment", () => {
    const items = [...derived("Package manager is pnpm"), item("Node 22 in CI", "wrun_a")];
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items });
    expect(doc).toBe(
      `# Repo facts: ${SUBJECT}\n<!-- blazebot:repo-memory v1 -->\n\n` +
        `- Package manager is pnpm <!-- run:${SEED_RUN} pin -->\n` +
        "- Node 22 in CI <!-- run:wrun_a -->\n",
    );
    expect(parseRepoMemoryDocument(doc)).toEqual(items);
  });

  it("leaves an unmarked item at exactly the two properties it always had", () => {
    // A stored document is parsed all over this codebase and compared with
    // `toEqual`, so the mark has to be absent rather than false on every item
    // that does not carry it.
    const parsed = parseRepoMemoryDocument(
      renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items: stored("plain") }),
    );
    expect(Object.keys(parsed[0] ?? {})).toEqual(["text", "runId"]);
  });

  it("writes no mark on an item whose run id cannot be written back", () => {
    // The mark has exactly one shape, inside the comment this parser reads, so
    // an item that has already lost its provenance loses the mark with it rather
    // than getting a marker nothing can parse.
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "facts",
      items: [
        { text: "no run at all", runId: null, pinned: true },
        { text: "unwritable run", runId: "wrun bad --> - injected", pinned: true },
      ],
    });
    expect(doc).toContain("\n- no run at all\n");
    expect(doc).toContain("\n- unwritable run\n");
    expect(parseRepoMemoryDocument(doc)).toEqual(stored("no run at all", "unwritable run"));
  });
});

describe("documents written before the eviction mark existed", () => {
  /** Byte for byte what production stored before the mark: provenance with no
   * mark in it. Hardcoded rather than rendered, so this stays a statement about
   * the stored bytes even if the renderer changes. */
  const BEFORE =
    `# Repo facts: ${SUBJECT}\n<!-- blazebot:repo-memory v1 -->\n\n` +
    "- Package manager is pnpm <!-- run:wrun_old -->\n- Node 22 in CI\n";

  it("parses with no mark and re-renders byte for byte", () => {
    const parsed = parseRepoMemoryDocument(BEFORE);
    expect(parsed).toEqual([item("Package manager is pnpm", "wrun_old"), item("Node 22 in CI")]);
    expect(parsed.every((entry) => !("pinned" in entry))).toBe(true);
    expect(renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items: parsed })).toBe(
      BEFORE,
    );
  });

  it("merges and evicts exactly as it did before", () => {
    // Nothing in the document is marked, so eviction is the same head-first walk
    // over the same order it always was.
    expect(merge(parseRepoMemoryDocument(BEFORE), ["Lint with biome"], { maxItems: 2 })).toEqual({
      items: [item("Node 22 in CI"), item("Lint with biome", RUN)],
      dropped: 1,
      removed: 0,
    });
  });
});

describe("legacy documents without provenance", () => {
  const LEGACY =
    `# Repo facts: ${SUBJECT}\n<!-- blazebot:repo-memory v1 -->\n` +
    "\n- first item\n- second item\n";

  it("parses with a null run id and re-renders byte for byte", () => {
    const parsed = parseRepoMemoryDocument(LEGACY);
    expect(parsed).toEqual([
      { text: "first item", runId: null },
      { text: "second item", runId: null },
    ]);
    expect(renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items: parsed })).toBe(
      LEGACY,
    );
  });

  it("keeps a null run id on an item no run has confirmed", () => {
    const result = merge(parseRepoMemoryDocument(LEGACY), ["second item", "third item"]);
    expect(result.items).toEqual([
      item("first item"),
      item("second item", RUN),
      item("third item", RUN),
    ]);
  });
});

describe("stripRepoMemoryProvenance", () => {
  it("removes every marker and leaves the rest byte-identical", () => {
    const items = [item("first item", "wrun_a"), item("second item", "wrun_b")];
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items });
    const stripped = stripRepoMemoryProvenance(doc);
    expect(stripped).not.toContain("run:");
    expect(stripped).toBe(
      renderRepoMemoryDocument({
        subject: SUBJECT,
        kind: "facts",
        items: stored("first item", "second item"),
      }),
    );
    // The version marker is document metadata, not per-item provenance.
    expect(stripped).toContain("<!-- blazebot:repo-memory v1 -->");
  });

  it("removes a marker hidden behind another one", () => {
    // A model can emit a fact whose own text ends in a provenance-shaped
    // comment, and render then appends a second one behind it. Stripping only
    // the outer marker would hand the inner one straight to the agent.
    const { items } = merge([], ["fact text <!-- run:wrun_leak -->"], { runId: "wrun_now" });
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items });
    expect(doc).toContain("<!-- run:wrun_leak --> <!-- run:wrun_now -->");
    expect(stripRepoMemoryProvenance(doc)).not.toContain("run:");
  });

  it("touches only bullet lines", () => {
    const lines = [
      `# Repo facts: ${SUBJECT} <!-- run:wrun_header -->`,
      "<!-- blazebot:repo-memory v1 -->",
      "",
      "stray prose <!-- run:wrun_prose -->",
      "- kept <!-- run:wrun_item -->",
      "- ",
      "",
    ];
    expect(stripRepoMemoryProvenance(lines.join("\n"))).toBe(
      lines.map((line) => (line === "- kept <!-- run:wrun_item -->" ? "- kept" : line)).join("\n"),
    );
  });

  it("leaves a document that has no provenance untouched", () => {
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "lessons",
      items: stored("Docs use <!-- prettier-ignore --> around the table", "plain item"),
    });
    expect(stripRepoMemoryProvenance(doc)).toBe(doc);
  });

  it("keeps CRLF line endings intact", () => {
    const crlf = (items: readonly RepoMemoryItem[]): string =>
      renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items }).replace(/\n/g, "\r\n");
    expect(stripRepoMemoryProvenance(crlf([item("first item", "wrun_a")]))).toBe(
      crlf(stored("first item")),
    );
  });

  it("removes a marked comment, and one hidden behind another", () => {
    // The mark is bookkeeping exactly like the run id it rides in, so it must
    // never reach the agent either.
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "facts",
      items: [
        ...derived("Package manager is pnpm"),
        { text: "hidden <!-- run:wrun_leak pin -->", runId: "wrun_now" },
      ],
    });
    const stripped = stripRepoMemoryProvenance(doc);
    expect(stripped).not.toContain("run:");
    expect(stripped).not.toContain("pin");
    expect(stripped).toBe(
      renderRepoMemoryDocument({
        subject: SUBJECT,
        kind: "facts",
        items: stored("Package manager is pnpm", "hidden"),
      }),
    );
  });
});

describe("mergeRepoMemoryItems", () => {
  it("keeps existing items first, then surviving candidates in order", () => {
    expect(merge(stored("one", "two"), ["three", "four"])).toEqual({
      items: [...stored("one", "two"), ...asserted("three", "four")],
      dropped: 0,
      removed: 0,
    });
  });

  it("moves a confirmed item to the back and re-stamps it with the confirming run", () => {
    expect(
      merge(
        [item("Use pnpm, not npm.", "wrun_old"), item("Node 22 in CI", "wrun_old")],
        ["use   pnpm, not npm"],
        { runId: "wrun_new" },
      ),
    ).toEqual({
      items: [item("Node 22 in CI", "wrun_old"), item("Use pnpm, not npm.", "wrun_new")],
      dropped: 0,
      removed: 0,
    });
  });

  it("drops a candidate that repeats an existing item and keeps the stored spelling", () => {
    expect(
      merge(stored("Use pnpm, not npm."), ["use   pnpm, not npm", "Node 22 in CI"]),
    ).toEqual({
      items: asserted("Use pnpm, not npm.", "Node 22 in CI"),
      dropped: 0,
      removed: 0,
    });
  });

  it("treats casing and a trailing period as the same item", () => {
    expect(merge([], ["Lint with biome", "lint with biome.", "LINT WITH BIOME"])).toEqual({
      items: asserted("Lint with biome"),
      dropped: 0,
      removed: 0,
    });
  });

  it("dedupes candidates against each other, first occurrence wins", () => {
    expect(merge([], ["Run pnpm test", "run  pnpm  test.", "Run pnpm build"])).toEqual({
      items: asserted("Run pnpm test", "Run pnpm build"),
      dropped: 0,
      removed: 0,
    });
  });

  it("splits a multi-line candidate into separate items", () => {
    const candidate = "Build with pnpm build\nTests live in apps/worker\r\nTypecheck via tsc";
    expect(merge([], [candidate])).toEqual({
      items: asserted("Build with pnpm build", "Tests live in apps/worker", "Typecheck via tsc"),
      dropped: 0,
      removed: 0,
    });
  });

  it("strips bullet markers and drops blank lines", () => {
    expect(merge([], ["- dash marker\n  * star marker\n\n   \n-  spaced dash", "   "])).toEqual({
      items: asserted("dash marker", "star marker", "spaced dash"),
      dropped: 0,
      removed: 0,
    });
  });

  it("removes a contradicted item and counts it in removed", () => {
    const existing = [item("Install with npm", "wrun_old"), item("Node 22 in CI", "wrun_old")];
    // Contradictions are matched on the same normalized key as candidates.
    expect(
      merge(existing, ["Install with pnpm"], { contradicted: ["install with NPM."] }),
    ).toEqual({
      items: [item("Node 22 in CI", "wrun_old"), item("Install with pnpm", RUN)],
      dropped: 0,
      removed: 1,
    });
  });

  it("stores nowhere an entry the same run both asserts and contradicts", () => {
    expect(
      merge(stored("Use npm", "Node 22 in CI"), ["Use npm", "Lint with biome"], {
        contradicted: ["Use npm"],
      }),
    ).toEqual({
      items: [item("Node 22 in CI"), item("Lint with biome", RUN)],
      dropped: 0,
      removed: 1,
    });
  });

  it("counts nothing removed for a contradiction that matches no stored item", () => {
    expect(merge(stored("Node 22 in CI"), [], { contradicted: ["- Use npm\n- Use yarn"] })).toEqual(
      { items: stored("Node 22 in CI"), dropped: 0, removed: 0 },
    );
  });

  it("drops the oldest items when the count cap is exceeded", () => {
    expect(merge(stored("one", "two", "three"), ["four"], { maxItems: 3 })).toEqual({
      items: [...stored("two", "three"), ...asserted("four")],
      dropped: 1,
      removed: 0,
    });
  });

  it("evicts the least recently confirmed item, not the first inserted", () => {
    const existing = [
      item("oldest", "wrun_1"),
      item("middle", "wrun_2"),
      item("newest", "wrun_3"),
    ];
    // "oldest" is confirmed again, so the unconfirmed "middle" becomes the least
    // recently confirmed and is what the cap evicts.
    expect(merge(existing, ["oldest", "fourth"], { maxItems: 3, runId: "wrun_4" })).toEqual({
      items: [item("newest", "wrun_3"), item("oldest", "wrun_4"), item("fourth", "wrun_4")],
      dropped: 1,
      removed: 0,
    });
  });

  it("drops the oldest items when the rendered document exceeds the byte cap", () => {
    const cap = budgetFor([item("second"), item("third", RUN)]);
    const result = merge(stored("first", "second"), ["third"], { maxBytes: cap });
    expect(result).toEqual({
      items: [item("second"), item("third", RUN)],
      dropped: 1,
      removed: 0,
    });
    expect(budgetFor([...stored("first", "second"), ...asserted("third")])).toBeGreaterThan(cap);
    expect(budgetFor(result.items)).toBeLessThanOrEqual(cap);
  });

  it("measures the byte cap on the document including the provenance comments", () => {
    const bare = budgetFor(stored("first", "second"));
    const cap = budgetFor([item("first", "wrun_a"), item("second", RUN)]) - 1;
    // Both items fit without their comments and only one fits with them, so the
    // eviction below is caused by the stored provenance and nothing else.
    expect(bare).toBeLessThanOrEqual(cap);
    expect(merge([item("first", "wrun_a")], ["second"], { maxBytes: cap })).toEqual({
      items: [item("second", RUN)],
      dropped: 1,
      removed: 0,
    });
  });

  it("returns nothing rather than an oversized document for a single huge item", () => {
    const big = "x".repeat(500);
    // One byte under what this item needs, so the cap is above the empty
    // document and only the item itself is what does not fit.
    const cap = budgetFor(asserted(big)) - 1;
    expect(cap).toBeGreaterThan(budgetFor([]));
    expect(merge([], [big], { maxBytes: cap })).toEqual({ items: [], dropped: 1, removed: 0 });
  });

  it("returns nothing when the cap is below the empty document", () => {
    expect(merge([], ["a fact"], { maxBytes: 0 })).toEqual({
      items: [],
      dropped: 1,
      removed: 0,
    });
    expect(budgetFor([])).toBeGreaterThan(0);
  });

  it("returns nothing when no items are allowed", () => {
    expect(merge(stored("one"), ["two"], { maxItems: 0 })).toEqual({
      items: [],
      dropped: 2,
      removed: 0,
    });
  });

  it("drains the list for a negative cap", () => {
    const drained = { items: [], dropped: 2, removed: 0 };
    expect(merge(stored("one"), ["two"], { maxItems: -1 })).toEqual(drained);
    expect(merge(stored("one"), ["two"], { maxBytes: -1 })).toEqual(drained);
  });

  it("enforces no cap at all for a NaN cap", () => {
    // Every comparison against NaN is false, so the eviction loop never runs.
    const kept = { items: [...stored("one"), ...asserted("two")], dropped: 0, removed: 0 };
    expect(merge(stored("one"), ["two"], { maxItems: Number.NaN })).toEqual(kept);
    expect(merge(stored("one"), ["two"], { maxBytes: Number.NaN })).toEqual(kept);
  });

  it("counts only cap losses in dropped, not dedup or hygiene losses", () => {
    expect(merge([], ["a", "a", "a", "b"])).toEqual({
      items: asserted("a", "b"),
      dropped: 0,
      removed: 0,
    });
    expect(merge([], ["- a\n\n   \n- a", "  "])).toEqual({
      items: asserted("a"),
      dropped: 0,
      removed: 0,
    });
  });

  it("is idempotent when the same candidates are merged again", () => {
    const first = merge(stored("Use pnpm"), ["Node 22 in CI", "Vitest runs from apps/worker"]);
    const second = merge(first.items, ["Node 22 in CI", "Vitest runs from apps/worker"]);
    expect(second.items).toEqual(first.items);
    expect(second.dropped).toBe(0);
    expect(second.removed).toBe(0);
  });

  it("reorders once on confirmation and is a no-op on the repeat", () => {
    const existing = [
      item("a", "wrun_1"),
      item("b", "wrun_1"),
      item("c", "wrun_1"),
      item("d", "wrun_1"),
    ];
    const first = merge(existing, ["a", "c"], { contradicted: ["b"], runId: "wrun_2" });
    // "a" and "c" moved behind the untouched "d", "b" is gone.
    expect(first).toEqual({
      items: [item("d", "wrun_1"), item("a", "wrun_2"), item("c", "wrun_2")],
      dropped: 0,
      removed: 1,
    });
    const second = merge(first.items, ["a", "c"], { contradicted: ["b"], runId: "wrun_2" });
    expect(second).toEqual({ items: first.items, dropped: 0, removed: 0 });
  });

  it("produces a document that parses back to the merged items", () => {
    const { items } = merge(stored("Use pnpm"), ["- Node 22 in CI\n- Tests: pnpm vitest run"]);
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items });
    expect(parseRepoMemoryDocument(doc)).toEqual(items);
  });
});

describe("mergeRepoMemoryItems and seed-derived items", () => {
  it("evicts model-authored items while a marked one is under cap pressure", () => {
    // Insertion order puts the seed first, which is exactly what used to make it
    // the first thing evicted: nothing ever confirms a stored entry, because the
    // distill's system prompt forbids the model repeating one in any wording.
    const existing = [...derived("Package manager is pnpm"), ...stored("prose one", "prose two")];
    // The victim is the first unmarked item, and nothing else is reordered: the
    // marked entry keeps its place and "prose one" is what the cap takes.
    expect(merge(existing, ["prose three"], { maxItems: 3 })).toEqual({
      items: [
        ...derived("Package manager is pnpm"),
        ...stored("prose two"),
        ...asserted("prose three"),
      ],
      dropped: 1,
      removed: 0,
    });
  });

  it("keeps a marked item when the byte cap is what evicts", () => {
    const existing = [...derived("Run tests with: pnpm test"), ...stored("prose one")];
    const cap = budgetFor([...derived("Run tests with: pnpm test"), ...asserted("prose two")]);
    expect(merge(existing, ["prose two"], { maxBytes: cap })).toEqual({
      items: [...derived("Run tests with: pnpm test"), ...asserted("prose two")],
      dropped: 1,
      removed: 0,
    });
  });

  it("evicts marked items from the head once they are all that is left", () => {
    // Ranked last, not exempt. The caps are what the store can physically hold,
    // so a document over them cannot be written at all and a seeded fact nobody
    // can store is worth no more than a model-authored one.
    expect(merge(derived("seed one", "seed two", "seed three"), [], { maxItems: 2 })).toEqual({
      items: derived("seed two", "seed three"),
      dropped: 1,
      removed: 0,
    });
    expect(merge(derived("seed one"), [], { maxItems: 0 })).toEqual({
      items: [],
      dropped: 1,
      removed: 0,
    });
  });

  it("keeps the mark when a run confirms the item", () => {
    // A run restating a seeded fact confirms it rather than authoring it, so the
    // item moves to the back and is re-stamped, and losing the mark on the way
    // would unprotect it for good.
    expect(
      merge([...derived("Package manager is pnpm"), ...stored("prose")], ["package manager is pnpm"]),
    ).toEqual({
      items: [item("prose"), { text: "Package manager is pnpm", runId: RUN, pinned: true }],
      dropped: 0,
      removed: 0,
    });
  });

  it("still removes a marked item the run contradicted", () => {
    // The mark answers eviction, not retraction: a run that proved a seeded fact
    // false quoted it exactly, and the seed's own pruner deletes what the
    // manifest stopped declaring.
    expect(
      merge(derived("Run tests with: pnpm test"), [], {
        contradicted: ["run tests with: pnpm test"],
      }),
    ).toEqual({ items: [], dropped: 0, removed: 1 });
  });

  it("cannot be claimed by a model-authored entry", () => {
    // The merge stamps what it inserts and never reads a mark out of candidate
    // text, and render appends its own comment behind that text, so parse reads
    // the unmarked comment render wrote. Stable across a second round too, so a
    // repeat cannot escalate what the first one failed to claim.
    const first = merge([], ["a fact <!-- run:wrun_x pin -->"]);
    expect(first.items).toEqual(asserted("a fact <!-- run:wrun_x pin -->"));
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "facts",
      items: first.items,
    });
    const reparsed = parseRepoMemoryDocument(doc);
    expect(reparsed).toEqual(asserted("a fact <!-- run:wrun_x pin -->"));
    expect(reparsed.every((entry) => !("pinned" in entry))).toBe(true);
    // Unprotected, so cap pressure evicts it like any other model prose.
    expect(merge(reparsed, ["kept"], { maxItems: 1 }).items).toEqual(asserted("kept"));
  });

  it("keeps the seed alive across five runs of model prose", () => {
    // The measured regression: five merges of model output and every
    // seed-derived fact was gone, leaving a document that was entirely model
    // prose. The two entries here are the ones nothing but the seed produces.
    const seed = derived("Package manager is pnpm", "Run tests with: pnpm test");
    let items: RepoMemoryItem[] = [...seed];
    let dropped = 0;
    for (let round = 1; round <= 5; round += 1) {
      const result = merge(
        items,
        Array.from({ length: 4 }, (_, index) => `run ${round} lesson ${index}`),
        { maxItems: 8, runId: `wrun_${round}` },
      );
      items = result.items;
      dropped += result.dropped;
    }
    expect(dropped).toBeGreaterThan(0);
    expect(items.slice(0, seed.length)).toEqual(seed);
    expect(items).toHaveLength(8);
  });
});

describe("repoMemoryComparisonKey", () => {
  it("collapses casing, inner whitespace, outer padding and a trailing period", () => {
    const key = repoMemoryComparisonKey("Lint with biome");
    for (const spelling of ["  lint with biome.  ", "LINT   WITH\tBIOME", "Lint with biome."]) {
      expect(repoMemoryComparisonKey(spelling)).toBe(key);
    }
  });

  it("keeps two genuinely different items apart", () => {
    expect(repoMemoryComparisonKey("Lint with biome")).not.toBe(
      repoMemoryComparisonKey("Lint with eslint"),
    );
  });

  it("folds the leading bullet marker the merge itself strips", () => {
    // `splitCandidates` strips exactly one marker before an item is stored, so a
    // stored item can legitimately still carry one while the item the merge
    // derives from it carries none. A key that did not fold the marker would
    // never match those two again, and nothing downstream could tell they are
    // one fact.
    expect(repoMemoryComparisonKey("- Lint with biome")).toBe(
      repoMemoryComparisonKey("Lint with biome"),
    );
    expect(repoMemoryComparisonKey("*  lint with biome.")).toBe(
      repoMemoryComparisonKey("Lint with biome"),
    );
  });

  it("keeps a hyphen that belongs to the text", () => {
    // Only a marker followed by whitespace is a bullet, so a leading hyphen that
    // is part of the sentence is not folded away.
    expect(repoMemoryComparisonKey("-fast mode is on")).not.toBe(
      repoMemoryComparisonKey("fast mode is on"),
    );
  });

  it("is the key the merge itself dedups on", () => {
    // The contract the org-scope promotion leans on: it groups items by this
    // function, so a grouping that disagreed with the merge would promote an
    // item the merge then folds into a different one. Three spellings, one key,
    // one stored item.
    const spellings = ["Lint with biome", "  lint with biome.  ", "LINT   WITH BIOME"];
    expect(new Set(spellings.map(repoMemoryComparisonKey)).size).toBe(1);
    expect(merge([], spellings).items).toEqual(asserted("Lint with biome"));
  });

  it("folds a candidate onto a stored item under one key", () => {
    expect(repoMemoryComparisonKey("Use pnpm, not npm.")).toBe(
      repoMemoryComparisonKey("use   pnpm, not npm"),
    );
    expect(merge(stored("Use pnpm, not npm."), ["use   pnpm, not npm"]).items).toEqual(
      asserted("Use pnpm, not npm."),
    );
  });
});

describe("repoSubjectKey", () => {
  it("namespaces the repository path by provider", () => {
    expect(repoSubjectKey("github", "Blazity/ai-workflow")).toBe(
      "repo:github:Blazity/ai-workflow",
    );
    expect(repoSubjectKey("gitlab", "group/sub/app")).toBe("repo:gitlab:group/sub/app");
  });
});

describe("orgSubjectKey", () => {
  it("namespaces the owner by provider", () => {
    expect(orgSubjectKey("github", "Blazity")).toBe("org:github:Blazity");
    expect(orgSubjectKey("gitlab", "group")).toBe("org:gitlab:group");
  });

  it("cannot collide with a repository key for the same name", () => {
    expect(orgSubjectKey("github", "acme")).not.toBe(repoSubjectKey("github", "acme"));
  });
});

describe("repoOwner", () => {
  it("takes the first segment of a repository path", () => {
    expect(repoOwner("acme/service")).toBe("acme");
  });

  it("takes the owning namespace of a nested GitLab path", () => {
    // The top-level group was the wrong rule. On a self-hosted GitLab one
    // top-level group routinely holds a subgroup per customer, so grouping on
    // it merges every one of those customers into a single org memory document.
    // The namespace that owns the repository is tenant-aligned on both forges.
    expect(repoOwner("acme/group/project")).toBe("acme/group");
    expect(repoOwner("acme/group/sub/project")).toBe("acme/group/sub");
  });

  it("has no owner for a path with no slash", () => {
    expect(repoOwner("service")).toBeNull();
    expect(repoOwner("")).toBeNull();
  });

  it("has no owner for an empty first segment", () => {
    expect(repoOwner("/service")).toBeNull();
    expect(repoOwner("/")).toBeNull();
  });

  it("keeps two owners apart rather than folding them on a prefix", () => {
    expect(repoOwner("acme/api")).not.toBe(repoOwner("acmecorp/api"));
  });
});
