import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseSkillLockFile, SkillValidationError } from "./index";

const hash = "a".repeat(64);

test("parses the checked-in version 1 external skill lock", () => {
  const lock = readFileSync("../../apps/worker/skills-lock.json", "utf8");
  assert.equal(parseSkillLockFile(lock).version, 1);
});

test("requires every version 1 field", () => {
  assert.throws(
    () => parseSkillLockFile({ version: 1, skills: { review: {} } }),
    SkillValidationError,
  );
});

test("rejects an invalid SHA-256", () => {
  assert.throws(
    () =>
      parseSkillLockFile({
        version: 1,
        skills: {
          review: { source: "acme/review", sourceType: "github", computedHash: "bad" },
        },
      }),
    /entry "review" is invalid/u,
  );
});

test("rejects duplicate names in raw lock bytes", () => {
  assert.throws(
    () =>
      parseSkillLockFile(
        `{"version":1,"skills":{"review":{"source":"one","sourceType":"github","computedHash":"${hash}"},"review":{"source":"two","sourceType":"github","computedHash":"${hash}"}}}`,
      ),
    /unique names/u,
  );
});

test("rejects unsupported versions", () => {
  assert.throws(
    () => parseSkillLockFile({ version: 2, skills: {} }),
    /requires version 1/u,
  );
});
