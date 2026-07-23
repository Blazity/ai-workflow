import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

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

describe("0022 Prompt Slots migration", () => {
  it("creates a fresh schema with non-null empty slots", async () => {
    const client = await migrateThrough("0022");
    const rows = await client.query<{ slots: unknown }>(`
      SELECT slots
      FROM prompt_library_versions
      ORDER BY prompt_id, version
    `);

    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every(({ slots }) => JSON.stringify(slots) === "[]")).toBe(
      true,
    );
    const columns = await client.query<{
      column_default: string;
      is_nullable: string;
    }>(`
      SELECT column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'prompt_library_versions'
        AND column_name = 'slots'
    `);
    expect(columns.rows).toEqual([
      expect.objectContaining({
        is_nullable: "NO",
        column_default: expect.stringContaining("'[]'::jsonb"),
      }),
    ]);
  });

  it("upgrades existing versions in place and defaults later legacy inserts", async () => {
    const client = await migrateThrough("0021");
    const prompt = await client.query<{ id: number }>(`
      INSERT INTO prompt_library
        (name, slug, created_by_id, created_by_label)
      VALUES
        ('Legacy prompt', 'legacy-prompt', 'admin', 'Admin')
      RETURNING id
    `);
    const promptId = prompt.rows[0]!.id;
    await client.exec(`
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, created_by_id, created_by_label)
      VALUES
        (${promptId}, 1, 'legacy body', 'admin', 'Admin')
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0022_prompt_slots.sql`, "utf8"),
    );
    const upgraded = await client.query<{
      body: string;
      slots: unknown;
    }>(`
      SELECT body, slots
      FROM prompt_library_versions
      WHERE prompt_id = ${promptId} AND version = 1
    `);
    expect(upgraded.rows).toEqual([
      {
        body: "legacy body",
        slots: [],
      },
    ]);

    await client.exec(`
      INSERT INTO prompt_library_versions
        (prompt_id, version, body, created_by_id, created_by_label)
      VALUES
        (${promptId}, 2, 'legacy writer', 'admin', 'Admin')
    `);
    const inserted = await client.query<{ slots: unknown }>(`
      SELECT slots
      FROM prompt_library_versions
      WHERE prompt_id = ${promptId} AND version = 2
    `);
    expect(inserted.rows).toEqual([{ slots: [] }]);
  });
});
