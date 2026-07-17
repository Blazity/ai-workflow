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

const definition = (x: number, y: number, trigger: string) =>
  JSON.stringify({
    schemaVersion: 1,
    nodes: [
      { id: "trigger", type: trigger, x, y, params: {}, inputs: {} },
      { id: "done", type: "terminate", x: x + 100, y, params: { terminalStatus: "done" }, inputs: {} },
    ],
    edges: [{ from: "trigger", to: "done" }],
  });

describe("0020 workflow definition lifecycle migration", () => {
  it("backfills drafts, layouts, deployed pointers, history, and preserves only the fresh fallback", async () => {
    const client = await migrateThrough("0019");
    await client.exec(`
      INSERT INTO workflow_definitions
        (name, enabled, trigger_types, created_by_id, created_by_label)
      VALUES
        ('Enabled flow', true, '{trigger_pr_created}', 'admin', 'Admin'),
        ('Disabled flow', false, '{trigger_pr_review}', 'admin', 'Admin');

      INSERT INTO workflow_definition_versions
        (definition_id, version, definition, created_by_id, created_by_label)
      VALUES
        (2, 1, '${definition(10, 20, "trigger_pr_created")}'::jsonb, 'admin', 'Admin'),
        (2, 2, '${definition(30, 40, "trigger_pr_created")}'::jsonb, 'admin', 'Admin'),
        (3, 1, '${definition(50, 60, "trigger_pr_review")}'::jsonb, 'admin', 'Admin');
    `);

    await client.exec(readFileSync(`${migrationsDir}0020_workflow_definition_lifecycle.sql`, "utf8"));

    const definitions = await client.query<{
      id: number;
      draft: unknown;
      draft_revision: number;
      layout: { nodes: Record<string, { x: number; y: number }> };
      layout_revision: number;
      deployed_version: number | null;
      builtin_fallback: boolean;
    }>(`
      SELECT id, draft, draft_revision, layout, layout_revision, deployed_version, builtin_fallback
      FROM workflow_definitions ORDER BY id
    `);

    expect(definitions.rows[0]).toMatchObject({
      id: 1,
      draft: null,
      draft_revision: 0,
      layout: { nodes: {} },
      layout_revision: 0,
      deployed_version: null,
      builtin_fallback: true,
    });
    expect(definitions.rows[1]).toMatchObject({
      id: 2,
      draft_revision: 1,
      layout: { nodes: { trigger: { x: 30, y: 40 }, done: { x: 130, y: 40 } } },
      layout_revision: 1,
      deployed_version: 2,
      builtin_fallback: false,
    });
    expect(definitions.rows[2]).toMatchObject({
      id: 3,
      draft_revision: 1,
      layout: { nodes: { trigger: { x: 50, y: 60 }, done: { x: 150, y: 60 } } },
      layout_revision: 1,
      deployed_version: null,
      builtin_fallback: false,
    });

    const history = await client.query<{
      definition_id: number;
      selected_version: number;
      previous_version: number | null;
      action: string;
    }>(`
      SELECT definition_id, selected_version, previous_version, action
      FROM workflow_definition_deployments ORDER BY id
    `);
    expect(history.rows).toEqual([
      { definition_id: 2, selected_version: 2, previous_version: null, action: "migration" },
    ]);

    await expect(
      client.exec("UPDATE workflow_definitions SET deployed_version = 999 WHERE id = 2"),
    ).rejects.toThrow();
  });
});
