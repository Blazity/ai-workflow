import { expect, it } from "vitest";

import { parseRequestBody, type RequestParseResult } from "@shared/contracts";
import type { ZodType, ZodTypeDef } from "zod";

/**
 * The bodies a client can send that are JSON but are not an object.
 *
 * Each handler these schemas replaced read its body with `readBody(...) ?? {}`
 * and then picked fields off the result, so every one of these arrived as a
 * value with no fields and was answered exactly like `{}`.
 */
const NON_OBJECT_BODIES: readonly unknown[] = ["abc", 42, true, null, []];

/**
 * Assert that a schema answers a non-object body the way its handler did.
 *
 * `expected` is what the base handler answered for a body with no fields, so
 * the same assertion covers both halves of the regression: the status (a schema
 * that refuses where the handler proceeded) and the sentence (a schema that
 * says "Expected object, received string" where the handler named the first
 * field it missed).
 */
export function itTreatsNonObjectBodyAsEmpty<T>(
  name: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  expected: RequestParseResult<T>,
): void {
  it(`${name} answers a body that is not an object the way it answers {}`, () => {
    expect(parseRequestBody(schema, {})).toEqual(expected);
    for (const body of NON_OBJECT_BODIES) {
      expect(parseRequestBody(schema, body), `body ${JSON.stringify(body)}`).toEqual(
        expected,
      );
    }
  });
}

/**
 * Assert that a schema refuses a non-object body with the handler's sentence.
 *
 * The counterpart of the helper above, for the handlers that checked the body
 * themselves before reading a field: they refused a scalar, an array or null
 * with a sentence of their own, so the schema carries that sentence on the
 * object level and the refusal has to read the same as it did at the base.
 */
export function itRefusesNonObjectBodyWith<T>(
  name: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  message: string,
): void {
  it(`${name} refuses a body that is not an object with the handler's sentence`, () => {
    for (const body of NON_OBJECT_BODIES) {
      expect(parseRequestBody(schema, body), `body ${JSON.stringify(body)}`).toEqual({
        ok: false,
        message,
      });
    }
  });
}
