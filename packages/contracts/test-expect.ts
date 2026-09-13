import assert from "node:assert/strict";

function hasProperty(value: unknown, property: string): boolean {
  return typeof value === "object" && value !== null && property in value;
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
      assert.deepEqual(actual, expected);
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
