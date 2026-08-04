import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { defaultWorkflowDefinitionV2 } from "../workflow-definition/default.js";
import {
  assertNoBuiltInPromptDrift,
  BuiltInPromptDriftError,
  evaluateBuiltInPromptDriftGate,
} from "./builtin-prompt-drift-gate.js";
import { findBuiltInPromptDrift } from "./builtin-prompt-drift.js";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

interface TestDatabase {
  client: PGlite;
  db: Db;
}

async function migrateThrough(lastPrefix: string): Promise<TestDatabase> {
  const client = new PGlite();
  for (const file of migrationFiles) {
    if (file.slice(0, 4) > lastPrefix) break;
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return { client, db: drizzle({ client, schema }) as unknown as Db };
}

/** Migration 0013's versionless enabled ticket definition, which the check walks
 *  as the fresh-install code default. Retired when a fixture needs it out. */
async function retireFreshInstallDefinition(client: PGlite): Promise<void> {
  await client.query(
    `UPDATE workflow_definitions SET enabled = false, archived_at = now() WHERE id = 1`,
  );
}

async function deployDefinition(
  client: PGlite,
  name: string,
  definition: unknown,
): Promise<number> {
  const created = await client.query<{ id: number }>(
    `INSERT INTO workflow_definitions (name, enabled, trigger_types, created_by_id, created_by_label)
     VALUES ($1, false, '{}', 'u_admin', 'Admin') RETURNING id`,
    [name],
  );
  const id = created.rows[0]!.id;
  await client.query(
    `INSERT INTO workflow_definition_versions (definition_id, version, definition, created_by_id, created_by_label)
     VALUES ($1, 1, $2, 'u_admin', 'Admin')`,
    [id, JSON.stringify(definition)],
  );
  await client.query(
    `UPDATE workflow_definitions SET deployed_version = 1 WHERE id = $1`,
    [id],
  );
  return id;
}

async function appendPlatformVersion(
  client: PGlite,
  slug: string,
  version: number,
  body: string,
): Promise<void> {
  await client.query(
    `INSERT INTO prompt_library_versions
       (prompt_id, version, body, created_by_id, created_by_label, restored_from_version)
     SELECT id, $2, $3, 'system', 'System migration', NULL
     FROM prompt_library WHERE slug = $1`,
    [slug, version, body],
  );
}

function definitionPinning(pins: Record<string, string>): unknown {
  let json = JSON.stringify(
    defaultWorkflowDefinitionV2({
      includeReview: true,
      includeLeakReview: false,
      provider: "claude",
    }),
  );
  for (const [from, to] of Object.entries(pins)) json = json.replaceAll(from, to);
  return JSON.parse(json);
}

const STALE = "stale platform body that is not the shipped constant";

const codesOf = (result: { failures: { code: string }[] }): string[] =>
  result.failures.map((failure) => failure.code).sort();

describe("built-in prompt drift gate", () => {
  it("passes on the shipped shape and says what it actually inspected", async () => {
    const { client, db } = await migrateThrough("9999");
    await deployDefinition(
      client,
      "Deployed ticket workflow",
      defaultWorkflowDefinitionV2({
        includeReview: true,
        includeLeakReview: false,
        provider: "claude",
      }),
    );

    const result = await assertNoBuiltInPromptDrift(db);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.report.pins.length).toBe(6);
    expect(result.message).toContain("passed");
    expect(result.message).toContain("6 reference(s)");
  });

  it("fails on drift: a platform version a run resolves no longer matches the constant", async () => {
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);
    await appendPlatformVersion(client, "implement", 2, STALE);
    await deployDefinition(
      client,
      "Deployed ticket workflow",
      definitionPinning({ "{{prompt:implement@1}}": "{{prompt:implement@2}}" }),
    );

    const result = evaluateBuiltInPromptDriftGate(
      await findBuiltInPromptDrift(db),
    );

    expect(codesOf(result)).toEqual(["drift"]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("implement@2");
    await expect(assertNoBuiltInPromptDrift(db)).rejects.toBeInstanceOf(
      BuiltInPromptDriftError,
    );
  });

  it("fails on unfixable drift even though the drift list is empty", async () => {
    // This is the case a gate written as `if (report.drift.length)` would wave
    // through: the body is wrong AND no resync migration will ever repair it,
    // because the resync guard requires an unarchived, platform-owned parent row.
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);
    await appendPlatformVersion(client, "implement", 2, STALE);
    await client.query(
      `UPDATE prompt_library SET archived_at = now() WHERE slug = 'implement'`,
    );
    await deployDefinition(
      client,
      "Deployed ticket workflow",
      definitionPinning({ "{{prompt:implement@1}}": "{{prompt:implement@2}}" }),
    );

    const report = await findBuiltInPromptDrift(db);
    const result = evaluateBuiltInPromptDriftGate(report);

    expect(report.drift).toEqual([]);
    expect(report.unfixableDrift).toHaveLength(1);
    expect(codesOf(result)).toEqual(["unfixable_drift"]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no resync migration can");
  });

  it("fails on an incomplete walk even when everything it did read was clean", async () => {
    const { client, db } = await migrateThrough("9999");
    await deployDefinition(client, "Broken shape", {
      schemaVersion: 2,
      nodes: "nope",
    });

    const report = await findBuiltInPromptDrift(db);
    const result = evaluateBuiltInPromptDriftGate(report);

    // The fresh-install default still resolves cleanly, so drift is empty and
    // the walk is non-empty; only the unread snapshot makes this a failure.
    expect(report.drift).toEqual([]);
    expect(report.pins.length).toBeGreaterThan(0);
    expect(codesOf(result)).toEqual(["incomplete_walk"]);
    expect(result.message).toContain("NOT WALKED");
  });

  it("fails when nothing was inspected at all", async () => {
    // No deployed definition, no queue, and the fresh-install row retired: the
    // report is empty, which is the failure that looks exactly like success.
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);

    const report = await findBuiltInPromptDrift(db);
    const result = evaluateBuiltInPromptDriftGate(report);

    expect(report.pins).toEqual([]);
    expect(report.drift).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.definitionsWalked).toBe(0);
    expect(codesOf(result)).toEqual(["nothing_inspected"]);
    expect(result.message).toContain("An empty report is not a clean one");
  });

  it("reports every failing condition at once rather than the first", async () => {
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);
    await appendPlatformVersion(client, "implement", 2, STALE);
    await deployDefinition(
      client,
      "Deployed ticket workflow",
      definitionPinning({ "{{prompt:implement@1}}": "{{prompt:implement@2}}" }),
    );
    await deployDefinition(client, "Broken shape", {
      schemaVersion: 2,
      nodes: "nope",
    });

    const result = evaluateBuiltInPromptDriftGate(
      await findBuiltInPromptDrift(db),
    );

    expect(codesOf(result)).toEqual(["drift", "incomplete_walk"]);
  });
});
