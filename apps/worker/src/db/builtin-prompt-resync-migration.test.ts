import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PROMPTS } from "@shared/contracts";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
/** The newest resync migration, picked up by suffix rather than a pinned
 *  filename: a fresh resync (e.g. 0044 superseding 0038) must make this suite
 *  exercise the new file, or the test would keep passing while checking a
 *  migration that no longer sits at the head of the guard's history. */
const latestResyncFile = readdirSync(migrationsDir)
  .filter((file) => file.endsWith("_builtin_prompt_resync.sql"))
  .sort()
  .at(-1);
if (!latestResyncFile) {
  throw new Error("No *_builtin_prompt_resync.sql migration found in drizzle/");
}
const latestResyncPrefix = latestResyncFile.slice(0, 4);
const resyncSql = readFileSync(`${migrationsDir}${latestResyncFile}`, "utf8");
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

describe(`${latestResyncPrefix} built-in prompt resync migration`, () => {
  it("corrects the untouched seed and is a strict no-op when replayed", async () => {
    const client = await migrateThrough(latestResyncPrefix);

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

  it("corrects a platform-authored version above 1 and leaves a customer one beside it", async () => {
    // The central case of the widening, and the one production actually has:
    //
    //   implement  1  system                            System migration
    //   implement  2  system                            System migration
    //   review     2  A2FzRCBJ5e0eMggEB4N8D2pcWASWphDW  admin@blazity.com
    //
    // No path in this repository can write a version row stamped 'system', so
    // implement@2 was inserted out of band, yet it is unambiguously platform
    // text and an active definition pins it. Authorship therefore has to be read
    // off the row, never inferred from the version number.
    const client = await migrateThrough("0033");
    await client.exec(`
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, created_by_id, created_by_label, restored_from_version)
      SELECT id, 2, 'platform body from an earlier release', 'system', 'System migration', NULL
      FROM prompt_library WHERE slug = 'implement'
    `);
    await client.exec(`
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, created_by_id, created_by_label, restored_from_version)
      SELECT id, 2, 'our own review checklist', 'A2FzRCBJ5e0eMggEB4N8D2pcWASWphDW', 'admin@blazity.com', NULL
      FROM prompt_library WHERE slug = 'review'
    `);
    const before = await readBuiltIns(client);
    const xminOf = (rows: SeedRow[], slug: string, version: number): string =>
      rows.find((row) => row.slug === slug && row.version === version)!
        .version_xmin;

    await client.exec(resyncSql);
    const after = await readBuiltIns(client);
    const rowFor = (slug: string, version: number): SeedRow =>
      after.find((row) => row.slug === slug && row.version === version)!;

    // Both platform versions of `implement` are corrected, including the one
    // above 1 that 0034 and 0036 vetoed.
    expect(rowFor("implement", 1).body).toBe(DEFAULT_AGENT_PROMPTS.implement);
    expect(rowFor("implement", 2).body).toBe(DEFAULT_AGENT_PROMPTS.implement);
    expect(xminOf(after, "implement", 2)).not.toBe(
      xminOf(before, "implement", 2),
    );

    // Two versions now holding the same body is harmless: versions are immutable
    // snapshots identified by number, nothing dedupes on body, and both pins
    // keep resolving. savePromptVersion's no-op guard only ever compares against
    // the head, so a later customer edit still appends version 3.
    expect(rowFor("implement", 1).body).toBe(rowFor("implement", 2).body);
    expect(after.filter((row) => row.slug === "implement")).toHaveLength(2);

    // The customer's version is not rewritten at all, proven by the row-version
    // stamp rather than by comparing values.
    expect(rowFor("review", 2).body).toBe("our own review checklist");
    expect(xminOf(after, "review", 2)).toBe(xminOf(before, "review", 2));
    // Its platform sibling at version 1 is still corrected.
    expect(rowFor("review", 1).body).toBe(DEFAULT_AGENT_PROMPTS.review);
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

  it("preserves a tenant's own rewrite of a built-in prompt through the resync, including a replay", async () => {
    // Pins the product decision this migration currently makes for a body a
    // tenant has actually rewritten (not just appended to): the guard reads
    // authorship off the version row's created_by_id / created_by_label, and
    // savePromptVersion always stamps the acting account there, so a tenant
    // save can never carry 'system' / 'System migration' and is therefore
    // never a candidate for correction, silently. This is "survives" rather
    // than "overwritten and reported" - see the open question about whether
    // that is the semantics the product wants long-term.
    const client = await migrateThrough("0033");
    await client.exec(`
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, created_by_id, created_by_label, restored_from_version)
      SELECT id, 2, 'tenant-rewritten review checklist', 'u_tenant', 'Tenant Admin', NULL
      FROM prompt_library WHERE slug = 'review'
    `);
    const before = await readBuiltIns(client);
    const tenantXminBefore = before.find(
      ({ slug, version }) => slug === "review" && version === 2,
    )!.version_xmin;

    await client.exec(resyncSql);
    // A replay (the migration re-applied, or an older resync file re-run
    // against a database that already has a newer one) must not touch it
    // either.
    await client.exec(resyncSql);

    const after = await readBuiltIns(client);
    const tenantVersion = after.find(
      ({ slug, version }) => slug === "review" && version === 2,
    )!;
    expect(tenantVersion.body).toBe("tenant-rewritten review checklist");
    expect(tenantVersion.version_xmin).toBe(tenantXminBefore);

    // The platform's own version 1 underneath it is still corrected.
    const systemVersion = after.find(
      ({ slug, version }) => slug === "review" && version === 1,
    )!;
    expect(systemVersion.body).toBe(DEFAULT_AGENT_PROMPTS.review);
  });
});
