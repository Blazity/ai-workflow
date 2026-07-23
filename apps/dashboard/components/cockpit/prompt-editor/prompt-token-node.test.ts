import assert from "node:assert/strict";
import test from "node:test";
import StarterKit from "@tiptap/starter-kit";
import { MarkdownManager } from "@tiptap/markdown";
import {
  findCanonicalPromptTokens,
  parseCanonicalPromptToken,
  PromptTokenNode,
  promptTokenNodeAttributes,
} from "./prompt-token-node";

function manager() {
  return new MarkdownManager({
    extensions: [StarterKit, PromptTokenNode],
  });
}

function promptTokens(
  node: ReturnType<MarkdownManager["parse"]>,
): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: typeof node) => {
    if (value.type === "promptToken") found.push(value.attrs ?? {});
    for (const child of value.content ?? []) visit(child);
  };
  visit(node);
  return found;
}

test("canonical data, pinned prompt, and slot tokens round-trip as atomic nodes", () => {
  const markdown =
    "Use {{data:steps.planning.output.plan}}, {{prompt:implement@3}}, and {{slot:review_notes}}.";
  const parser = manager();
  const parsed = parser.parse(markdown);

  assert.deepEqual(
    promptTokens(parsed).map((attrs) => [attrs.kind, attrs.token]),
    [
      ["data", "{{data:steps.planning.output.plan}}"],
      ["prompt", "{{prompt:implement@3}}"],
      ["slot", "{{slot:review_notes}}"],
    ],
  );
  assert.equal(parser.serialize(parsed), markdown);
});

test("canonical-looking tokens remain literal inside inline and fenced code", () => {
  const markdown =
    "Outside {{slot:plan}} and `{{slot:literal}}`.\n\n```txt\n{{data:run.id}}\n```";
  const parser = manager();
  const parsed = parser.parse(markdown);

  assert.deepEqual(
    promptTokens(parsed).map((attrs) => attrs.token),
    ["{{slot:plan}}"],
  );
  assert.equal(parser.serialize(parsed), markdown);
});

test("paste scanning skips code while preserving every copied token byte", () => {
  const markdown =
    "{{data:run.id}} `{{prompt:ignored@2}}` {{prompt:review@12}}\n\n```\n{{slot:hidden}}\n```\n{{slot:visible}}";
  const tokens = findCanonicalPromptTokens(markdown);

  assert.deepEqual(
    tokens.map((token) => token.raw),
    [
      "{{data:run.id}}",
      "{{prompt:review@12}}",
      "{{slot:visible}}",
    ],
  );
  for (const token of tokens) {
    assert.equal(promptTokenNodeAttributes(token.raw)?.token, token.raw);
    assert.equal(parseCanonicalPromptToken(token.raw)?.raw, token.raw);
  }
});

test("unversioned and malformed prompt references stay ordinary text", () => {
  assert.equal(parseCanonicalPromptToken("{{prompt:review}}"), null);
  assert.equal(parseCanonicalPromptToken("{{prompt:review@latest}}"), null);
  assert.equal(parseCanonicalPromptToken("{{data:steps.review.plan}}"), null);

  const parser = manager();
  const markdown = "{{prompt:review}} {{prompt:review@latest}}";
  const parsed = parser.parse(markdown);
  assert.equal(promptTokens(parsed).length, 0);
  assert.equal(parser.serialize(parsed), markdown);
});
