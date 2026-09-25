import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalSubjectKey } from "@shared/contracts";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const MIGRATION = "0073_pr_subject_key_normalize.sql";

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

function applyMigration(client: PGlite): Promise<unknown> {
  return client.exec(readFileSync(`${migrationsDir}${MIGRATION}`, "utf8"));
}

async function rows<T>(client: PGlite, query: string): Promise<T[]> {
  return (await client.query<T>(query)).rows;
}

// One pull request, as GitHub's webhook spells it and as a person pasted it.
const WEBHOOK = "pr:github:Blazity/ai-workflow#7";
const PASTED = "pr:github:blazity/ai-workflow#7";
// A pull request whose run is in flight: its journal spells the key this way.
const LIVE = "pr:github:Acme/Live#9";
const OTHER = "pr:github:Blazity/other#8";
// What work_scope.edit wrote for a ticket typed in lower case.
const TICKET_TWIN = "ticket:jira:awp-281";
const TICKET = "ticket:jira:AWP-281";

let client: PGlite;
let definitionId: number;

beforeEach(async () => {
  client = await migrateThrough("0072");
  definitionId = (
    await rows<{ id: number }>(
      client,
      `INSERT INTO workflow_definitions (name, created_by_id, created_by_label)
       VALUES ('PR flow', 'admin', 'Admin') RETURNING id`,
    )
  )[0]!.id;
  await client.exec(`
    INSERT INTO workflow_definition_versions
      (definition_id, version, definition, created_by_id, created_by_label)
    VALUES (${definitionId}, 1, '{}'::jsonb, 'admin', 'Admin');

    INSERT INTO active_runs (subject_key, owner_token, run_id, state, run_kind)
    VALUES ('${LIVE}', 'owner:live', 'run-live', 'bound', 'pr_trigger');
    INSERT INTO active_run_sandboxes (subject_key, owner_token, sandbox_id)
    VALUES ('${LIVE}', 'owner:live', 'sbx-live');

    INSERT INTO workflow_runs (run_id, subject_key, ticket_key) VALUES
      ('run-webhook', '${WEBHOOK}', NULL),
      ('run-pasted', '${PASTED}', NULL),
      ('run-live', '${LIVE}', NULL),
      ('run-ticket', '${TICKET}', 'AWP-281'),
      ('run-schedule', 'schedule:sch_1:1790330400000', NULL),
      ('run-webhook-delivery', 'webhook:wh_1:Order-9', NULL),
      ('run-gitlab', 'pr:gitlab:Group/Sub/App#12', NULL),
      ('run-typed', ' ', NULL);
  `);
});

describe("0073 PR subject key normalization", () => {
  it("respells every stored key the way canonicalSubjectKey does, and nothing else", async () => {
    await applyMigration(client);

    const runs = await rows<{ run_id: string; subject_key: string }>(
      client,
      "SELECT run_id, subject_key FROM workflow_runs ORDER BY run_id",
    );
    expect(Object.fromEntries(runs.map((row) => [row.run_id, row.subject_key]))).toEqual({
      "run-webhook": PASTED,
      "run-pasted": PASTED,
      // A run in flight keeps the key its journal carries.
      "run-live": LIVE,
      "run-ticket": TICKET,
      "run-schedule": "schedule:sch_1:1790330400000",
      "run-webhook-delivery": "webhook:wh_1:Order-9",
      "run-gitlab": "pr:gitlab:group/sub/app#12",
      "run-typed": " ",
    });
    // The SQL rule and the TypeScript rule agree on every key that moved.
    for (const row of runs.filter((run) => run.run_id !== "run-live" && run.run_id !== "run-typed")) {
      expect(canonicalSubjectKey(row.subject_key)).toBe(row.subject_key);
    }
    await expect(
      rows(client, "SELECT subject_key, owner_token, run_id, state FROM active_runs"),
    ).resolves.toEqual([
      { subject_key: LIVE, owner_token: "owner:live", run_id: "run-live", state: "bound" },
    ]);
    await expect(
      rows(client, "SELECT subject_key, sandbox_id FROM active_run_sandboxes"),
    ).resolves.toEqual([{ subject_key: LIVE, sandbox_id: "sbx-live" }]);
  });

  it("merges two records of one pull request into one, keeping the entry the write path would keep", async () => {
    await client.exec(`
      INSERT INTO work_scopes (subject_key, version, updated_at) VALUES
        ('${WEBHOOK}', 2, '2026-09-20T10:05:00Z'),
        ('${PASTED}', 1, '2026-09-20T09:00:00Z'),
        ('${LIVE}', 1, '2026-09-20T08:00:00Z');
      INSERT INTO work_scope_entries
        (subject_key, repository_key, state, origin, origin_rank, rationale, decided_by, decided_at)
      VALUES
        ('${WEBHOOK}', 'github:blazity/ai-workflow', 'selected', 'trigger_policy', 3,
         'the trigger names it', '{"kind":"workflow"}', '2026-09-20T10:00:00Z'),
        ('${WEBHOOK}', 'github:blazity/docs', 'excluded', 'person', 0,
         'not the docs', '{"kind":"person"}', '2026-09-20T10:05:00Z'),
        ('${PASTED}', 'github:blazity/ai-workflow', 'excluded', 'person', 0,
         'a person said no', '{"kind":"person"}', '2026-09-20T09:00:00Z'),
        ('${PASTED}', 'github:blazity/docs', 'selected', 'inferred', 4,
         'a guess', '{"kind":"workflow"}', '2026-09-20T11:00:00Z'),
        ('${LIVE}', 'github:acme/live', 'selected', 'trigger_policy', 3,
         'the trigger names it', '{"kind":"workflow"}', '2026-09-20T08:00:00Z');
      INSERT INTO work_scope_trail (subject_key, run_id, kind, repository_key, event) VALUES
        ('${WEBHOOK}', 'run-webhook', 'entry_written', 'github:blazity/ai-workflow', '{"kind":"entry_written"}'),
        ('${PASTED}', 'run-pasted', 'entry_written', 'github:blazity/docs', '{"kind":"entry_written"}'),
        ('${LIVE}', 'run-live', 'entry_written', 'github:acme/live', '{"kind":"entry_written"}');
    `);

    await applyMigration(client);

    await expect(
      rows(client, "SELECT subject_key, version FROM work_scopes ORDER BY subject_key"),
    ).resolves.toEqual([
      { subject_key: LIVE, version: 1 },
      // Every applied write moved one of the two by one: 2 + 1.
      { subject_key: PASTED, version: 3 },
    ]);
    await expect(
      rows(
        client,
        `SELECT subject_key, repository_key, state, origin, rationale
         FROM work_scope_entries ORDER BY subject_key, repository_key`,
      ),
    ).resolves.toEqual([
      {
        subject_key: LIVE,
        repository_key: "github:acme/live",
        state: "selected",
        origin: "trigger_policy",
        rationale: "the trigger names it",
      },
      // A person's decision outranks the trigger's, whichever record held it.
      {
        subject_key: PASTED,
        repository_key: "github:blazity/ai-workflow",
        state: "excluded",
        origin: "person",
        rationale: "a person said no",
      },
      {
        subject_key: PASTED,
        repository_key: "github:blazity/docs",
        state: "excluded",
        origin: "person",
        rationale: "not the docs",
      },
    ]);
    await expect(
      rows(client, "SELECT subject_key, run_id FROM work_scope_trail ORDER BY id"),
    ).resolves.toEqual([
      { subject_key: PASTED, run_id: "run-webhook" },
      { subject_key: PASTED, run_id: "run-pasted" },
      { subject_key: LIVE, run_id: "run-live" },
    ]);
  });

  it("moves a ticket's record typed in lower case onto the record runs read", async () => {
    await client.exec(`
      INSERT INTO work_scopes (subject_key, version, updated_at)
      VALUES ('${TICKET_TWIN}', 1, '2026-09-23T10:00:00Z');
      INSERT INTO work_scope_entries
        (subject_key, repository_key, state, origin, origin_rank, rationale, decided_by, decided_at)
      VALUES ('${TICKET_TWIN}', 'github:blazity/aiw-workflow-demo', 'excluded', 'person', 0,
              'exclude demo', '{"kind":"person"}', '2026-09-23T10:00:00Z');
    `);

    await applyMigration(client);

    await expect(rows(client, "SELECT subject_key, version FROM work_scopes")).resolves.toEqual([
      { subject_key: TICKET, version: 1 },
    ]);
    await expect(
      rows(client, "SELECT subject_key, repository_key, state FROM work_scope_entries"),
    ).resolves.toEqual([
      { subject_key: TICKET, repository_key: "github:blazity/aiw-workflow-demo", state: "excluded" },
    ]);
  });

  it("keeps one pending delivery per pull request and leaves a colliding one as it was", async () => {
    await client.exec(`
      INSERT INTO trigger_deliveries
        (provider, delivery_id, producer, trigger_type, subject_key, head_sha,
         definition_id, definition_version, payload, pending, created_at)
      VALUES
        ('github', 'settled', 'alice', 'trigger_pr_created', '${WEBHOOK}', 'h0', ${definitionId}, 1, '{}', false, '2026-09-20T09:00:00Z'),
        ('github', 'held', 'alice', 'trigger_pr_updated', '${PASTED}', 'h1', ${definitionId}, 1, '{}', true, '2026-09-20T09:30:00Z'),
        ('github', 'colliding', 'alice', 'trigger_pr_updated', '${WEBHOOK}', 'h2', ${definitionId}, 1, '{}', true, '2026-09-20T10:00:00Z'),
        ('github', 'waiting-old', 'alice', 'trigger_pr_created', '${OTHER}', 'h3', ${definitionId}, 1, '{}', true, '2026-09-20T10:00:00Z'),
        ('github', 'waiting-new', 'alice', 'trigger_pr_created', 'pr:github:BLAZITY/other#8', 'h4', ${definitionId}, 1, '{}', true, '2026-09-20T11:00:00Z'),
        ('github', 'behind-live', 'alice', 'trigger_pr_updated', '${LIVE}', 'h5', ${definitionId}, 1, '{}', true, '2026-09-20T11:00:00Z');
    `);

    await applyMigration(client);

    const deliveries = await rows<{ delivery_id: string; subject_key: string; pending: boolean }>(
      client,
      "SELECT delivery_id, subject_key, pending FROM trigger_deliveries ORDER BY delivery_id",
    );
    expect(deliveries).toEqual([
      { delivery_id: "behind-live", subject_key: LIVE, pending: true },
      { delivery_id: "colliding", subject_key: WEBHOOK, pending: true },
      { delivery_id: "held", subject_key: PASTED, pending: true },
      { delivery_id: "settled", subject_key: PASTED, pending: false },
      { delivery_id: "waiting-new", subject_key: "pr:github:BLAZITY/other#8", pending: true },
      { delivery_id: "waiting-old", subject_key: "pr:github:blazity/other#8", pending: true },
    ]);
  });

  it("respells questions, approvals, threads and branches a pull request run keyed by its ticket key", async () => {
    await client.exec(`
      INSERT INTO clarification_requests (id, ticket_key, subject_key, run_id, questions, status) VALUES
        ('q-answered', '${WEBHOOK}', '${WEBHOOK}', 'run-webhook', '["which repo?"]', 'answered'),
        ('q-live', '${LIVE}', '${LIVE}', 'run-live', '["which repo?"]', 'pending'),
        ('q-orphan', NULL, '${OTHER}', 'run-other', '["which repo?"]', 'pending'),
        ('q-ticket', 'AWP-281', '${TICKET}', 'run-ticket', '["which repo?"]', 'pending');
      INSERT INTO approval_requests (id, ticket_key, definition_id, run_id, plan, status) VALUES
        ('a-1', '${WEBHOOK}', ${definitionId}, 'run-webhook', '{"markdown":"plan"}', 'rejected');
      INSERT INTO thread_parents (ticket_key, message_id) VALUES
        ('${WEBHOOK}', 'ts-webhook'), ('${LIVE}', 'ts-live'), ('AWP-281', 'ts-ticket');
      INSERT INTO workflow_owned_branches (ticket_key, provider, repo_path, branch_name) VALUES
        ('${WEBHOOK}', 'github', 'Blazity/ai-workflow', 'ai-workflow/pr-7'),
        ('AWP-281', 'github', 'Blazity/ai-workflow', 'ai-workflow/awp-281');
    `);

    await applyMigration(client);

    await expect(
      rows(client, "SELECT id, ticket_key, subject_key, status FROM clarification_requests ORDER BY id"),
    ).resolves.toEqual([
      { id: "q-answered", ticket_key: PASTED, subject_key: PASTED, status: "answered" },
      { id: "q-live", ticket_key: LIVE, subject_key: LIVE, status: "pending" },
      { id: "q-orphan", ticket_key: null, subject_key: "pr:github:blazity/other#8", status: "pending" },
      { id: "q-ticket", ticket_key: "AWP-281", subject_key: TICKET, status: "pending" },
    ]);
    await expect(rows(client, "SELECT ticket_key FROM approval_requests")).resolves.toEqual([
      { ticket_key: PASTED },
    ]);
    await expect(
      rows(client, "SELECT ticket_key, message_id FROM thread_parents ORDER BY message_id"),
    ).resolves.toEqual([
      { ticket_key: LIVE, message_id: "ts-live" },
      { ticket_key: "AWP-281", message_id: "ts-ticket" },
      { ticket_key: PASTED, message_id: "ts-webhook" },
    ]);
    // The key moves; the repository keeps the provider's spelling, which
    // lookups already compare without regard to case.
    await expect(
      rows(client, "SELECT ticket_key, repo_path FROM workflow_owned_branches ORDER BY branch_name"),
    ).resolves.toEqual([
      { ticket_key: "AWP-281", repo_path: "Blazity/ai-workflow" },
      { ticket_key: PASTED, repo_path: "Blazity/ai-workflow" },
    ]);
  });

  it("sums one pull request's auto-fix budgets and cases the review ledger's repository down", async () => {
    await client.exec(`
      INSERT INTO workflow_runs (run_id) VALUES ('run-other');
      INSERT INTO pr_autofix_attempts (definition_id, node_id, provider, repo_path, pr_number, attempts, updated_at) VALUES
        ('def_1', 'fix', 'github', 'Blazity/ai-workflow', 7, 2, '2026-09-20T10:00:00Z'),
        ('def_1', 'fix', 'github', 'blazity/ai-workflow', 7, 1, '2026-09-20T11:00:00Z'),
        ('def_1', 'fix', 'github', 'Acme/Solo', 3, 1, '2026-09-20T09:00:00Z'),
        ('def_1', 'fix', 'github', 'acme/untouched', 4, 5, '2026-09-20T09:00:00Z');
      INSERT INTO workflow_pr_review_publications
        (id, run_id, node_id, attempt, activation_scope, provider, repository, pr_number,
         head_sha, content_hash, decision, summary, state, created_at)
      VALUES
        ('p-published', 'run-webhook', 'review', 1, 'root', 'github', 'Blazity/ai-workflow', 7,
         'h1', 'c1', 'approve', 'ok', 'published', '2026-09-20T10:00:00Z'),
        ('p-other-content', 'run-pasted', 'review', 1, 'root', 'github', 'Blazity/ai-workflow', 7,
         'h1', 'c2', 'approve', 'ok', 'pending', '2026-09-20T10:30:00Z'),
        ('p-held', 'run-other', 'review', 1, 'root', 'github', 'blazity/other', 8,
         'h9', 'c9', 'approve', 'ok', 'pending', '2026-09-20T10:00:00Z'),
        ('p-duplicate', 'run-other', 'review', 2, 'root', 'github', 'Blazity/other', 8,
         'h9', 'c9', 'approve', 'ok', 'published', '2026-09-20T11:00:00Z');
    `);

    await applyMigration(client);

    await expect(
      rows(
        client,
        "SELECT repo_path, pr_number, attempts FROM pr_autofix_attempts ORDER BY pr_number",
      ),
    ).resolves.toEqual([
      { repo_path: "acme/solo", pr_number: 3, attempts: 1 },
      { repo_path: "acme/untouched", pr_number: 4, attempts: 5 },
      { repo_path: "blazity/ai-workflow", pr_number: 7, attempts: 3 },
    ]);
    await expect(
      rows(client, "SELECT id, repository FROM workflow_pr_review_publications ORDER BY id"),
    ).resolves.toEqual([
      // Same pull request, head and content as a row already under the new
      // spelling: kept as it was rather than deleted.
      { id: "p-duplicate", repository: "Blazity/other" },
      { id: "p-held", repository: "blazity/other" },
      { id: "p-other-content", repository: "blazity/ai-workflow" },
      { id: "p-published", repository: "blazity/ai-workflow" },
    ]);
  });

  it("changes nothing when it runs a second time, and leaves no function behind", async () => {
    await client.exec(`
      INSERT INTO work_scopes (subject_key, version, updated_at) VALUES ('${WEBHOOK}', 2, now());
      INSERT INTO trigger_deliveries
        (provider, delivery_id, producer, trigger_type, subject_key, head_sha,
         definition_id, definition_version, payload, pending)
      VALUES ('github', 'd', 'alice', 'trigger_pr_created', '${WEBHOOK}', 'h', ${definitionId}, 1, '{}', true);
    `);
    await applyMigration(client);
    const snapshot = async () => ({
      runs: await rows(client, "SELECT run_id, subject_key FROM workflow_runs ORDER BY run_id"),
      scopes: await rows(client, "SELECT subject_key, version FROM work_scopes ORDER BY subject_key"),
      deliveries: await rows(client, "SELECT delivery_id, subject_key, pending FROM trigger_deliveries"),
    });
    const first = await snapshot();

    await applyMigration(client);

    await expect(snapshot()).resolves.toEqual(first);
    await expect(
      rows(client, "SELECT proname FROM pg_proc WHERE proname LIKE 'aiw_0073%'"),
    ).resolves.toEqual([]);
  });
});
