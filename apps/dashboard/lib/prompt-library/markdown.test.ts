import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdownBlocks } from "./markdown.ts";

test("parseInline splits text, bold, inline code and variables", () => {
  assert.deepEqual(parseInline("a **bold {{ticket_key}}** and `code` end"), [
    { type: "text", value: "a ", bold: false },
    { type: "text", value: "bold ", bold: true },
    { type: "var", name: "ticket_key", known: true, bold: true },
    { type: "text", value: " and ", bold: false },
    { type: "code", value: "code" },
    { type: "text", value: " end", bold: false },
  ]);
});

test("parseInline flags unknown variables", () => {
  assert.deepEqual(parseInline("{{zzz_unknown}}"), [
    { type: "var", name: "zzz_unknown", known: false, bold: false },
  ]);
});

test("parseInline leaves ** inside inline code literal", () => {
  assert.deepEqual(parseInline("`a ** b`"), [{ type: "code", value: "a ** b" }]);
});

test("headings parse to levels 1-3", () => {
  assert.deepEqual(parseMarkdownBlocks("# One\n## Two\n### Three"), [
    { type: "heading", level: 1, inline: [{ type: "text", value: "One", bold: false }] },
    { type: "heading", level: 2, inline: [{ type: "text", value: "Two", bold: false }] },
    { type: "heading", level: 3, inline: [{ type: "text", value: "Three", bold: false }] },
  ]);
});

test("fenced code is literal and does not spawn a heading", () => {
  const blocks = parseMarkdownBlocks("```json\n# not a heading\n```");
  assert.deepEqual(blocks, [{ type: "code", lang: "json", value: "# not a heading" }]);
});

test("an unclosed fence still yields one code block", () => {
  assert.deepEqual(parseMarkdownBlocks("```\nline a\nline b"), [
    { type: "code", lang: null, value: "line a\nline b" },
  ]);
});

test("unordered list groups consecutive items, then a paragraph", () => {
  assert.deepEqual(parseMarkdownBlocks("- a\n- `b`\n\npara text"), [
    {
      type: "list",
      ordered: false,
      items: [[{ type: "text", value: "a", bold: false }], [{ type: "code", value: "b" }]],
    },
    { type: "paragraph", inline: [{ type: "text", value: "para text", bold: false }] },
  ]);
});

test("ordered list is detected", () => {
  assert.deepEqual(parseMarkdownBlocks("1. one\n2. two"), [
    {
      type: "list",
      ordered: true,
      items: [
        [{ type: "text", value: "one", bold: false }],
        [{ type: "text", value: "two", bold: false }],
      ],
    },
  ]);
});

test("a paragraph preserves its soft line breaks", () => {
  assert.deepEqual(parseMarkdownBlocks("line one\nline two"), [
    { type: "paragraph", inline: [{ type: "text", value: "line one\nline two", bold: false }] },
  ]);
});
