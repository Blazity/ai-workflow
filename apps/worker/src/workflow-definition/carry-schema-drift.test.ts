import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { REVIEW_RESULT_JSON_SCHEMA } from "@shared/contracts";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  canonicalizeSchema,
  collectDefinitionEmbeds,
  EMBEDDED_SCHEMA_SOURCES,
  findCarrySchemaDrift,
} from "./carry-schema-drift.js";
import {
  assertNoCarrySchemaDrift,
  CarrySchemaDriftError,
  evaluateCarrySchemaDriftGate,
} from "./carry-schema-drift-gate.js";
import { workflowDefinitionTemplate, workflowDefinitionTemplates } from "./templates.js";
import { validateWorkflowDefinitionCandidate } from "./validation.js";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

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

function resyncMigrationSql(): string {
  const file = migrationFiles.find((name) =>
    name.startsWith("0051_carry_schema_resync"),
  );
  if (!file) throw new Error("0051_carry_schema_resync migration not found");
  return readFileSync(`${migrationsDir}${file}`, "utf8");
}

async function applyCarrySchemaResync(client: PGlite): Promise<void> {
  await client.exec(resyncMigrationSql());
}

/** Re-runs only the data statements (INSERT + UPDATE), skipping the CREATE TABLE
 *  so a second application does not fail on an existing table. Proves the data
 *  half is idempotent. */
async function applyCarrySchemaResyncDataOnly(client: PGlite): Promise<void> {
  const parts = resyncMigrationSql().split("--> statement-breakpoint");
  await client.exec(parts.slice(1).join("\n"));
}

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

async function readStoredDefinition(
  client: PGlite,
  definitionId: number,
): Promise<unknown> {
  const rows = await client.query<{ definition: unknown }>(
    `SELECT definition FROM workflow_definition_versions WHERE definition_id = $1 AND version = 1`,
    [definitionId],
  );
  return rows.rows[0]!.definition;
}

const reviewResultSource = EMBEDDED_SCHEMA_SOURCES.find(
  (source) => source.key === "review_result",
)!;
/** The exact severity "critical"|"suggestion" shape AIW-245 reproduces. */
const OLD_ENUM_SHAPE = reviewResultSource.knownPrior[0]!;

function reviewedTicketCurrent(): Record<string, unknown> {
  const template = workflowDefinitionTemplate("reviewed-ticket-workflow", {
    includeReview: true,
    provider: "claude",
  });
  if (!template) throw new Error("reviewed-ticket-workflow template missing");
  return template.definition as unknown as Record<string, unknown>;
}

/** Rewrites every carry schema that currently mirrors REVIEW_RESULT_JSON_SCHEMA
 *  with `replacement`, leaving every other carry alone. */
function swapReviewCarrySchemas(
  definition: Record<string, unknown>,
  replacement: unknown,
  limit = Infinity,
): Record<string, unknown> {
  const clone = structuredClone(definition);
  const currentCanonical = canonicalizeSchema(REVIEW_RESULT_JSON_SCHEMA);
  let swapped = 0;
  for (const node of clone.nodes as Record<string, unknown>[]) {
    const config = node.configuration as Record<string, unknown> | undefined;
    const carry = config?.carry;
    if (!Array.isArray(carry)) continue;
    for (const entry of carry as Record<string, unknown>[]) {
      if (
        swapped < limit &&
        canonicalizeSchema(entry.schema) === currentCanonical
      ) {
        entry.schema = structuredClone(replacement);
        swapped += 1;
      }
    }
  }
  return clone;
}

const stubCoordinates = {
  definitionId: 0,
  definitionName: "fixture",
  definitionVersion: null as number | null,
  source: "deployed" as const,
};

/**
 * Committed hashes of every code-owned shape the registry knows. This is the
 * forcing function for AIW-245: the gate can only detect drift for shapes it has
 * enumerated, so if someone edits a code-owned schema constant without adding its
 * previous shape to knownPrior and writing a resync migration, a stored def
 * carrying the now-old shape would classify as unrecognized, the gate would pass,
 * and the def would fail validation at dispatch -- the exact bug this ticket
 * prevents. Changing a shape flips a hash here and reddens the build with the
 * instruction to add the prior + migration.
 */
const EXPECTED_SHAPE_HASHES: Record<string, { current: string; knownPrior: string[] }> = {
  review_result: {
    current: "ee79c8877194c7112ef7891f72402ae942f29f35820469d4f72f9503529c92db",
    knownPrior: [
      "93b53e3360e6f8a3beeef804b90cecf40fce8b30a4a366a94b4650a37066fe4d",
      "9dc1f3650bded4af204bad0dd7bfb032316075da1b893d1cb5cda97fe95ad6be",
    ],
  },
  pr_check: {
    current: "4d632fb28d86f3d13523993c4970c873ed2b60f545a2980ae9f58fa5c27538c5",
    knownPrior: [],
  },
};

const shapeHash = (value: unknown): string =>
  createHash("sha256").update(canonicalizeSchema(value)).digest("hex");

describe("carry schema drift", () => {
  it("passes on the shipped reviewed-ticket workflow", async () => {
    const { client, db } = await migrateThrough("9999");
    await deployDefinition(client, "Reviewed ticket", reviewedTicketCurrent());

    const result = await assertNoCarrySchemaDrift(db);

    expect(result.ok).toBe(true);
    expect(result.report.drift).toEqual([]);
    expect(result.report.customerDivergent).toEqual([]);
    expect(result.report.definitionsWalked).toBeGreaterThan(0);
    // The three review carries are recognized as the current constant.
    expect(
      result.report.embeds.filter(
        (embed) => embed.sourceKey === "review_result" && embed.classification === "current",
      ).length,
    ).toBeGreaterThanOrEqual(3);
    expect(result.message).toContain("passed");
  });

  it("reports RED on a stored reviewed-ticket carrying the old severity enum", async () => {
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);
    await deployDefinition(
      client,
      "Reviewed ticket (stale enum)",
      swapReviewCarrySchemas(reviewedTicketCurrent(), OLD_ENUM_SHAPE),
    );

    const report = await findCarrySchemaDrift(db);
    const result = evaluateCarrySchemaDriftGate(report);

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toEqual(["drift"]);
    expect(report.drift).toHaveLength(3);
    for (const embed of report.drift) {
      expect(embed.sourceKey).toBe("review_result");
      expect(embed.classification).toBe("prior");
      expect(embed.kind).toBe("carry");
    }
    expect(result.message).toContain("review_result");
    await expect(assertNoCarrySchemaDrift(db)).rejects.toBeInstanceOf(
      CarrySchemaDriftError,
    );
  });

  it("resyncs the stored old-enum definition so it validates clean (AC c)", async () => {
    const { client } = await migrateThrough("0049");
    const oldEnumDef = swapReviewCarrySchemas(reviewedTicketCurrent(), OLD_ENUM_SHAPE);

    // Precondition: the shipped shape validates clean, the stale copy does not.
    expect(
      validateWorkflowDefinitionCandidate(reviewedTicketCurrent(), registryContext)
        .response.valid,
    ).toBe(true);
    const before = validateWorkflowDefinitionCandidate(oldEnumDef, registryContext);
    expect(before.response.valid).toBe(false);
    expect(
      before.response.issues.filter((issue) => issue.code === "binding.reference_type"),
    ).not.toHaveLength(0);

    const id = await deployDefinition(client, "Reviewed ticket (stale enum)", oldEnumDef);
    await applyCarrySchemaResync(client);

    const migrated = await readStoredDefinition(client, id);
    const after = validateWorkflowDefinitionCandidate(migrated, registryContext);
    expect(after.response.valid).toBe(true);
    expect(
      after.response.issues.filter((issue) => issue.code === "binding.reference_type"),
    ).toHaveLength(0);
    // Every review carry now byte-matches the current constant.
    const embeds = collectDefinitionEmbeds(migrated, stubCoordinates).embeds;
    for (const embed of embeds.filter((e) => e.sourceKey === "review_result")) {
      expect(embed.classification).toBe("current");
    }
  });

  it("leaves a customer-authored carry schema untouched and reports it", async () => {
    const { client, db } = await migrateThrough("0049");
    const customerSchema = {
      ...(REVIEW_RESULT_JSON_SCHEMA as Record<string, unknown>),
      title: "Customer review envelope",
    };
    // One carry diverges; the other two stay on the current constant.
    const def = swapReviewCarrySchemas(reviewedTicketCurrent(), customerSchema, 1);
    const id = await deployDefinition(client, "Customer reviewed ticket", def);

    const report = await findCarrySchemaDrift(db);
    expect(report.drift).toEqual([]);
    expect(report.customerDivergent).toHaveLength(1);
    expect(report.customerDivergent[0]!.sourceKey).toBeNull();
    expect(report.customerDivergent[0]!.classification).toBe("unrecognized");

    await applyCarrySchemaResync(client);
    const after = await readStoredDefinition(client, id);
    // The whole definition is byte-identical: the guard skipped it entirely.
    expect(canonicalizeSchema(after)).toBe(canonicalizeSchema(def));
    const customerEmbed = collectDefinitionEmbeds(after, stubCoordinates).embeds.find(
      (embed) => embed.classification === "unrecognized" && embed.kind === "carry",
    );
    expect(customerEmbed).toBeDefined();
    expect(canonicalizeSchema(customerSchema)).toContain("Customer review envelope");
  });

  it("fails when the walk reaches no snapshot at all", async () => {
    const { client, db } = await migrateThrough("9999");
    await retireFreshInstallDefinition(client);

    const report = await findCarrySchemaDrift(db);
    const result = evaluateCarrySchemaDriftGate(report);

    expect(report.definitionsWalked).toBe(0);
    expect(result.failures.map((failure) => failure.code)).toEqual(["nothing_inspected"]);
    expect(result.message).toContain("An empty report is not a clean one");
  });

  it("captures a revertible pre-image of every carry it rewrites", async () => {
    const { client } = await migrateThrough("0049");
    const oldEnumDef = swapReviewCarrySchemas(reviewedTicketCurrent(), OLD_ENUM_SHAPE);
    const id = await deployDefinition(client, "Reviewed ticket (stale enum)", oldEnumDef);

    await applyCarrySchemaResync(client);

    const audit = await client.query<{
      node_id: string | null;
      carry_index: number;
      source_key: string;
      before_schema: unknown;
    }>(
      `SELECT node_id, carry_index, source_key, before_schema
       FROM carry_schema_resync_audit WHERE definition_id = $1 ORDER BY carry_index`,
      [id],
    );
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows.map((row) => row.carry_index)).toEqual([0, 1, 2]);
    for (const row of audit.rows) {
      expect(row.source_key).toBe("review_result");
      expect(row.node_id).toBe("retry");
      // The recorded pre-image is exactly the value the migration overwrote, so
      // an operator can revert from it.
      expect(canonicalizeSchema(row.before_schema)).toBe(canonicalizeSchema(OLD_ENUM_SHAPE));
    }

    // Re-running the data half captures nothing new: the carries are current now.
    await applyCarrySchemaResyncDataOnly(client);
    const again = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM carry_schema_resync_audit WHERE definition_id = $1`,
      [id],
    );
    expect(again.rows[0]!.n).toBe(3);
  });

  it("pins every code-owned shape so it cannot change without a prior + migration", () => {
    for (const source of EMBEDDED_SCHEMA_SOURCES) {
      const expected = EXPECTED_SHAPE_HASHES[source.key];
      expect(
        expected,
        `New embedded schema source "${source.key}" has no committed hash. Add it to EXPECTED_SHAPE_HASHES.`,
      ).toBeDefined();
      expect(
        shapeHash(source.current),
        `${source.label} changed shape. When you change a code-owned schema embedded by value: ` +
          `add its previous shape to knownPrior in carry-schema-drift.ts, write a resync migration ` +
          `(see AIW-245 / scripts/generate-carry-schema-resync-migration.ts), then update ` +
          `EXPECTED_SHAPE_HASHES.current for "${source.key}".`,
      ).toBe(expected!.current);
      expect(
        source.knownPrior.map(shapeHash),
        `The known prior shapes for "${source.key}" changed. A prior must never be removed once ` +
          `shipped -- a stored def may still carry it -- and a new prior must ship with a resync migration.`,
      ).toEqual(expected!.knownPrior);
    }
    // A source committed here must still exist: guards against silent deletion.
    for (const key of Object.keys(EXPECTED_SHAPE_HASHES)) {
      expect(EMBEDDED_SCHEMA_SOURCES.map((source) => source.key)).toContain(key);
    }
  });

  it("recognizes every carry schema shipped by a built-in template as current", () => {
    for (const template of workflowDefinitionTemplates({
      includeReview: true,
      includeLeakReview: true,
      provider: "claude",
    })) {
      const { embeds, skipped } = collectDefinitionEmbeds(
        template.definition,
        stubCoordinates,
      );
      expect(skipped).toEqual([]);
      for (const embed of embeds.filter((e) => e.kind === "carry")) {
        expect({
          template: template.id,
          field: embed.field,
          sourceKey: embed.sourceKey,
          classification: embed.classification,
        }).toEqual({
          template: template.id,
          field: embed.field,
          sourceKey: expect.any(String),
          classification: "current",
        });
      }
    }
  });
});
