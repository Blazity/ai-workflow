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

describe("0024 workflow-run subject-key backfill migration", () => {
  it("replays cumulatively from 0023 and backfills without overwriting PR subjects", async () => {
    const client = await migrateThrough("0023");
    await client.exec(`
      INSERT INTO workflow_runs (run_id, ticket_key, subject_key)
      VALUES
        ('ticket-run', ' proj-42 ', NULL),
        ('pr-run', 'PROJ-42', 'pr:github:acme/app#7'),
        ('uncorrelated-run', NULL, NULL);
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0024_workflow_run_subject_key_backfill.sql`, "utf8"),
    );

    const runs = await client.query<{
      run_id: string;
      subject_key: string | null;
    }>(`
      SELECT run_id, subject_key
      FROM workflow_runs
      ORDER BY run_id
    `);
    expect(runs.rows).toEqual([
      { run_id: "pr-run", subject_key: "pr:github:acme/app#7" },
      { run_id: "ticket-run", subject_key: "ticket:jira:PROJ-42" },
      { run_id: "uncorrelated-run", subject_key: null },
    ]);

    const publishedHeadColumn = await client.query<{
      column_name: string;
      is_nullable: string;
    }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_owned_branches'
        AND column_name = 'published_head_sha'
    `);
    expect(publishedHeadColumn.rows).toEqual([
      { column_name: "published_head_sha", is_nullable: "YES" },
    ]);

    const publicationColumns = await client.query<{
      column_name: string;
      is_nullable: string;
    }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'publication_attempts'
      ORDER BY ordinal_position
    `);
    expect(publicationColumns.rows).toEqual([
      { column_name: "id", is_nullable: "NO" },
      { column_name: "run_id", is_nullable: "NO" },
      { column_name: "block_id", is_nullable: "NO" },
      { column_name: "workspace_manifest", is_nullable: "NO" },
      { column_name: "status", is_nullable: "NO" },
      { column_name: "failure", is_nullable: "YES" },
      { column_name: "created_at", is_nullable: "NO" },
      { column_name: "updated_at", is_nullable: "NO" },
    ]);

    await client.exec(`
      INSERT INTO publication_attempts (id, run_id, block_id, workspace_manifest)
      VALUES ('attempt-1', 'run-1', 'finalize', '{"version":1,"repositories":[]}');
      INSERT INTO publication_attempt_repositories
        (attempt_id, provider, repo_path, branch_name, default_branch)
      VALUES ('attempt-1', 'github', 'acme/api', 'aiw/AWT-1', 'main');
      DELETE FROM publication_attempts WHERE id = 'attempt-1';
    `);
    const childRows = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM publication_attempt_repositories
    `);
    expect(childRows.rows).toEqual([{ count: 0 }]);
  });

  it("chains its snapshot from 0023 without dropping clarification state", () => {
    type Snapshot = {
      id: string;
      prevId: string;
      tables: Record<string, unknown>;
    };
    const previous = JSON.parse(
      readFileSync(`${migrationsDir}meta/0023_snapshot.json`, "utf8"),
    ) as Snapshot;
    const current = JSON.parse(
      readFileSync(`${migrationsDir}meta/0024_snapshot.json`, "utf8"),
    ) as Snapshot;

    expect(current.prevId).toBe(previous.id);
    expect(current.tables["public.clarification_requests"]).toEqual(
      previous.tables["public.clarification_requests"],
    );
  });
});
