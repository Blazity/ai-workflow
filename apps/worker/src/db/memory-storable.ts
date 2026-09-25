/**
 * Strings as Postgres can store them in the memory tables. Kept apart from the
 * repositories so the ledger writer (`memory/ledger/writer.ts`) applies the
 * same rule before it redacts and hashes without importing drizzle: nothing
 * here imports anything.
 */

/** `String.prototype.toWellFormed` (Node 20 and later), typed here because the
 *  worker compiles against ES2022. */
function wellFormed(text: string): string {
  return (text as string & { toWellFormed(): string }).toWellFormed();
}

/**
 * Every string, and every key, of the value without NUL, which Postgres
 * refuses in text and in JSON alike, and without a lone surrogate, which fails
 * the JSON cast of the whole statement and loses every row of it. Dates and
 * other values are kept as they are.
 */
export function storable<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value.replaceAll("\u0000", "")) as T;
  if (Array.isArray(value)) return value.map((item) => storable(item)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [storable(key), storable(item)]),
    ) as T;
  }
  return value;
}
