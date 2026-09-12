import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The journal is the migrator's ordering, and the ordering is not obvious.
 *
 * drizzle's neon-http migrator applies a migration only when its `when` is
 * later than the last one it already applied, and `idx` is what an operator
 * reads. Two parallel branches of work each generate against the head they can
 * see, so a merge can land entries whose `idx` says one order and whose `when`
 * says another: the result is a migration that is skipped in production and
 * applied everywhere else, which no unit test would ever notice, because the
 * pglite driver replays the .sql files by filename and never reads this file.
 *
 * The third assertion covers the other half of the same merge: an entry whose
 * file was renamed or dropped is a migration the production migrator will look
 * for and not find.
 */
const drizzleDir = join(import.meta.dirname, "..", "..", "drizzle");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(
  readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8"),
) as { entries: JournalEntry[] };

describe("the migration journal", () => {
  it("has at least one entry", () => {
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("increases strictly in idx", () => {
    const indices = journal.entries.map((entry) => entry.idx);
    expect(indices).toEqual([...indices].sort((left, right) => left - right));
    expect(new Set(indices).size).toBe(indices.length);
  });

  it("increases strictly in when, so production applies every entry", () => {
    for (const [position, entry] of journal.entries.entries()) {
      const previous = journal.entries[position - 1];
      if (!previous) continue;
      expect(
        entry.when,
        `${entry.tag} was generated before ${previous.tag}, which precedes it`,
      ).toBeGreaterThan(previous.when);
    }
  });

  it("names a migration file that exists, for every entry", () => {
    const files = new Set(
      readdirSync(drizzleDir).filter((name) => name.endsWith(".sql")),
    );
    for (const entry of journal.entries) {
      expect(files.has(`${entry.tag}.sql`), `${entry.tag}.sql is missing`).toBe(true);
    }
  });
});
