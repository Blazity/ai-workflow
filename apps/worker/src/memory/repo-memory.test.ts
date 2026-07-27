import { describe, expect, it } from "vitest";
import { repoSubjectKey } from "../lib/subject-key.js";
import { utf8Bytes } from "./content.js";
import {
  REPO_MEMORY_DOC_PATHS,
  mergeRepoMemoryItems,
  parseRepoMemoryDocument,
  renderRepoMemoryDocument,
} from "./repo-memory.js";

const SUBJECT = "github:Blazity/ai-workflow";

function merge(
  existing: readonly string[],
  candidates: readonly string[],
  caps: { maxItems?: number; maxBytes?: number } = {},
): { items: string[]; dropped: number } {
  return mergeRepoMemoryItems({
    existing,
    candidates,
    maxItems: caps.maxItems ?? 50,
    maxBytes: caps.maxBytes ?? 64 * 1024,
    subject: SUBJECT,
    kind: "facts",
  });
}

function budgetFor(items: readonly string[]): number {
  return utf8Bytes(renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items }));
}

describe("repo memory document format", () => {
  it("renders the header, the version marker and one bullet per item", () => {
    expect(
      renderRepoMemoryDocument({
        subject: SUBJECT,
        kind: "facts",
        items: ["first item", "second item"],
      }),
    ).toBe(
      `# Repo facts: ${SUBJECT}\n<!-- blazebot:repo-memory v1 -->\n\n- first item\n- second item\n`,
    );
  });

  it("renders header and marker only when there are no items", () => {
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "lessons", items: [] });
    expect(doc).toBe(`# Repo lessons: ${SUBJECT}\n<!-- blazebot:repo-memory v1 -->\n`);
    expect(parseRepoMemoryDocument(doc)).toEqual([]);
  });

  it("round-trips markdown, unicode and internal double spaces", () => {
    const items = [
      "Run `pnpm test` from **apps/worker**",
      "zażółć gęślą jaźń: build w CI",
      "two  spaces  inside stay intact",
      "Vitest globs src/**/*.test.ts",
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
      "* other marker",
      "- also kept",
    ].join("\n");
    expect(parseRepoMemoryDocument(doc)).toEqual(["kept", "also kept"]);
  });

  it("parses a document stored with CRLF line endings", () => {
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "facts",
      items: ["first item", "second item"],
    }).replace(/\n/g, "\r\n");
    expect(parseRepoMemoryDocument(doc)).toEqual(["first item", "second item"]);
  });

  it("collapses line breaks inside an item instead of forging bullets", () => {
    const doc = renderRepoMemoryDocument({
      subject: SUBJECT,
      kind: "facts",
      items: ["line one\nline two", "kept"],
    });
    expect(parseRepoMemoryDocument(doc)).toEqual(["line one line two", "kept"]);
  });

  it("collapses line breaks in the subject, so it cannot inject an item", () => {
    const doc = renderRepoMemoryDocument({
      subject: "github:acme/web\n- injected",
      kind: "facts",
      items: ["real item"],
    });
    expect(doc).toContain("# Repo facts: github:acme/web - injected\n");
    expect(parseRepoMemoryDocument(doc)).toEqual(["real item"]);
  });

  it("names both document kinds", () => {
    expect(REPO_MEMORY_DOC_PATHS).toEqual(["facts", "lessons"]);
  });
});

describe("mergeRepoMemoryItems", () => {
  it("keeps existing items first, then surviving candidates in order", () => {
    expect(merge(["one", "two"], ["three", "four"])).toEqual({
      items: ["one", "two", "three", "four"],
      dropped: 0,
    });
  });

  it("drops a candidate that repeats an existing item and keeps the stored spelling", () => {
    expect(merge(["Use pnpm, not npm."], ["use   pnpm, not npm", "Node 22 in CI"])).toEqual({
      items: ["Use pnpm, not npm.", "Node 22 in CI"],
      dropped: 0,
    });
  });

  it("treats casing and a trailing period as the same item", () => {
    expect(merge([], ["Lint with biome", "lint with biome.", "LINT WITH BIOME"])).toEqual({
      items: ["Lint with biome"],
      dropped: 0,
    });
  });

  it("dedupes candidates against each other, first occurrence wins", () => {
    expect(merge([], ["Run pnpm test", "run  pnpm  test.", "Run pnpm build"])).toEqual({
      items: ["Run pnpm test", "Run pnpm build"],
      dropped: 0,
    });
  });

  it("splits a multi-line candidate into separate items", () => {
    const candidate = "Build with pnpm build\nTests live in apps/worker\r\nTypecheck via tsc";
    expect(merge([], [candidate])).toEqual({
      items: ["Build with pnpm build", "Tests live in apps/worker", "Typecheck via tsc"],
      dropped: 0,
    });
  });

  it("strips bullet markers and drops blank lines", () => {
    expect(merge([], ["- dash marker\n  * star marker\n\n   \n-  spaced dash", "   "])).toEqual({
      items: ["dash marker", "star marker", "spaced dash"],
      dropped: 0,
    });
  });

  it("drops the oldest items when the count cap is exceeded", () => {
    expect(merge(["one", "two", "three"], ["four"], { maxItems: 3 })).toEqual({
      items: ["two", "three", "four"],
      dropped: 1,
    });
  });

  it("drops the oldest items when the rendered document exceeds the byte cap", () => {
    const cap = budgetFor(["second", "third"]);
    const result = merge(["first", "second"], ["third"], { maxBytes: cap });
    expect(result).toEqual({ items: ["second", "third"], dropped: 1 });
    expect(budgetFor(["first", "second", "third"])).toBeGreaterThan(cap);
    expect(budgetFor(result.items)).toBeLessThanOrEqual(cap);
  });

  it("returns nothing rather than an oversized document for a single huge item", () => {
    const big = "x".repeat(500);
    // One byte under what this item needs, so the cap is above the empty
    // document and only the item itself is what does not fit.
    const cap = budgetFor([big]) - 1;
    expect(cap).toBeGreaterThan(budgetFor([]));
    expect(merge([], [big], { maxBytes: cap })).toEqual({ items: [], dropped: 1 });
  });

  it("returns nothing when the cap is below the empty document", () => {
    expect(merge([], ["a fact"], { maxBytes: 0 })).toEqual({ items: [], dropped: 1 });
    expect(budgetFor([])).toBeGreaterThan(0);
  });

  it("returns nothing when no items are allowed", () => {
    expect(merge(["one"], ["two"], { maxItems: 0 })).toEqual({ items: [], dropped: 2 });
  });

  it("counts only cap losses in dropped, not dedup or hygiene losses", () => {
    expect(merge([], ["a", "a", "a", "b"])).toEqual({ items: ["a", "b"], dropped: 0 });
    expect(merge([], ["- a\n\n   \n- a", "  "])).toEqual({ items: ["a"], dropped: 0 });
  });

  it("is idempotent when the same candidates are merged again", () => {
    const first = merge(["Use pnpm"], ["Node 22 in CI", "Vitest runs from apps/worker"]);
    const second = merge(first.items, ["Node 22 in CI", "Vitest runs from apps/worker"]);
    expect(second.items).toEqual(first.items);
    expect(second.dropped).toBe(0);
  });

  it("produces a document that parses back to the merged items", () => {
    const { items } = merge(["Use pnpm"], ["- Node 22 in CI\n- Tests: pnpm vitest run"]);
    const doc = renderRepoMemoryDocument({ subject: SUBJECT, kind: "facts", items });
    expect(parseRepoMemoryDocument(doc)).toEqual(items);
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
