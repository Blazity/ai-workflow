import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PROMPTS } from "@shared/contracts";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const resyncSql = readFileSync(
  `${migrationsDir}0037_builtin_prompt_resync.sql`,
  "utf8",
);
/** Fixed past timestamp the parent rows are pinned to, so "was updated_at
 *  bumped" is decided by a real comparison rather than by clock resolution. */
const PINNED_UPDATED_AT = "2000-01-01 00:00:00+00";

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter(
      (file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix,
    )
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

interface SeedRow {
  slug: string;
  version: number;
  body: string;
  updated_at: string;
  /** Postgres row-version stamps: unchanged means the row was never rewritten,
   *  even to an identical value. */
  version_xmin: string;
  prompt_xmin: string;
}

async function readBuiltIns(client: PGlite): Promise<SeedRow[]> {
  const res = await client.query<SeedRow>(`
    SELECT p.slug,
           v.version,
           v.body,
           p.updated_at::text AS updated_at,
           v.xmin::text AS version_xmin,
           p.xmin::text AS prompt_xmin
    FROM prompt_library p
    JOIN prompt_library_versions v ON v.prompt_id = p.id
    WHERE p.slug IN ('research-plan', 'implement', 'review')
    ORDER BY p.slug, v.version
  `);
  return res.rows;
}

async function pinUpdatedAt(client: PGlite, slugs: string[]): Promise<void> {
  await client.exec(`
    UPDATE prompt_library
    SET updated_at = '${PINNED_UPDATED_AT}'
    WHERE slug IN (${slugs.map((slug) => `'${slug}'`).join(", ")})
  `);
}

describe("0037 built-in prompt resync migration", () => {
  it("corrects the untouched seed and is a strict no-op when replayed", async () => {
    const client = await migrateThrough("0037");

    // The seed is now byte-identical to the constants, still at one version.
    const applied = await readBuiltIns(client);
    expect(applied.map(({ slug, version }) => `${slug}@${version}`)).toEqual([
      "implement@1",
      "research-plan@1",
      "review@1",
    ]);
    for (const row of applied) {
      expect(row.body).toBe(
        DEFAULT_AGENT_PROMPTS[row.slug as keyof typeof DEFAULT_AGENT_PROMPTS],
      );
    }

    // Replaying it must touch nothing: the body guard short-circuits every
    // statement, so no version row and no parent row is rewritten.
    const replay = await client.exec(resyncSql);
    expect(replay.map(({ affectedRows }) => affectedRows)).toEqual([0, 0, 0]);
    expect(await readBuiltIns(client)).toEqual(applied);
  });

  it("corrects a platform version a user has appended to, and keeps the user's own", async () => {
    // Pre-0034, so every seeded version 1 still holds the 0021 literal and has
    // therefore drifted from the constants.
    const client = await migrateThrough("0033");
    const seeded = await readBuiltIns(client);
    const staleImplement = seeded.find(
      ({ slug }) => slug === "implement",
    )!.body;
    expect(staleImplement).not.toBe(DEFAULT_AGENT_PROMPTS.implement);

    // A user edit only ever appends: savePromptVersion and restorePromptVersion
    // both INSERT max+1 and never rewrite an existing body, and both stamp the
    // authenticated account. Authorship therefore lives on the version row, and
    // "the prompt has a version above 1" says nothing about who wrote version 1.
    // 0034 and 0036 read it as if it did, which is why they were inert on
    // production for the two built-ins that had a second version.
    await client.exec(`
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, created_by_id, created_by_label, restored_from_version)
      SELECT id, 2, 'user edit', 'u_admin', 'Admin', NULL
      FROM prompt_library WHERE slug = 'implement'
    `);
    await pinUpdatedAt(client, ["research-plan", "implement", "review"]);

    await client.exec(resyncSql);
    const after = await readBuiltIns(client);
    const rowFor = (slug: string, version: number): SeedRow =>
      after.find((row) => row.slug === slug && row.version === version)!;

    // The platform's own version 1 is corrected even though the user appended a
    // version 2, and the user's version 2 is left exactly as written.
    expect(rowFor("implement", 1).body).toBe(DEFAULT_AGENT_PROMPTS.implement);
    expect(rowFor("implement", 2).body).toBe("user edit");

    // Every drifted parent records the correction; nothing else is bumped.
    const pinned = new Date(PINNED_UPDATED_AT).getTime();
    for (const slug of ["research-plan", "implement", "review"] as const) {
      expect(rowFor(slug, 1).body).toBe(DEFAULT_AGENT_PROMPTS[slug]);
      expect(
        new Date(rowFor(slug, 1).updated_at).getTime(),
      ).toBeGreaterThan(pinned);
    }
  });

  it("leaves user-created prompts untouched", async () => {
    const client = await migrateThrough("0035");
    await client.exec(`
      INSERT INTO prompt_library (name, slug, created_by_id, created_by_label)
      VALUES ('My implement', 'my-implement', 'u_admin', 'Admin')
    `);
    await client.exec(`
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, created_by_id, created_by_label, restored_from_version)
      SELECT id, 1, 'my own body', 'u_admin', 'Admin', NULL
      FROM prompt_library WHERE slug = 'my-implement'
    `);
    await pinUpdatedAt(client, ["my-implement"]);

    await client.exec(resyncSql);
    const mine = await client.query<{ body: string; updated_at: string }>(`
      SELECT v.body, p.updated_at::text AS updated_at
      FROM prompt_library p
      JOIN prompt_library_versions v ON v.prompt_id = p.id
      WHERE p.slug = 'my-implement'
    `);
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]!.body).toBe("my own body");
    expect(new Date(mine.rows[0]!.updated_at).toISOString()).toBe(
      new Date(PINNED_UPDATED_AT).toISOString(),
    );
  });
});
