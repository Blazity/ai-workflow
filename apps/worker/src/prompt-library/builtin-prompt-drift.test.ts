import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PROMPTS, type WorkflowDefinitionV2 } from "@shared/contracts";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { defaultWorkflowDefinitionV2 } from "../workflow-definition/default.js";
import {
  describeBuiltInPromptDrift,
  findBuiltInPromptDrift,
} from "./builtin-prompt-drift.js";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const resyncSql = readFileSync(
  `${migrationsDir}0037_builtin_prompt_resync.sql`,
  "utf8",
);

interface TestDatabase {
  client: PGlite;
  db: Db;
}

/** A database whose migrations stop after `lastPrefix`, so the state a resync
 *  migration has to correct can be built and then inspected before and after. */
async function migrateThrough(lastPrefix: string): Promise<TestDatabase> {
  const client = new PGlite();
  for (const file of migrationFiles) {
    if (file.slice(0, 4) > lastPrefix) break;
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return { client, db: drizzle({ client, schema }) as unknown as Db };
}

/** Stores `definition` as a definition whose deployed pointer selects it, which
 *  is exactly what a dispatch loads (workflows/definition-step.ts). Left
 *  disabled: the drift check deliberately covers every deployed definition,
 *  because manual dispatch and a pinned definitionId run disabled ones too. */
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

async function appendVersion(
  client: PGlite,
  slug: string,
  version: number,
  body: string,
  author: { id: string; label: string },
): Promise<void> {
  await client.query(
    `INSERT INTO prompt_library_versions
       (prompt_id, version, body, created_by_id, created_by_label, restored_from_version)
     SELECT id, $2, $3, $4, $5, NULL FROM prompt_library WHERE slug = $1`,
    [slug, version, body, author.id, author.label],
  );
}

async function readVersion(
  client: PGlite,
  slug: string,
  version: number,
): Promise<{ body: string; version_xmin: string }> {
  const res = await client.query<{ body: string; version_xmin: string }>(
    `SELECT v.body, v.xmin::text AS version_xmin
     FROM prompt_library p JOIN prompt_library_versions v ON v.prompt_id = p.id
     WHERE p.slug = $1 AND v.version = $2`,
    [slug, version],
  );
  return res.rows[0]!;
}

const PLATFORM = { id: "system", label: "System migration" };
const CUSTOMER = { id: "u_admin", label: "admin@blazity.com" };

/** The body `implement` version 2 holds on production: the code constant as it
 *  stood on 2026-07-29, frozen while the constant moved on. Any text that is not
 *  the current constant reproduces the shape; this one keeps the fixture honest
 *  about what the row actually is. */
const STALE_PLATFORM_IMPLEMENT_BODY =
  "# Instructions\n\nYou are an AI coding agent. (platform text as of 2026-07-29)\n";

function definitionPinning(
  pins: Record<string, string>,
  options: { includeReview?: boolean } = {},
): WorkflowDefinitionV2 {
  const shipped = defaultWorkflowDefinitionV2({
    includeReview: options.includeReview ?? true,
    includeLeakReview: false,
    provider: "claude",
  });
  let json = JSON.stringify(shipped);
  for (const [from, to] of Object.entries(pins)) {
    json = json.replaceAll(from, to);
  }
  return JSON.parse(json) as WorkflowDefinitionV2;
}

/**
 * The production shape, reproduced in the order it happened.
 *
 * A platform-authored `implement` version 2 and the customer's own `review`
 * versions 2 and 3 all exist before the 0034 and 0036 resyncs run, so both of
 * those migrations skip `implement` and `review` entirely and leave version 1 at
 * the original 0021 seed. The deployed definition then pins implement@2 rather
 * than @1, and it carries no review node.
 *
 * That is measured, not assumed: the run that started at 12:24 UTC recorded a
 * prompt manifest of exactly two entries, research-plan requested 1 resolved 1
 * and implement requested 2 resolved 2. `review` is absent from the manifest
 * because the active definition has no review block, so the customer's review
 * versions sit in the library unreferenced.
 */
async function productionShape(): Promise<TestDatabase> {
  const database = await migrateThrough("0033");
  await appendVersion(
    database.client,
    "implement",
    2,
    STALE_PLATFORM_IMPLEMENT_BODY,
    PLATFORM,
  );
  await appendVersion(
    database.client,
    "review",
    2,
    "Our own review checklist.",
    CUSTOMER,
  );
  await appendVersion(
    database.client,
    "review",
    3,
    "Our own review checklist, revised.",
    CUSTOMER,
  );
  for (const file of migrationFiles) {
    if (file.slice(0, 4) <= "0033" || file.slice(0, 4) > "0036") continue;
    await database.client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  await deployDefinition(
    database.client,
    "Deployed ticket workflow",
    definitionPinning(
      { "{{prompt:implement@1}}": "{{prompt:implement@2}}" },
      { includeReview: false },
    ),
  );
  return database;
}

describe("findBuiltInPromptDrift", () => {
  it("finds every built-in pin of the shipped definition and reports no drift", async () => {
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

    const report = await findBuiltInPromptDrift(db);

    // Asserted before the drift check itself: a walk that silently found no pin
    // would report no drift too, and that is the one way this alarm could be
    // worthless. This is also the alarm that goes red when a constant is edited
    // without a resync migration.
    expect(
      report.pins
        .map((pin) => `${pin.slug}@${pin.resolvedVersion}`)
        .sort(),
    ).toEqual(["implement@1", "research-plan@1", "review@1"]);
    expect(report.pins.every((pin) => pin.authorship === "platform")).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(report.customerAuthored).toEqual([]);
    expect(describeBuiltInPromptDrift(report)).toBe("");
    expect(report.drift).toEqual([]);
  });

  it("fails on the production shape: a platform version 2 the active definition pins", async () => {
    const { db } = await productionShape();

    const report = await findBuiltInPromptDrift(db);

    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({
      slug: "implement",
      requestedVersion: 2,
      resolvedVersion: 2,
      authorship: "platform",
      matchesConstant: false,
      nodeId: "implementation",
      field: "prompt",
      definitionName: "Deployed ticket workflow",
    });
    expect(describeBuiltInPromptDrift(report)).toContain("implement@2");
    // Exactly the manifest the 12:24 UTC run recorded, so this fixture is the
    // live shape and not a hypothetical one.
    expect(
      report.pins.map((pin) => ({
        slug: pin.slug,
        requested: pin.requestedVersion,
        resolved: pin.resolvedVersion,
      })),
    ).toEqual([
      { slug: "research-plan", requested: 1, resolved: 1 },
      { slug: "implement", requested: 2, resolved: 2 },
    ]);
    // The customer's review versions exist but the active definition has no
    // review block, so nothing resolves them.
    expect(report.customerAuthored).toEqual([]);
    expect(report.unresolved).toEqual([]);
  });

  it("is cleared by the 0037 resync, which leaves every customer version alone", async () => {
    const { client, db } = await productionShape();
    const customerBefore = [
      await readVersion(client, "review", 2),
      await readVersion(client, "review", 3),
    ];

    await client.exec(resyncSql);

    expect(await findBuiltInPromptDrift(db)).toMatchObject({
      drift: [],
      unresolved: [],
    });
    expect((await readVersion(client, "implement", 2)).body).toBe(
      DEFAULT_AGENT_PROMPTS.implement,
    );
    // Version 1 was stale too (0034 and 0036 vetoed the whole prompt as soon as
    // a version above 1 existed), and the shipped template still pins @1, so it
    // has to be corrected as well.
    expect((await readVersion(client, "implement", 1)).body).toBe(
      DEFAULT_AGENT_PROMPTS.implement,
    );
    expect((await readVersion(client, "review", 1)).body).toBe(
      DEFAULT_AGENT_PROMPTS.review,
    );
    // Not merely equal by value: the row-version stamp proves the customer's
    // rows were not rewritten at all, not even to an identical value.
    expect([
      await readVersion(client, "review", 2),
      await readVersion(client, "review", 3),
    ]).toEqual(customerBefore);
  });

  it("separates a customer-authored version a definition pins from drift", async () => {
    const { client, db } = await productionShape();
    await deployDefinition(
      client,
      "Forked review workflow",
      definitionPinning({ "{{prompt:review@1}}": "{{prompt:review@3}}" }),
    );

    const report = await findBuiltInPromptDrift(db);

    expect(report.customerAuthored).toHaveLength(1);
    expect(report.customerAuthored[0]).toMatchObject({
      slug: "review",
      requestedVersion: 3,
      resolvedVersion: 3,
      authorship: "customer",
      matchesConstant: false,
      definitionName: "Forked review workflow",
    });
    // Customer text never inflates the drift list, so the drift assertion never
    // had to be relaxed to tolerate a legitimate fork. Both platform pins are
    // reported: @2 from the live definition and @1, which 0034 and 0036 also
    // left at the 0021 seed, from the second one.
    expect(
      report.drift
        .map((pin) => `${pin.definitionName}:${pin.slug}@${pin.resolvedVersion}`)
        .sort(),
    ).toEqual([
      "Deployed ticket workflow:implement@2",
      "Forked review workflow:implement@1",
    ]);
  });

  it("reports a pin no version satisfies instead of passing silently", async () => {
    const { client, db } = await migrateThrough("9999");
    await deployDefinition(
      client,
      "Deployed ticket workflow",
      definitionPinning({ "{{prompt:implement@1}}": "{{prompt:implement@9}}" }),
    );

    const report = await findBuiltInPromptDrift(db);

    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]).toMatchObject({
      target: "implement",
      requestedVersion: 9,
      reason: "prompt has no version 9",
      nodeId: "implementation",
    });
  });

  it("follows a built-in nested inside a prompt the definition pins", async () => {
    const { client, db } = await migrateThrough("0036");
    await client.query(
      `INSERT INTO prompt_library (name, slug, created_by_id, created_by_label)
       VALUES ('House style', 'house-style', $1, $2)`,
      [CUSTOMER.id, CUSTOMER.label],
    );
    await appendVersion(
      client,
      "house-style",
      1,
      "Follow our house style.\n\n{{prompt:implement@2}}",
      CUSTOMER,
    );
    await appendVersion(
      client,
      "implement",
      2,
      STALE_PLATFORM_IMPLEMENT_BODY,
      PLATFORM,
    );
    await deployDefinition(
      client,
      "Deployed ticket workflow",
      definitionPinning({
        "{{prompt:implement@1}}": "{{prompt:house-style@1}}",
      }),
    );

    const report = await findBuiltInPromptDrift(db);

    expect(
      report.drift.map((pin) => `${pin.slug}@${pin.resolvedVersion}`),
    ).toEqual(["implement@2"]);
    expect(report.customerAuthored).toEqual([]);
  });

  it("skips an archived definition and one with no deployed version", async () => {
    const { client, db } = await migrateThrough("0036");
    await appendVersion(
      client,
      "implement",
      2,
      STALE_PLATFORM_IMPLEMENT_BODY,
      PLATFORM,
    );
    const pinning = definitionPinning({
      "{{prompt:implement@1}}": "{{prompt:implement@2}}",
    });
    const archived = await deployDefinition(client, "Archived", pinning);
    await client.query(
      `UPDATE workflow_definitions SET archived_at = now() WHERE id = $1`,
      [archived],
    );
    const draft = await deployDefinition(client, "Draft", pinning);
    await client.query(
      `UPDATE workflow_definitions SET deployed_version = NULL WHERE id = $1`,
      [draft],
    );

    expect(await findBuiltInPromptDrift(db)).toMatchObject({
      pins: [],
      drift: [],
    });
  });
});
