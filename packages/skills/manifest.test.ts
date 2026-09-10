import assert from "node:assert/strict";
import test from "node:test";
import { parseHarnessSkillMetadata, SkillValidationError } from "./index";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

test("parses the canonical SKILL.md metadata", () => {
  assert.deepEqual(
    parseHarnessSkillMetadata(
      bytes("---\nname: review-rules\ndescription: Review rules\n---\n"),
    ),
    { name: "review-rules", description: "Review rules" },
  );
});

test("reports stable manifest error codes and reasons", () => {
  assert.throws(
    () =>
      parseHarnessSkillMetadata(
        bytes("---\nname: BAD NAME\ndescription: Review rules\n---\n"),
      ),
    (error: unknown) =>
      error instanceof SkillValidationError &&
      error.code === "invalid_manifest" &&
      error.reason === "SKILL.md has an invalid name.",
  );
});
