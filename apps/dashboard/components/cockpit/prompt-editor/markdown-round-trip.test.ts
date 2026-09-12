// The real parser and the real serializer, not a stand-in: the whole point of
// the check is that the SCHEMA decides what survives, so a test against a mock
// would answer for an editor nobody uses. No DOM is needed for either, because
// MarkdownManager is the same object `editor.getMarkdown()` serializes through.
import assert from "node:assert/strict";
import test from "node:test";

import { MarkdownManager } from "@tiptap/markdown";

import { substitutePromptVariables } from "@shared/prompts";

import {
  restoreVariableTokens,
  visualEditorKeepsMarkdown,
} from "./markdown-round-trip";
import { promptEditorExtensions } from "./prompt-editor-extensions";

const RULES_VARIABLES = ["repo_path", "run_id", "ticket_key"];

function extensions() {
  return promptEditorExtensions({
    canonical: false,
    variableNames: RULES_VARIABLES,
  });
}

/** What the serializer alone produces, escaping and all. */
function serialized(markdown: string): string {
  const manager = new MarkdownManager({ extensions: extensions() });
  return manager.serialize(manager.parse(markdown));
}

/** What the editor hands back for this text: the serialization, then the one
 *  repair `onUpdate` applies before the markdown reaches `onChange`. */
function roundTrip(markdown: string): string {
  return restoreVariableTokens(serialized(markdown));
}

const RULES = [
  "# Rules",
  "",
  "- never force push to `main`",
  "  - rebase instead",
  "    - and rerun the checks",
  "",
  "```sh",
  "pnpm test",
  "```",
  "",
  "Use {{repo_path}} when you name the checkout.",
  "",
].join("\n");

const RULES_WITH_TABLE = [
  RULES,
  "| check | when |",
  "| --- | --- |",
  "| lint | always |",
  "",
].join("\n");

test("a rules document of headings, nested lists, fenced code and a variable survives", () => {
  // Fixed here rather than asserted loosely: if a future schema change drops one
  // of these, this test says which one before the editor eats somebody's rules.
  const back = roundTrip(RULES);
  assert.match(back, /^# Rules$/m);
  assert.match(back, /^ {4}- and rerun the checks$/m);
  assert.match(back, /```sh\npnpm test\n```/);
  assert.equal(visualEditorKeepsMarkdown(RULES, extensions()), true);
});

test("a table has no node in this schema, comes back as nothing, and opens raw", () => {
  const back = roundTrip(RULES_WITH_TABLE);
  assert.doesNotMatch(back, /lint/, "the row is gone, which is the loss");
  assert.equal(visualEditorKeepsMarkdown(RULES_WITH_TABLE, extensions()), false);
});

test("a re-spelling is not a loss", () => {
  // The serializer normalizes the bullet marker and the heading style. Treating
  // that as damage would open nearly every document raw and make the visual
  // editor unreachable, which is the failure mode this comparison avoids.
  assert.equal(visualEditorKeepsMarkdown("* one\n* two\n", extensions()), true);
  assert.equal(visualEditorKeepsMarkdown("Rules\n=====\n\nbody\n", extensions()), true);
});

test("an empty field is not a damaged one", () => {
  assert.equal(visualEditorKeepsMarkdown("", extensions()), true);
  assert.equal(visualEditorKeepsMarkdown("   \n", extensions()), true);
});

test("a variable survives the visual editor and still renders at runtime", () => {
  // The serializer escapes every _ * [ ] ~ ` and backslash in plain text, so
  // left alone it hands back {{repo\_path}}, which the runtime never matches.
  // What the editor actually emits is the repaired string, and the assertion
  // that matters is the last one: the token still substitutes.
  const typed = "Deploy {{repo_path}} for {{ticket_key}}.\n";
  assert.match(serialized(typed), /\{\{repo\\_path\}\}/);

  const emitted = roundTrip(typed);
  assert.equal(emitted, "Deploy {{repo_path}} for {{ticket_key}}.");
  assert.equal(
    substitutePromptVariables(emitted, {
      repo_path: "acme/web",
      ticket_key: "AWT-1",
    }),
    "Deploy acme/web for AWT-1.",
  );
});

test("a backslash outside a token is the author's and is left alone", () => {
  // The repair is scoped to the braces. An escape the serializer put in prose
  // is what keeps that prose literal when the markdown is rendered, so undoing
  // it there would change the document the author wrote.
  const emitted = roundTrip("Write a\\_b in prose and {{repo_path}} as a token.\n");
  assert.match(emitted, /a\\_b/);
  assert.match(emitted, /\{\{repo_path\}\}/);
  assert.equal(restoreVariableTokens("nothing to do here"), "nothing to do here");
});
