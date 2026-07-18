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

describe("0028 PR-correlation migration", () => {
  it("backfills the confirmed head while keeping unknown legacy targets fail-closed", async () => {
    const client = await migrateThrough("0027");
    await client.exec(`
      INSERT INTO workflow_owned_branches
        (ticket_key, provider, repo_path, branch_name, pr_id, pr_url,
         pr_branch_name, published_head_sha)
      VALUES
        ('AIW-1', 'github', 'acme/app', 'ai/AIW-1', 42,
         'https://github.com/acme/app/pull/42', 'ai/AIW-1', 'head-42'),
        ('AIW-2', 'gitlab', 'acme/api', 'ai/AIW-2', NULL,
         NULL, NULL, 'head-2');
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0028_tired_mastermind.sql`, "utf8"),
    );

    const rows = await client.query<{
      ticket_key: string;
      target_branch: string | null;
      pr_published_head_sha: string | null;
      pr_target_branch: string | null;
      pr_correlation_pending: boolean;
    }>(`
      SELECT ticket_key, target_branch, pr_published_head_sha,
             pr_target_branch, pr_correlation_pending
      FROM workflow_owned_branches
      ORDER BY ticket_key
    `);
    expect(rows.rows).toEqual([
      {
        ticket_key: "AIW-1",
        target_branch: null,
        pr_published_head_sha: "head-42",
        pr_target_branch: null,
        pr_correlation_pending: false,
      },
      {
        ticket_key: "AIW-2",
        target_branch: null,
        pr_published_head_sha: null,
        pr_target_branch: null,
        pr_correlation_pending: false,
      },
    ]);
  });

  it("chains from 0027 with all four correlation columns", () => {
    type Snapshot = {
      id: string;
      prevId: string;
      tables: Record<
        string,
        {
          columns?: Record<
            string,
            { name: string; notNull: boolean; default?: unknown }
          >;
        }
      >;
    };
    const previous = JSON.parse(
      readFileSync(`${migrationsDir}meta/0027_snapshot.json`, "utf8"),
    ) as Snapshot;
    const current = JSON.parse(
      readFileSync(`${migrationsDir}meta/0028_snapshot.json`, "utf8"),
    ) as Snapshot;

    expect(current.prevId).toBe(previous.id);
    expect(current.tables["public.workflow_owned_branches"]?.columns).toMatchObject({
      target_branch: { name: "target_branch", notNull: false },
      pr_published_head_sha: { name: "pr_published_head_sha", notNull: false },
      pr_target_branch: { name: "pr_target_branch", notNull: false },
      pr_correlation_pending: {
        name: "pr_correlation_pending",
        notNull: true,
        default: false,
      },
    });
  });
});
