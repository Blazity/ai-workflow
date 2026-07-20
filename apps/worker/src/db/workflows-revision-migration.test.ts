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

describe("0020 workflows revision migration", () => {
  it("upgrades the merged MVP in one data-preserving migration", async () => {
    const client = await migrateThrough("0019");
    const inserted = await client.query<{ id: number }>(`
      INSERT INTO workflow_definitions
        (name, enabled, trigger_types, created_by_id, created_by_label)
      VALUES
        ('Revision flow', true, '{trigger_ticket_ai}', 'admin', 'Admin')
      RETURNING id
    `);
    const definitionId = inserted.rows[0]!.id;
    const definition = JSON.stringify({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 12, y: 34, params: {}, inputs: {} },
        { id: "done", type: "terminate", x: 56, y: 78, params: {}, inputs: {} },
      ],
      edges: [{ from: "trigger", to: "done" }],
    }).replaceAll("'", "''");
    await client.exec(`
      INSERT INTO workflow_definition_versions
        (definition_id, version, definition, created_by_id, created_by_label)
      VALUES
        (${definitionId}, 1, '${definition}'::jsonb, 'admin', 'Admin'),
        (${definitionId}, 2, '${definition}'::jsonb, 'admin', 'Admin');

      INSERT INTO active_runs (ticket_key, run_id, sandbox_id, run_kind)
      VALUES ('AIW-42', 'run-42', 'sandbox-42', 'ticket');

      INSERT INTO clarification_requests
        (id, ticket_key, run_id, questions, status, dispatched_run_id)
      VALUES
        ('clar-42', 'AIW-42', 'run-42', '["Which option?"]'::jsonb, 'pending', NULL);

      INSERT INTO workflow_runs (run_id, ticket_key, status)
      VALUES ('run-42', 'AIW-42', 'running');

      INSERT INTO workflow_owned_branches
        (ticket_key, provider, repo_path, branch_name, pr_id, pr_url, pr_branch_name)
      VALUES
        ('AIW-42', 'github', 'acme/app', 'blazebot/AIW-42', 42,
         'https://github.com/acme/app/pull/42', 'blazebot/AIW-42');
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0020_workflows_revision.sql`, "utf8"),
    );

    const active = await client.query<{
      subject_key: string;
      ticket_key: string;
      owner_token: string;
      run_id: string;
      state: string;
    }>(`
      SELECT subject_key, ticket_key, owner_token, run_id, state
      FROM active_runs
    `);
    expect(active.rows).toEqual([{
      subject_key: "ticket:jira:AIW-42",
      ticket_key: "AIW-42",
      owner_token: "legacy:run-42",
      run_id: "run-42",
      state: "bound",
    }]);
    expect((await client.query(`SELECT sandbox_id FROM active_run_sandboxes`)).rows)
      .toEqual([{ sandbox_id: "sandbox-42" }]);

    const deployed = await client.query<{
      deployed_version: number;
      layout_revision: number;
      layout: { nodes: Record<string, { x: number; y: number }> };
    }>(`
      SELECT deployed_version, layout_revision, layout
      FROM workflow_definitions
      WHERE id = ${definitionId}
    `);
    expect(deployed.rows[0]).toEqual({
      deployed_version: 2,
      layout_revision: 1,
      layout: { nodes: { trigger: { x: 12, y: 34 }, done: { x: 56, y: 78 } } },
    });

    const clarification = await client.query<{
      subject_key: string;
      status: string;
      hook_token: string | null;
    }>(`
      SELECT subject_key, status, hook_token FROM clarification_requests
      WHERE id = 'clar-42'
    `);
    expect(clarification.rows).toEqual([{
      subject_key: "ticket:jira:AIW-42",
      status: "superseded",
      hook_token: null,
    }]);
    expect((await client.query(`SELECT subject_key FROM workflow_runs WHERE run_id = 'run-42'`)).rows)
      .toEqual([{ subject_key: "ticket:jira:AIW-42" }]);
    expect((await client.query(`
      SELECT published_head_sha, target_branch, pr_correlation_pending
      FROM workflow_owned_branches WHERE ticket_key = 'AIW-42'
    `)).rows).toEqual([{
      published_head_sha: null,
      target_branch: null,
      pr_correlation_pending: false,
    }]);

    const removedTables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'pending_trigger_events',
        'publication_attempts',
        'publication_attempt_repositories',
        'ticket_transition_intents',
        'ticket_label_mutation_intents',
        'ticket_cancellation_fences',
        'workflow_definition_deployments'
      )
    `);
    expect(removedTables.rows).toEqual([]);
    const removedColumns = await client.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'active_runs' AND column_name IN (
          'ticket_mutation_version',
          'ticket_provider_calls_in_flight',
          'ticket_cancellation_reconciled_version'
        )) OR
        (table_name = 'clarification_requests' AND column_name IN (
          'owner_token',
          'checkpoint_state',
          'workspace_manifest',
          'successor_owner_token',
          'dispatched_run_id'
        ))
      )
    `);
    expect(removedColumns.rows).toEqual([]);
    expect((await client.query(`
      SELECT proname FROM pg_proc WHERE proname IN (
        'sync_ticket_provider_call_fence',
        'guard_active_run_ticket_provider_calls',
        'guard_ticket_cancellation_protocol',
        'begin_active_run_cancellation'
      )
    `)).rows).toEqual([]);
  }, 30_000);
});
