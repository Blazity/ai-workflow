import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_VISIBILITY_PAGE_DEFAULT_BYTES,
  AgentVisibilityPageError,
  agentBriefingRepositorySchema,
  agentBriefingSectionPageSchema,
  agentVisibilityListPageSchema,
  byteRangeInPage,
  pageList,
  pageSectionText,
  readVisibilityRecord,
  type AgentBriefingSectionPage,
  type AgentVisibilityListPage,
} from "./index";
import { bytes } from "./test-support/fixtures";

const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));

function allPages(text: string, maxBytes: number): AgentBriefingSectionPage[] {
  const pages: AgentBriefingSectionPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = pageSectionText({ sectionIndex: 4, text, offset, maxBytes });
    pages.push(page);
    offset = page.nextOffset;
  }
  return pages;
}

const POLISH = "Zażółć gęślą jaźń, łódź i źdźbło. Emoji 😀🚀 i \"cudzysłów\"\n";

// Red when: a page boundary falls inside a UTF-8 sequence or a surrogate pair,
// or a page repeats or skips bytes.
test("pages of Polish text and emoji concatenate back and never split a character", () => {
  const text = POLISH.repeat(80);
  const pages = allPages(text, 1_024);
  assert.ok(pages.length > 5, `expected many pages, got ${pages.length}`);
  assert.equal(pages.map((page) => page.text).join(""), text);
  let expectedOffset = 0;
  for (const page of pages) {
    assert.equal(page.offset, expectedOffset);
    assert.equal(page.totalBytes, bytes(text));
    // A string holding half a surrogate pair would not survive UTF-8.
    assert.equal(Buffer.from(page.text, "utf8").toString("utf8"), page.text);
    assert.ok(jsonBytes(page) <= 1_024, `page at ${page.offset} is ${jsonBytes(page)} bytes`);
    expectedOffset += bytes(page.text);
  }
  assert.equal(pages.at(-1)!.nextOffset, null);
  assert.equal(expectedOffset, bytes(text));
});

// Red when: the cap is checked against the text's bytes instead of the page
// as JSON, where each quote, backslash and newline doubles and each control
// character becomes six bytes.
test("a page stays under the cap as JSON even when the text is all escapes", () => {
  const text = '"\\\n\u0001ą'.repeat(2_000);
  const pages = allPages(text, 2_048);
  assert.equal(pages.map((page) => page.text).join(""), text);
  for (const page of pages) {
    assert.ok(jsonBytes(page) <= 2_048, `page at ${page.offset} is ${jsonBytes(page)} bytes`);
    if (page.nextOffset !== null) assert.ok(jsonBytes(page) > 1_900, "a page uses the room it has");
  }
});

// Red when: the default page is sized in characters or ignores the envelope.
test("the default page fits about 48 KB and says where the next one starts", () => {
  const text = "a".repeat(200_000);
  const page = pageSectionText({ sectionIndex: 0, text });
  assert.equal(AGENT_VISIBILITY_PAGE_DEFAULT_BYTES, 49_152);
  assert.ok(jsonBytes(page) <= 49_152);
  assert.ok(page.nextOffset! > 49_000);
  assert.equal(page.nextOffset, bytes(page.text));
  assert.equal(readVisibilityRecord(agentBriefingSectionPageSchema, JSON.parse(JSON.stringify(page))).ok, true);
});

// Red when: the room reserved for nextOffset is the width of a short number
// while the last page writes "null", so a page that fills its room exactly
// comes out over the cap.
test("a last page that fills its room exactly stays under the cap", () => {
  const envelope = (total: number) =>
    jsonBytes({ schemaVersion: 1, sectionIndex: 0, offset: 0, text: "", nextOffset: total, totalBytes: total });
  const total = Array.from({ length: 400 }, (_unused, index) => 600 + index).find(
    (candidate) => candidate + envelope(candidate) === 1_024,
  )!;
  const page = pageSectionText({ sectionIndex: 0, text: "a".repeat(total), maxBytes: 1_024 });
  assert.ok(jsonBytes(page) <= 1_024, `page is ${jsonBytes(page)} bytes`);
  const text = pages("a".repeat(total), 1_024);
  assert.equal(text, "a".repeat(total));

  // The same edge on a list: one item that fits only if "null" is not counted.
  const base = jsonBytes({ schemaVersion: 1, cursor: null, items: [], shortened: [], nextCursor: null, total: 1 });
  const item = "b".repeat(1_024 - base - 1);
  const list = pageList([item], { maxBytes: 1_024 });
  assert.ok(jsonBytes(list) <= 1_024, `list page is ${jsonBytes(list)} bytes`);
  assert.equal(list.nextCursor, null);
});

function pages(text: string, maxBytes: number): string {
  return allPages(text, maxBytes)
    .map((page) => page.text)
    .join("");
}

// Red when: a bad offset or cap is clamped silently, which would hand a
// client a page it did not ask for or a loop that never ends.
test("offsets and caps are refused readably, and the end is an empty final page", () => {
  const text = "ąbc"; // 4 bytes: ą is two
  const refused = (run: () => unknown, code: string, pattern: RegExp) =>
    assert.throws(run, (error: unknown) => {
      assert.ok(error instanceof AgentVisibilityPageError);
      assert.equal(error.code, code);
      assert.match(error.message, pattern);
      return true;
    });
  refused(() => pageSectionText({ sectionIndex: 0, text, offset: 5 }), "offset_out_of_range", /past the end.*4 bytes/);
  refused(() => pageSectionText({ sectionIndex: 0, text, offset: 1 }), "offset_inside_character", /inside a character/);
  refused(() => pageSectionText({ sectionIndex: 0, text, offset: -1 }), "offset_out_of_range", /whole number/);
  refused(() => pageSectionText({ sectionIndex: 0, text, maxBytes: 100 }), "cap_out_of_range", /1024.*524288/);
  refused(() => pageSectionText({ sectionIndex: 0, text, maxBytes: 600_000 }), "cap_out_of_range", /1024.*524288/);
  refused(() => pageSectionText({ sectionIndex: -1, text }), "section_index_invalid", /whole number from 0; -1/);
  refused(() => pageSectionText({ sectionIndex: 1.5, text }), "section_index_invalid", /whole number from 0/);
  assert.deepEqual(pageSectionText({ sectionIndex: 0, text, offset: 4 }), {
    schemaVersion: 1,
    sectionIndex: 0,
    offset: 4,
    text: "",
    nextOffset: null,
    totalBytes: 4,
  });
  assert.deepEqual(pageSectionText({ sectionIndex: 0, text, offset: 2 }).text, "bc");
});

// Red when: a part range or a redaction span is placed on a page by byte
// offset without converting to string indices, which misplaces every mark
// after the first multi-byte character.
test("byte ranges map to string indices within a page, clipped at its edges", () => {
  // Bytes: "ą" 0..2, "ą" 2..4, "ą" 4..6, "😀" 6..10, "a" 10, "b" 11, "c" 12.
  const secondPage = { offset: 6, text: "😀abc", nextOffset: null };
  assert.deepEqual(byteRangeInPage(secondPage, { start: 4, end: 12 }), {
    start: 0,
    end: 4,
    continuesBefore: true,
    continuesAfter: false,
  });
  const firstPage = { offset: 0, text: "ąąą", nextOffset: 6 };
  assert.deepEqual(byteRangeInPage(firstPage, { start: 4, end: 12 }), {
    start: 2,
    end: 3,
    continuesBefore: false,
    continuesAfter: true,
  });
  assert.equal(byteRangeInPage(firstPage, { start: 10, end: 12 }), null);
  // A zero-width span belongs to the page it starts on; at the very end, to
  // the last page.
  assert.equal(byteRangeInPage(firstPage, { start: 6, end: 6 }), null);
  assert.deepEqual(byteRangeInPage(secondPage, { start: 6, end: 6 }), {
    start: 0,
    end: 0,
    continuesBefore: false,
    continuesAfter: false,
  });
  assert.deepEqual(byteRangeInPage(secondPage, { start: 13, end: 13 }), {
    start: 5,
    end: 5,
    continuesBefore: false,
    continuesAfter: false,
  });
});

function repository(index: number, description = `Service number ${index}.`) {
  return {
    key: `github:acme/service-${index}`,
    description: { source: "catalog", text: description },
    rules: null,
    relationships: [],
    relationshipCount: 0,
    state: "offered",
    inclusion: { cause: "catalog" },
    rendering: "line",
    workScopeEntry: null,
  };
}

// Red when: a list page drops or repeats an item, or goes over the cap.
test("list pages walk a long repository context by cursor, each under the cap", () => {
  const repositories = Array.from({ length: 60 }, (_unused, index) => repository(index));
  const seen: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: AgentVisibilityListPage<ReturnType<typeof repository>> = pageList(repositories, { cursor, maxBytes: 2_048 });
    assert.ok(jsonBytes(page) <= 2_048);
    assert.deepEqual(page.shortened, []);
    assert.equal(page.total, 60);
    assert.ok(page.items.length > 0);
    seen.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null);
  assert.ok(pages > 3);
  assert.deepEqual(seen, repositories);
});

// Red when: an item bigger than the cap produces an empty page with the same
// cursor, which a client loops on forever, or is served whole over the cap.
test("an item bigger than the cap is shortened, its full size stated, and the cursor moves", () => {
  const huge = repository(1, "d".repeat(10_000));
  const items = [repository(0), huge, repository(2)];
  const first = pageList(items, { maxBytes: 4_096 });
  assert.equal(first.items.length, 1);
  const second = pageList(items, { cursor: first.nextCursor, maxBytes: 4_096 });
  assert.equal(second.items.length, 1);
  assert.ok(jsonBytes(second) <= 4_096);
  assert.deepEqual(second.shortened, [{ index: 1, fullBytes: jsonBytes(huge) }]);
  const shortenedText = (second.items[0] as typeof huge).description.text;
  assert.ok(shortenedText.length < 10_000);
  assert.match(shortenedText, /^d+\u2026 \(10000 characters in full\)$/);
  // Everything else in the item is whole: a shortened key would not parse.
  assert.equal((second.items[0] as typeof huge).key, huge.key);
  assert.equal(second.nextCursor, "2.3");
  const read = readVisibilityRecord(
    agentVisibilityListPageSchema(agentBriefingRepositorySchema),
    JSON.parse(JSON.stringify(second)),
  );
  assert.equal(read.ok, true);
});

// Red when: an item that fits only by dropping entries of one of its arrays
// is served with the entries cut, which a reader takes for the whole list (a
// round with half its deliveries); or the refusal hides the size a caller
// would need.
test("an item that fits only by cutting an array is refused with its full size", () => {
  const round = { id: "c1", deliveries: Array.from({ length: 400 }, (_unused, index) => ({ words: `answer ${index}` })) };
  assert.throws(
    () => pageList([round], { maxBytes: 2_048 }),
    (error: unknown) => {
      assert.ok(error instanceof AgentVisibilityPageError);
      assert.equal(error.code, "item_too_large");
      assert.equal(error.itemIndex, 0);
      assert.equal(error.fullBytes, jsonBytes(round));
      assert.match(error.message, new RegExp(`Item 0 is ${jsonBytes(round)} bytes`));
      return true;
    },
  );
  // The same item under a cap that holds it comes back whole.
  const page = pageList([round], { maxBytes: 16_384 });
  assert.deepEqual(page.items[0], round);
  assert.deepEqual(page.shortened, []);
});

// Red when: a malformed cursor restarts the list or skips to its end.
test("a malformed cursor is refused, and the end is an empty final page", () => {
  const items = [1, 2, 3];
  // The bare position is the form this pager used to hand out, and it is
  // refused now: it says nothing about which list it came from.
  for (const cursor of ["abc", "-1", "4", "01", "2", "4.3", "2.03"]) {
    assert.throws(() => pageList(items, { cursor }), (error: unknown) =>
      error instanceof AgentVisibilityPageError && error.code === "cursor_invalid");
  }
  const end = pageList(items, { cursor: "3.3" });
  assert.deepEqual([end.items, end.nextCursor, end.total], [[], null, 3]);
});

// Red when: a position cursor is taken at face value over a list that grew or
// shrank between two pages. That serves one entry twice and skips another with
// nothing red anywhere, which is why the rule is that lists page on an
// append-only key; this pager is the one exception and has to prove it is
// looking at the same list, not merely assert it in a comment.
test("a cursor is refused once the list it was handed out for has changed", () => {
  const items = [1, 2, 3, 4, 5];
  const first = pageList(items, { maxBytes: 1_024 * 4, cursor: "2.5" });
  assert.deepEqual(first.items, [3, 4, 5]);

  for (const changed of [[0, 1, 2, 3, 4, 5], [1, 2, 3, 4]]) {
    assert.throws(
      () => pageList(changed, { cursor: "2.5" }),
      (error: unknown) => {
        assert.ok(error instanceof AgentVisibilityPageError);
        assert.equal(error.code, "cursor_invalid");
        // The same answer a keyed list gives: read it again from the start.
        assert.match(error.message, /read the list again from the start/);
        return true;
      },
    );
  }
});
