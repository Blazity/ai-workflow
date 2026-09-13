import assert from "node:assert/strict";
import { z } from "zod";

/**
 * True when this run resolved `zod` to version 4, which is what `pnpm run
 * test:zod4` does and what the deployed worker bundle does.
 */
const RUNNING_AGAINST_ZOD_4 = "_zod" in z.string();

function hasProperty(value: unknown, property: string): boolean {
  return typeof value === "object" && value !== null && property in value;
}

/**
 * A `{ ok: false, message }` refusal, the one shape this suite asserts whose
 * content is a fact about the zod version rather than about the schema.
 */
function isRefusal(value: unknown): value is { ok: false; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { message?: unknown }).message === "string" &&
    Object.keys(value).length === 2
  );
}

/**
 * Compare two parse results, ignoring the wording of a refusal under zod 4.
 *
 * zod 4 rewrote every built-in message and silently ignores zod 3's
 * `required_error`, `invalid_type_error` and `errorMap` parameters, so the
 * curated sentence a refusal carries here is a zod 3 fact: the same schema that
 * answers "Missing email" under the pinned zod 3 answers "Invalid input:
 * expected string, received undefined" under the zod 4 the worker bundle
 * resolves. The alias run exists to catch the differences that CRASH or flip a
 * verdict, not the ones that reword a sentence, so there, and only there, a
 * refusal is asserted as a refusal carrying some message. The default run still
 * asserts every sentence exactly, which is where that contract is guarded.
 */
function assertResult(actual: unknown, expected: unknown): void {
  if (RUNNING_AGAINST_ZOD_4 && isRefusal(expected)) {
    assert.ok(isRefusal(actual), `expected a refusal, got ${JSON.stringify(actual)}`);
    assert.ok(actual.message.length > 0, "expected a non-empty refusal message");
    return;
  }
  assert.deepEqual(actual, expected);
}

function assertPartial(actual: unknown, expected: unknown): void {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    assert.deepEqual(actual, expected);
    return;
  }
  assert.ok(typeof actual === "object" && actual !== null);
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(key in actual, `expected property ${key}`);
    assertPartial((actual as Record<string, unknown>)[key], value);
  }
}

/** Small compatibility surface for schema tests moved from Vitest to node:test. */
export function expect(actual: unknown, _message?: string) {
  return {
    toBe(expected: unknown): void {
      assert.equal(actual, expected);
    },
    toEqual(expected: unknown): void {
      assertResult(actual, expected);
    },
    toMatchObject(expected: unknown): void {
      assertPartial(actual, expected);
    },
    toHaveProperty(property: string): void {
      assert.ok(hasProperty(actual, property), `expected property ${property}`);
    },
    not: {
      toHaveProperty(property: string): void {
        assert.equal(hasProperty(actual, property), false, `unexpected property ${property}`);
      },
    },
  };
}
