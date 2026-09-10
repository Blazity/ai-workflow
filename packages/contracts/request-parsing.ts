import type { ZodType } from "zod";

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
  schema: ZodType<T>,
  body: unknown,
): RequestParseResult<T> {
  const result = schema.safeParse(body);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const first = result.error.issues[0];
  return { ok: false, message: first?.message ?? "Invalid request body" };
}
