import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_AGENT_PROMPTS, DEFAULT_FIX_PROMPT } from "./default-prompts";

/**
 * Built-in prompt bodies are seeded into prompt_library by migrations and are
 * compared byte for byte by the built-in drift gate, so a body edit without a
 * resync migration never reaches a run. These are the sha256 hashes of the
 * bodies apps/worker/drizzle/0074_builtin_prompt_resync.sql seeds. A failure
 * here means a body changed: write a new resync migration with
 * `pnpm run db:prompt-resync drizzle/<file>.sql` in apps/worker, then update
 * these hashes.
 */
const HASHES_AT_LAST_RESYNC: Record<string, string> = {
  "research-plan": "2cfb8a55634d6401f9812cc1fbd212bff2d61a7000624b0391a1fb8aa96d3a29",
  implement: "0d32e8036af7f0487fd36c948700ff7b6160761134fff35564ac85238db1ec1f",
  review: "362052eedfd5df2339166d46c9be8f8d771bda776f458d4efff993d832dc1c21",
};
// The fix prompt is a code default that no migration seeds; its hash is the
// one it had when the bodies moved into this package.
const FIX_PROMPT_HASH_AT_MOVE =
  "a4b3e51fa8c83ac275d47bd33bcabc42547f77701fd620f04caaef0573fbac03";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("built-in prompt bodies", () => {
  it("carries the registry bodies the latest resync migration seeds", () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(DEFAULT_AGENT_PROMPTS).map(([name, body]) => [name, sha256(body)]),
      ),
      HASHES_AT_LAST_RESYNC,
    );
  });

  it("carries the fix prompt unchanged", () => {
    assert.equal(sha256(DEFAULT_FIX_PROMPT), FIX_PROMPT_HASH_AT_MOVE);
  });
});
