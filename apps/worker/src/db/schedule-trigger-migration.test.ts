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

async function columnsOf(
  client: PGlite,
  table: string,
): Promise<{ column_name: string; is_nullable: string; data_type: string }[]> {
  const result = await client.query<{
    column_name: string;
    is_nullable: string;
    data_type: string;
  }>(
    `
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY column_name
    `,
    [table],
  );
  return result.rows;
}

async function constraintDef(client: PGlite, name: string): Promise<string | undefined> {
  const result = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  return result.rows[0]?.def;
}

async function indexDef(client: PGlite, name: string): Promise<string | undefined> {
  const result = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name],
  );
  return result.rows[0]?.indexdef;
}

/**
 * The webhook trigger migrations (0039 to 0041) shipped without a catalog test,
 * so a schema drift between the drizzle snapshot and what a fresh database
 * actually gets would only surface at deploy time. This closes that gap for the
 * schedule trigger: every structure a store invariant leans on is asserted here
 * against the replayed SQL, not against schema.ts.
 */
describe("0042 schedule trigger migration", () => {
  it("does not exist before 0042", async () => {
    const client = await migrateThrough("0041");
    const result = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('workflow_schedules', 'schedule_occurrences')
    `);
    expect(result.rows).toEqual([]);
  });

  it("creates workflow_schedules with a non-null watermark defaulted to now", async () => {
    const client = await migrateThrough("0042");
    expect(await columnsOf(client, "workflow_schedules")).toEqual([
      {
        column_name: "catch_up_grace_minutes",
        is_nullable: "NO",
        data_type: "integer",
      },
      {
        column_name: "created_at",
        is_nullable: "NO",
        data_type: "timestamp with time zone",
      },
      { column_name: "cron", is_nullable: "NO", data_type: "text" },
      { column_name: "definition_id", is_nullable: "NO", data_type: "integer" },
      {
        column_name: "evaluation_watermark_at",
        is_nullable: "NO",
        data_type: "timestamp with time zone",
      },
      { column_name: "id", is_nullable: "NO", data_type: "text" },
      {
        column_name: "last_evaluated_at",
        is_nullable: "YES",
        data_type: "timestamp with time zone",
      },
      {
        column_name: "last_started_occurrence_at",
        is_nullable: "YES",
        data_type: "timestamp with time zone",
      },
      { column_name: "last_started_run_id", is_nullable: "YES", data_type: "text" },
      { column_name: "node_id", is_nullable: "NO", data_type: "text" },
      { column_name: "overlap_policy", is_nullable: "NO", data_type: "text" },
      {
        column_name: "paused_at",
        is_nullable: "YES",
        data_type: "timestamp with time zone",
      },
      {
        column_name: "revoked_at",
        is_nullable: "YES",
        data_type: "timestamp with time zone",
      },
      { column_name: "timezone", is_nullable: "NO", data_type: "text" },
      {
        column_name: "updated_at",
        is_nullable: "NO",
        data_type: "timestamp with time zone",
      },
    ]);

    // The watermark's NOT NULL plus its now() default is the invariant "a new
    // schedule starts from now" expressed in the catalog: no code path can
    // produce a row that would treat every occurrence since the epoch as missed.
    const watermark = await client.query<{ column_default: string | null }>(`
      SELECT column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workflow_schedules'
        AND column_name = 'evaluation_watermark_at'
    `);
    expect(watermark.rows[0]?.column_default).toBe("now()");

    // Named for what it is. Under its old name (last_occurrence_at) a caller
    // reasonably rendered it as "last run", which was a lie for a freshly minted
    // or freshly resumed schedule. The truthful value is last_started_occurrence_at.
    const stale = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workflow_schedules'
        AND column_name = 'last_occurrence_at'
    `);
    expect(stale.rows).toEqual([]);
  });

  it("guards the authored schedule fields with both check constraints", async () => {
    const client = await migrateThrough("0042");
    const overlap = await constraintDef(
      client,
      "workflow_schedules_overlap_policy_check",
    );
    expect(overlap).toContain("overlap_policy");
    for (const policy of ["skip", "queue", "allow"]) {
      expect(overlap).toContain(`'${policy}'`);
    }
    expect(await constraintDef(client, "workflow_schedules_catch_up_grace_check")).toContain(
      "catch_up_grace_minutes > 0",
    );
  });

  it("keys a schedule to one node of one definition", async () => {
    const client = await migrateThrough("0042");
    expect(await indexDef(client, "workflow_schedules_definition_node_idx")).toContain(
      "UNIQUE INDEX",
    );
    expect(await indexDef(client, "workflow_schedules_definition_node_idx")).toContain(
      "(definition_id, node_id)",
    );
    expect(await constraintDef(client, "workflow_schedules_pkey")).toBe("PRIMARY KEY (id)");
  });

  it("creates schedule_occurrences keyed by the cron instant", async () => {
    const client = await migrateThrough("0042");
    expect(await columnsOf(client, "schedule_occurrences")).toEqual([
      { column_name: "attempt_count", is_nullable: "NO", data_type: "integer" },
      { column_name: "blocking_run_id", is_nullable: "YES", data_type: "text" },
      {
        column_name: "created_at",
        is_nullable: "NO",
        data_type: "timestamp with time zone",
      },
      { column_name: "definition_id", is_nullable: "NO", data_type: "integer" },
      {
        column_name: "definition_version",
        is_nullable: "NO",
        data_type: "integer",
      },
      {
        column_name: "dispatched_at",
        is_nullable: "YES",
        data_type: "timestamp with time zone",
      },
      { column_name: "dropped_count", is_nullable: "NO", data_type: "integer" },
      {
        column_name: "dropped_count_capped",
        is_nullable: "NO",
        data_type: "boolean",
      },
      {
        column_name: "occurrence_at",
        is_nullable: "NO",
        data_type: "timestamp with time zone",
      },
      { column_name: "outcome", is_nullable: "YES", data_type: "text" },
      { column_name: "pending", is_nullable: "NO", data_type: "boolean" },
      { column_name: "run_id", is_nullable: "YES", data_type: "text" },
      { column_name: "schedule_id", is_nullable: "NO", data_type: "text" },
      { column_name: "skip_reason", is_nullable: "YES", data_type: "text" },
      {
        column_name: "updated_at",
        is_nullable: "NO",
        data_type: "timestamp with time zone",
      },
    ]);

    // The composite primary key IS the dedupe key: re-evaluating a cron instant
    // reproduces it exactly, so the second write conflicts instead of running.
    expect(
      await constraintDef(client, "schedule_occurrences_schedule_id_occurrence_at_pk"),
    ).toBe("PRIMARY KEY (schedule_id, occurrence_at)");
  });

  it("allows at most one pending occurrence per schedule", async () => {
    const client = await migrateThrough("0042");
    const def = await indexDef(
      client,
      "schedule_occurrences_one_pending_per_schedule_idx",
    );
    expect(def).toContain("UNIQUE INDEX");
    expect(def).toContain("(schedule_id)");
    // Partial, so a schedule may accumulate any number of settled occurrences
    // while never having two that wait.
    expect(def).toContain("WHERE (pending = true)");
  });

  it("pins an occurrence to the definition version it was admitted under", async () => {
    const client = await migrateThrough("0042");
    const def = await constraintDef(
      client,
      "schedule_occurrences_definition_version_fk",
    );
    expect(def).toContain("FOREIGN KEY (definition_id, definition_version)");
    expect(def).toContain(
      "REFERENCES workflow_definition_versions(definition_id, version)",
    );
  });

  it("cascades occurrences from their schedule and schedules from their definition", async () => {
    const client = await migrateThrough("0042");
    const occurrences = await constraintDef(
      client,
      "schedule_occurrences_schedule_id_workflow_schedules_id_fk",
    );
    expect(occurrences).toContain("REFERENCES workflow_schedules(id) ON DELETE CASCADE");
    const schedules = await constraintDef(
      client,
      "workflow_schedules_definition_id_workflow_definitions_id_fk",
    );
    expect(schedules).toContain("REFERENCES workflow_definitions(id) ON DELETE CASCADE");
  });

  it("indexes occurrences by run id for the run lookup", async () => {
    const client = await migrateThrough("0042");
    const def = await indexDef(client, "schedule_occurrences_run_id_idx");
    expect(def).toContain("(run_id)");
    expect(def).not.toContain("UNIQUE");
  });

  it("constrains the outcome vocabulary while leaving an undecided occurrence legal", async () => {
    const client = await migrateThrough("0042");
    const def = await constraintDef(client, "schedule_occurrences_outcome_check");
    expect(def).toContain("outcome IS NULL");
    for (const outcome of [
      "started",
      "skipped_overlap",
      "skipped_stale",
      "superseded",
      "expired",
      "cancelled",
      "error",
    ]) {
      expect(def).toContain(`'${outcome}'`);
    }
    // Being at capacity is not a decision about an occurrence, it is a reason it
    // has not run yet. Settling it would break the queue policy's promise that a
    // due occurrence waits, so there is deliberately no outcome for it: it is an
    // annotation on a row that stays pending.
    expect(def).not.toContain("skipped_capacity");
  });
});
