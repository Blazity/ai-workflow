import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_PROMPTS,
  WORKFLOW_PROMPT_PARAM_KEYS,
  type WorkflowDefinitionV2,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { defaultWorkflowDefinitionV2 } from "../workflow-definition/default.js";
import { evaluateBuiltInPromptDriftGate } from "./builtin-prompt-drift-gate.js";
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

/**
 * Migration 0013 seeds the enabled ticket definition with no version rows, which
 * is the fresh-install shape definition-step.ts serves the code default graph
 * for. Production has moved past it (definition 1 is archived, definition 2 is
 * deployed), so a fixture reproducing production has to retire it explicitly.
 */
const FRESH_INSTALL_DEFINITION_ID = 1;

async function retireFreshInstallDefinition(client: PGlite): Promise<void> {
  await client.query(
    `UPDATE workflow_definitions SET enabled = false, archived_at = now() WHERE id = $1`,
    [FRESH_INSTALL_DEFINITION_ID],
  );
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
const CUSTOMER = {
  id: "A2FzRCBJ5e0eMggEB4N8D2pcWASWphDW",
  label: "admin@blazity.com",
};

/** The body `implement` version 2 holds on production: the code constant as it
 *  stood on 2026-07-29, frozen while the constant moved on. */
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

const pinKey = (pin: {
  slug: string;
  resolvedVersion: number;
  source: string;
}): string => `${pin.source}:${pin.slug}@${pin.resolvedVersion}`;

/**
 * The production shape, reproduced in the order it happened.
 *
 * A platform-authored `implement` version 2 and the customer's own `review`
 * versions 2 and 3 all exist before the 0034 and 0036 resyncs run, so both of
 * those migrations skip `implement` and `review` entirely and leave version 1 at
 * the original 0021 seed. The deployed definition then pins implement@2 rather
 * than @1, and it carries no review node.
 *
 * Confirmed against production rather than assumed: `implement` versions 1 and 2
 * are both created_by_id 'system' / 'System migration', while `review` 2 and 3
 * carry a real account id and admin@blazity.com. The run that started at 12:24
 * UTC recorded a prompt manifest of exactly two entries, research-plan requested
 * 1 resolved 1 and implement requested 2 resolved 2, with no review entry
 * because the active definition has no review block.
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
  await retireFreshInstallDefinition(database.client);
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
  it("finds every built-in pin of the shipped definition and the fresh-install default", async () => {
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

    // Both selectable snapshots: the deployed v2 graph, and the code default that
    // migration 0013's versionless enabled row still resolves through.
    expect(report.definitionsWalked).toBe(2);
    expect(report.skipped).toEqual([]);
    expect(report.pins.map(pinKey).sort()).toEqual([
      "deployed:implement@1",
      "deployed:research-plan@1",
      "deployed:review@1",
      "fresh_install_default:implement@1",
      "fresh_install_default:research-plan@1",
      "fresh_install_default:review@1",
    ]);
    expect(report.pins.every((pin) => pin.authorship === "platform")).toBe(true);
    expect(report.pins.every((pin) => pin.resyncCovered)).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(report.customerAuthored).toEqual([]);
    expect(report.unfixableDrift).toEqual([]);
    expect(report.drift).toEqual([]);
    expect(describeBuiltInPromptDrift(report)).toBe("");
  });

  it("walks the fresh-install code default, which has no deployed version at all", async () => {
    // Nothing is deployed: exactly what migration 0013 leaves behind, and the
    // shape a brand new install has on day one. definition-step.ts serves
    // defaultWorkflowDefinition() here, whose agent blocks carry no prompt param
    // and so resolve each built-in implicitly by name at `latest`.
    const { client, db } = await migrateThrough("9999");

    const clean = await findBuiltInPromptDrift(db);
    expect(clean.definitionsWalked).toBe(1);
    expect(clean.skipped).toEqual([]);
    expect(clean.pins.map(pinKey).sort()).toEqual([
      "fresh_install_default:implement@1",
      "fresh_install_default:research-plan@1",
      "fresh_install_default:review@1",
    ]);
    expect(clean.pins.every((pin) => pin.requestedVersion === "latest")).toBe(
      true,
    );
    expect(clean.drift).toEqual([]);

    // `latest` follows the head, so a platform version 2 a resync failed to move
    // is served to this install with no pin anywhere to point at.
    await appendVersion(
      client,
      "implement",
      2,
      STALE_PLATFORM_IMPLEMENT_BODY,
      PLATFORM,
    );

    const drifted = await findBuiltInPromptDrift(db);
    expect(drifted.definitionsWalked).toBe(1);
    expect(drifted.drift.map(pinKey)).toEqual([
      "fresh_install_default:implement@2",
    ]);
    expect(describeBuiltInPromptDrift(drifted)).toContain("code default");
  });

  it("fails on the production shape: a platform version 2 the active definition pins", async () => {
    const { db } = await productionShape();

    const report = await findBuiltInPromptDrift(db);

    expect(report.definitionsWalked).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({
      slug: "implement",
      promptName: "implement",
      requestedVersion: 2,
      resolvedVersion: 2,
      authorship: "platform",
      matchesConstant: false,
      resyncCovered: true,
      source: "deployed",
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
    // The customer's review versions exist but nothing reachable resolves them.
    expect(report.customerAuthored).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.unfixableDrift).toEqual([]);
  });

  it("is cleared by the 0037 resync, which leaves every customer version alone", async () => {
    const { client, db } = await productionShape();
    const customerBefore = [
      await readVersion(client, "review", 2),
      await readVersion(client, "review", 3),
    ];

    await client.exec(resyncSql);

    const report = await findBuiltInPromptDrift(db);
    expect(report.drift).toEqual([]);
    expect(report.unfixableDrift).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.definitionsWalked).toBe(1);
    expect(report.skipped).toEqual([]);
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
    expect(report.drift.map(pinKey).sort()).toEqual([
      "deployed:implement@1",
      "deployed:implement@2",
    ]);
  });

  it("walks an archived definition that still has a pending approval", async () => {
    // Archiving cannot revoke an approved plan: approvals/dispatch.ts resolves
    // the pinned version regardless of enabled or archived_at, so the graph an
    // archived definition holds still executes.
    const { client, db } = await productionShape();
    await appendVersion(
      client,
      "implement",
      3,
      "another stale platform body",
      PLATFORM,
    );
    const withApproval = await deployDefinition(
      client,
      "Archived but approved",
      definitionPinning({ "{{prompt:implement@1}}": "{{prompt:implement@3}}" }),
    );
    const withoutApproval = await deployDefinition(
      client,
      "Archived and settled",
      definitionPinning({ "{{prompt:implement@1}}": "{{prompt:implement@3}}" }),
    );
    for (const id of [withApproval, withoutApproval]) {
      await client.query(
        `UPDATE workflow_definitions SET enabled = false, archived_at = now() WHERE id = $1`,
        [id],
      );
    }
    await client.query(
      `INSERT INTO approval_requests (id, ticket_key, definition_id, definition_version, run_id, plan, status)
       VALUES ('ap_1', 'AWP-1', $1, 1, 'wrun_1', '{"markdown":"plan"}'::jsonb, 'pending')`,
      [withApproval],
    );
    // A settled approval on the other one must not resurrect it.
    await client.query(
      `INSERT INTO approval_requests (id, ticket_key, definition_id, definition_version, run_id, plan, status)
       VALUES ('ap_2', 'AWP-2', $1, 1, 'wrun_2', '{"markdown":"plan"}'::jsonb, 'approved')`,
      [withoutApproval],
    );

    const report = await findBuiltInPromptDrift(db);

    expect(report.skipped).toEqual([]);
    const approvalPins = report.drift.filter((pin) => pin.source === "approval");
    expect(new Set(approvalPins.map((pin) => pin.definitionId))).toEqual(
      new Set([withApproval]),
    );
    // Its own pin plus review@1, which 0034 and 0036 also left at the seed.
    expect(
      approvalPins.map((pin) => `${pin.slug}@${pin.resolvedVersion}`).sort(),
    ).toEqual(["implement@3", "review@1"]);
    expect(
      approvalPins.find((pin) => pin.slug === "implement"),
    ).toMatchObject({
      resolvedVersion: 3,
      authorship: "platform",
      matchesConstant: false,
      nodeId: "implementation",
    });
    // The settled one is not reachable, so it is not walked.
    expect(report.pins.some((pin) => pin.definitionId === withoutApproval)).toBe(
      false,
    );
  });

  it("reports a pin no version satisfies instead of passing silently", async () => {
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);
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
    await retireFreshInstallDefinition(client);
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

    expect(report.drift.map(pinKey)).toEqual(["deployed:implement@2"]);
    expect(report.customerAuthored).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("records a skip rather than reporting clean when a snapshot cannot be read", async () => {
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);
    await deployDefinition(client, "Broken shape", {
      schemaVersion: 2,
      nodes: "nope",
    });
    await deployDefinition(client, "Unknown block", {
      schemaVersion: 2,
      nodes: [{ id: "mystery", type: "not_a_real_block", configuration: {} }],
    });
    await deployDefinition(client, "No container", {
      schemaVersion: 2,
      nodes: [{ id: "implementation", type: "implementation_agent" }],
    });

    const report = await findBuiltInPromptDrift(db);

    expect(report.pins).toEqual([]);
    expect(report.drift).toEqual([]);
    // Nothing was found, and the report says so out loud instead of looking clean.
    expect(report.definitionsWalked).toBe(2);
    expect(
      report.skipped.map((skip) => `${skip.reason}:${skip.nodeId ?? "-"}`).sort(),
    ).toEqual([
      "definition_shape:-",
      "node_container_missing:implementation",
      "unknown_node_type:mystery",
    ]);
    expect(describeBuiltInPromptDrift(report)).toContain("NOT WALKED");
  });

  it("does not report a gap for a queue row that resolves to the walked code default", async () => {
    // A fresh install: migration 0013's enabled, versionless ticket definition
    // is walked as the code default, and an approval filed against it pins no
    // version because there is none to pin. That row resolves to the snapshot
    // that was just walked, so it is a duplicate, not something unread.
    // Reporting it would fail the gate on `skipped.length` for a healthy
    // install, and a gate that cries wolf on day one is a gate someone mutes.
    const { client, db } = await migrateThrough("9999");
    await client.query(
      `INSERT INTO approval_requests (id, ticket_key, definition_id, definition_version, run_id, plan, status)
       VALUES ('ap_default', 'AWP-1', 1, NULL, 'wrun_1', '{"markdown":"plan"}'::jsonb, 'pending')`,
    );

    const report = await findBuiltInPromptDrift(db);

    expect(report.skipped).toEqual([]);
    expect(report.definitionsWalked).toBe(1);
    expect(report.pins.map(pinKey).sort()).toEqual([
      "fresh_install_default:implement@1",
      "fresh_install_default:research-plan@1",
      "fresh_install_default:review@1",
    ]);
    // The whole point: the gate stays green on a healthy fresh install.
    const gate = evaluateBuiltInPromptDriftGate(report);
    expect(gate.failures).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it("still reports a gap for a queue row nothing walked", async () => {
    // Same unresolvable shape, but nothing covers this definition: it is not
    // enabled, so the fresh-install walk skips it, and it has no deployed
    // version for the null pin to fall back to. Dispatch would fail this
    // approval with definition_gone, and the report has to say so.
    const { client, db } = await migrateThrough("9999");
    const created = await client.query<{ id: number }>(
      `INSERT INTO workflow_definitions (name, enabled, trigger_types, created_by_id, created_by_label)
       VALUES ('Never deployed', false, '{trigger_ticket_ai}', 'u_admin', 'Admin') RETURNING id`,
    );
    const orphan = created.rows[0]!.id;
    await client.query(
      `INSERT INTO approval_requests (id, ticket_key, definition_id, definition_version, run_id, plan, status)
       VALUES ('ap_orphan', 'AWP-2', $1, NULL, 'wrun_2', '{"markdown":"plan"}'::jsonb, 'pending')`,
      [orphan],
    );

    const report = await findBuiltInPromptDrift(db);

    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({
      reason: "definition_version_missing",
      definitionId: orphan,
      definitionVersion: null,
      source: "approval",
      detail:
        "reachable snapshot pins no version and the definition has none deployed",
    });
    expect(evaluateBuiltInPromptDriftGate(report).failures.map((f) => f.code)).toEqual([
      "incomplete_walk",
    ]);
  });

  it("does not count a snapshot with no blocks as a walked definition", async () => {
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);
    await deployDefinition(client, "Empty graph", {
      schemaVersion: 2,
      nodes: [],
    });

    const report = await findBuiltInPromptDrift(db);

    // An array is not an inspection: nothing was read, so nothing may be
    // counted, and the empty node list is named instead of passing quietly.
    expect(report.definitionsWalked).toBe(0);
    expect(report.pins).toEqual([]);
    expect(report.skipped.map((skip) => skip.reason)).toEqual([
      "definition_has_no_nodes",
    ]);
  });

  it("names a prompt-bearing block type that has no prompt-key entry", async () => {
    // Reproduces the next version of the very bug this report exists to catch:
    // WORKFLOW_PROMPT_PARAM_KEYS is a Partial record, so an agent block added
    // without a key entry would contribute no fields, no pins and no findings,
    // while the walk still looked successful. Simulated by removing an existing
    // entry, because no such block type exists yet.
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);
    await deployDefinition(
      client,
      "Deployed ticket workflow",
      defaultWorkflowDefinitionV2({
        includeReview: true,
        includeLeakReview: false,
        provider: "claude",
      }),
    );
    const mutable = WORKFLOW_PROMPT_PARAM_KEYS as Record<
      string,
      readonly string[] | undefined
    >;
    const original = mutable.review_agent;

    try {
      delete mutable.review_agent;
      const report = await findBuiltInPromptDrift(db);

      expect(
        report.skipped.map((skip) => `${skip.reason}:${skip.nodeId ?? "-"}`),
      ).toEqual(["prompt_keys_unknown:review"]);
      // The review pin is genuinely gone from the walk, which is exactly why the
      // silence has to be recorded rather than inferred from a clean drift list.
      expect(report.pins.map((pin) => pin.slug).sort()).toEqual([
        "implement",
        "research-plan",
      ]);
      expect(report.drift).toEqual([]);
    } finally {
      mutable.review_agent = original;
    }

    // Restored, so the same walk sees all three again.
    const restored = await findBuiltInPromptDrift(db);
    expect(restored.skipped).toEqual([]);
    expect(restored.pins.map((pin) => pin.slug).sort()).toEqual([
      "implement",
      "research-plan",
      "review",
    ]);
  });

  it("costs the same whether the queue holds five rows or two hundred", async () => {
    // A wedged dispatcher is exactly when someone runs this check, so the cost
    // must not scale with the queue depth. The queues are deduplicated in SQL
    // and the remaining lookups are batched, so the number of round trips is a
    // function of distinct snapshots, not of pending events.
    const measure = async (
      deliveries: number,
    ): Promise<{ calls: number; report: Awaited<ReturnType<typeof findBuiltInPromptDrift>> }> => {
      const { client, db } = await migrateThrough("9999");
      await retireFreshInstallDefinition(client);
      const definitionId = await deployDefinition(
        client,
        "Deployed ticket workflow",
        defaultWorkflowDefinitionV2({
          includeReview: true,
          includeLeakReview: false,
          provider: "claude",
        }),
      );
      await client.query(
        `UPDATE workflow_definitions SET archived_at = now() WHERE id = $1`,
        [definitionId],
      );
      for (let index = 0; index < deliveries; index += 1) {
        await client.query(
          `INSERT INTO trigger_deliveries
             (provider, delivery_id, producer, trigger_type, subject_key, head_sha,
              definition_id, definition_version, payload, pending)
           VALUES ('github', $1, 'test', 'trigger_pr_created', $2, 'sha', $3, 1, '{}'::jsonb, true)`,
          [`d_${index}`, `subject_${index}`, definitionId],
        );
      }

      let calls = 0;
      const query = client.query.bind(client);
      const exec = client.exec.bind(client);
      Object.assign(client, {
        query: (...args: Parameters<typeof query>) => {
          calls += 1;
          return query(...args);
        },
        exec: (...args: Parameters<typeof exec>) => {
          calls += 1;
          return exec(...args);
        },
      });
      try {
        // Await first, then read the counter. Building the object literal with
        // `{ calls, report: await ... }` would evaluate `calls` before the await
        // and record 0 every time, which is a vacuous pass.
        const report = await findBuiltInPromptDrift(db);
        return { calls, report };
      } finally {
        Object.assign(client, { query, exec });
      }
    };

    const small = await measure(5);
    const large = await measure(200);

    // The counter must observe something, or "equal" would mean "measured
    // nothing" rather than "cost nothing".
    expect(small.calls).toBeGreaterThan(0);
    expect(large.calls).toBe(small.calls);
    // And the flood still resolves to exactly one snapshot, walked once.
    for (const { report } of [small, large]) {
      expect(report.definitionsWalked).toBe(1);
      expect(report.skipped).toEqual([]);
      expect(report.pins.map(pinKey).sort()).toEqual([
        "trigger_delivery:implement@1",
        "trigger_delivery:research-plan@1",
        "trigger_delivery:review@1",
      ]);
    }
  });
});
