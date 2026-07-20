import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendComposerSection,
  insertComposerMarkdown,
  moveComposerBlock,
  parseComposerBlocks,
  serializeComposerBlocks,
  updateComposerBlock,
} from "./composer.ts";

function ids() {
  let id = 0;
  return () => `block-${++id}`;
}

test("headings and prompt references become flat independent blocks", () => {
  const blocks = parseComposerBlocks("# Intro\nA\n\n{{prompt:42}}\n\n## End\nB", ids());
  assert.deepEqual(blocks.map((block) => [block.kind, block.title]), [
    ["section", "Intro"],
    ["reference", "Prompt 42"],
    ["section", "End"],
  ]);
});

test("latest and pinned prompt references stay atomic", () => {
  const blocks = parseComposerBlocks("{{prompt:1}}\n\n{{prompt:1@2}}", ids());
  assert.deepEqual(blocks.map((block) => block.kind === "reference" ? block.reference.version : null), ["latest", 2]);
  assert.equal(serializeComposerBlocks(blocks), "{{prompt:1}}\n\n{{prompt:1@2}}");
});

test("moving a reference preserves it without expanding", () => {
  const blocks = parseComposerBlocks("# A\na\n\n{{prompt:2}}\n\n# B\nb", ids());
  const moved = moveComposerBlock(blocks, blocks[1].id, 0);
  assert.equal(serializeComposerBlocks(moved), "{{prompt:2}}\n\n# A\na\n\n# B\nb");
});

test("whole prompt reference and copied section insert at exact indices", () => {
  const blocks = parseComposerBlocks("# A\na\n\n# D\nd", ids());
  const withReference = insertComposerMarkdown(blocks, 1, "{{prompt:7}}", ids());
  const withSection = insertComposerMarkdown(withReference, 2, "## C\nc", ids());
  assert.deepEqual(withSection.map((block) => block.title), ["A", "Prompt 7", "C", "D"]);
});

test("editing a section can create another heading card without changing earlier ids", () => {
  const blocks = parseComposerBlocks("# A\na", ids());
  const updated = updateComposerBlock(blocks, blocks[0].id, "# A\na\n## B\nb", ids());
  assert.equal(updated[0].id, blocks[0].id);
  assert.deepEqual(updated.map((block) => block.title), ["A", "B"]);
});

test("empty markdown produces no visual cards", () => {
  assert.deepEqual(parseComposerBlocks("", ids()), []);
  assert.equal(serializeComposerBlocks([]), "");
});

test("appends a writable section and returns its stable id", () => {
  const makeId = ids();
  const blocks = parseComposerBlocks("{{prompt:7}}", makeId);
  const result = appendComposerSection(blocks, makeId);

  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[1].kind, "section");
  assert.equal(result.blocks[1].body, "## New section");
  assert.equal(result.sectionId, result.blocks[1].id);
  assert.equal(serializeComposerBlocks(result.blocks), "{{prompt:7}}\n\n## New section");
});
