import { z, type ZodType, type ZodTypeDef } from "zod";

/**
 * The one way an HTTP request body becomes a typed value in this system.
 *
 * The schemas live here, in the package both applications already share, so the
 * dashboard sends what the worker accepts by construction rather than by two
 * descriptions of the same shape drifting apart. The result is a value, never a
 * thrown error and never an H3 error: the transport that called this decides
 * what a refusal looks like on the wire, and no schema reaches for the server
 * runtime to say 400.
 */
export type RequestParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Validate one request body against its schema.
 *
 * The message is the first issue the schema reported, in the order the schema
 * declares its fields, so a schema whose per-field messages match the strings a
 * handler used to produce keeps answering exactly what it answered before.
 */
export function parseRequestBody<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  body: unknown,
): RequestParseResult<T> {
  const result = schema.safeParse(body);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const first = result.error.issues[0];
  return { ok: false, message: first?.message ?? "Invalid request body" };
}

/**
 * A body the handler read with `readBody(...) ?? {}` and then picked fields off.
 *
 * A JSON scalar, an array or null reached those handlers as a value with no
 * fields, so every check saw `undefined` and answered whatever it answers for a
 * body that omits them: sometimes a 400 naming the first missing field,
 * sometimes a plain success because every field was optional. A bare object
 * schema answers "Expected object, received string" instead, which is a
 * different sentence and, where nothing was required, a different status. So a
 * non-object is turned into an empty object before validation, and the schema
 * decides the rest exactly as it does for `{}`.
 *
 * Wrap only the schemas whose handler behaved this way. A handler that checked
 * the body was an object itself keeps its own refusal, spelled as the object
 * level `message`.
 */
export function objectOrEmpty<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
): ZodType<T, ZodTypeDef, unknown> {
  return z.preprocess(
    (value) =>
      value && typeof value === "object" && !Array.isArray(value) ? value : {},
    schema,
  );
}
