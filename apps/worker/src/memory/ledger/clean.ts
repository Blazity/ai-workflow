/**
 * Every string of a JSON-shaped value, its keys included, passed through
 * `clean`, everything else kept: the ledger's texts and details are cleaned of
 * this deployment's secrets with the one rule in `memory/known-secrets.ts`,
 * both on the way in and on the way out.
 */
export function cleanStrings<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map((item) => cleanStrings(item, clean)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [clean(key), cleanStrings(item, clean)]),
    ) as T;
  }
  return value;
}
