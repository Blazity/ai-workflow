import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix)
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

describe("0023 durable clarification checkpoint migration", () => {
  it("deliberately retires legacy pending rows and adds indexed checkpoint lifecycle metadata", async () => {
    const client = await migrateThrough("0022");
    await client.exec(`
      INSERT INTO clarification_requests (id, ticket_key, run_id, questions)
      VALUES ('clar-legacy', 'PROJ-1', 'run-1', '["Question?"]'::jsonb)
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0023_spotty_jetstream.sql`, "utf8"),
    );

    const rows = await client.query<{
      id: string;
      subject_key: string | null;
      checkpoint_state: string | null;
      cleanup_state: string;
      status: string;
      cleanup_error: string | null;
    }>(`
      SELECT id, subject_key, checkpoint_state, cleanup_state, status, cleanup_error
      FROM clarification_requests
    `);
    expect(rows.rows).toEqual([
      {
        id: "clar-legacy",
        subject_key: "ticket:jira:PROJ-1",
        checkpoint_state: "orphaned",
        cleanup_state: "deleted",
        status: "superseded",
        cleanup_error: "Legacy clarification cannot be resumed; restart the ticket to rebuild the workflow checkpoint.",
      },
    ]);

    const columns = await client.query<{ is_nullable: string }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'clarification_requests' AND column_name = 'ticket_key'
    `);
    expect(columns.rows).toEqual([{ is_nullable: "YES" }]);

    const indexes = await client.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE indexname IN (
        'clarification_requests_checkpoint_expiry_idx',
        'clarification_requests_cleanup_idx',
        'clarification_requests_pending_subject_idx'
      )
      ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "clarification_requests_checkpoint_expiry_idx",
      "clarification_requests_cleanup_idx",
      "clarification_requests_pending_subject_idx",
    ]);
  });
});
