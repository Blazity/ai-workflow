import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_AGENT_PROMPTS, DEFAULT_FIX_PROMPT } from "./default-prompts";

/**
 * Built-in prompt bodies are seeded into prompt_library by migrations and are
 * compared byte for byte by the built-in drift gate, so moving them into this
 * package may not change a single character. These are the sha256 hashes the
 * bodies had at 0b8c4fe3b689033d233ae2df04df7d7d808503b0, where they still
 * lived in packages/contracts/default-prompts.ts. A failure here means the
 * move edited a body, which needs a prompt-library resync migration and is not
 * part of this stage.
 */
const HASHES_AT_MOVE: Record<string, string> = {
  "research-plan": "d5ed882a3cfddf4e5ffd0276afe9cbd138e4287ceaa5e9000bd2a4ab61502449",
  implement: "249d10d8f9e9ecba5679676ae406d700a81516f39e4400fef60896602b63694d",
  review: "6ebfbf331dc6938a42782c58195d5c638884816688e8c640b48559fc204454e9",
};
const FIX_PROMPT_HASH_AT_MOVE =
  "a4b3e51fa8c83ac275d47bd33bcabc42547f77701fd620f04caaef0573fbac03";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("built-in prompt bodies", () => {
  it("carries every registry body unchanged from the contracts package", () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(DEFAULT_AGENT_PROMPTS).map(([name, body]) => [name, sha256(body)]),
      ),
      HASHES_AT_MOVE,
    );
  });

  it("carries the fix prompt unchanged", () => {
    assert.equal(sha256(DEFAULT_FIX_PROMPT), FIX_PROMPT_HASH_AT_MOVE);
  });
});
