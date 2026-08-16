/**
 * Appends the DATA half of the carry-schema resync migration onto the DDL half
 * that drizzle-kit generates for the carry_schema_resync_audit table.
 *
 * A run never reads the code constant: a workflow definition freezes a copy of
 * REVIEW_RESULT_JSON_SCHEMA (and PR_CHECK_OUTPUT_SCHEMA) inside its own JSON when
 * it is saved, and deployment validation compares that frozen copy against the
 * type it derives live from the current constant. When the constant changes
 * shape the frozen copy goes stale and a previously-valid definition starts
 * failing validation with nothing having touched it (AIW-245). This migration
 * rewrites the stale copies, capturing a pre-image of each into the audit table
 * first so the rewrite is observable and reversible on production.
 *
 * The prior and current shapes come from the SAME registry the drift gate uses
 * (src/workflow-definition/carry-schema-drift.ts -> RESYNC_TARGETS), so the gate
 * and the migration can never disagree on which shapes are the platform's. There
 * is NO authorship marker inside a definition JSON, so the only guard is a
 * structural byte-for-byte (jsonb =) match against a KNOWN PRIOR platform shape.
 *
 * Usage, from apps/worker (build the shared package first, the shapes are read
 * from the built @shared/contracts the runtime itself consumes):
 *
 *   pnpm build:shared
 *   pnpm exec drizzle-kit generate --name=carry_schema_resync   # writes the DDL
 *   pnpm exec tsx scripts/generate-carry-schema-resync-migration.ts \
 *     drizzle/<generated file>.sql                               # appends the data
 *
 * Re-running is safe: the data half is delimited by a sentinel and rewritten in
 * place, so it never doubles up. Never point it at a migration already applied
 * anywhere; generate a fresh numbered file instead.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  canonicalizeSchema,
  RESYNC_TARGETS,
} from "../src/workflow-definition/carry-schema-drift.js";

/** Dollar-quote tag, so the JSON is copied verbatim instead of being escaped.
 *  Verified absent from every shape below. */
const TAG = "$aiw_carry_resync$";
const BREAKPOINT = "--> statement-breakpoint";
const SENTINEL =
  "-- >>> AIW-245 carry schema resync data migration (generated below; do not hand-edit) <<<";

const DATA_HEADER = `${SENTINEL}
-- Re-syncs code-owned JSON schemas embedded BY VALUE in a stored definition's
-- loop carry (configuration.carry; loops are schema-version 2) with the current
-- constants in apps/shared/contracts. A run never reads the constant: the
-- definition froze a copy when it was saved, and when the constant changed shape
-- ("critical"|"suggestion" -> "Blocker"|"High"|"Medium"|"Nit") every stored copy
-- went stale and its definition began failing validation with no migration
-- having touched it. That is AIW-245.
--
-- Guard: there is NO authorship marker inside a definition JSON. So a carry
-- schema is rewritten ONLY when it byte-matches (jsonb =) a KNOWN PRIOR platform
-- shape. Value alone still cannot prove the copy was the platform's rather than a
-- customer step output of the same shape, so BEFORE rewriting, each matched carry
-- is recorded in carry_schema_resync_audit (coordinate + before-value) -- the
-- INSERT is ON CONFLICT DO NOTHING and the UPDATE is a strict no-op once the copy
-- is current, so a re-run captures and changes nothing. An operator can read the
-- audit for the exact rows changed and revert from before_schema.
--
-- Every reachable version snapshot is corrected, not just the deployed one: the
-- statements have no version filter. Each is standalone (no explicit
-- transaction: neon-http has none) and guards every jsonb_array_elements against
-- a non-array so one malformed row cannot abort the whole migration.
--
-- Generated; do not hand-edit the shapes. Regenerate with
-- scripts/generate-carry-schema-resync-migration.ts (see its header).`;

/** Guarded array expansion: never throws on a row whose value is not an array. */
function guardedArray(expr: string): string {
  return `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`;
}

/** Captures the pre-image of every carry about to be rewritten, keyed by its
 *  coordinate so a re-run inserts nothing new. */
function buildAuditInsert(sourceKey: string, priorList: string): string {
  return `INSERT INTO "carry_schema_resync_audit"
  ("definition_id", "version", "node_index", "node_id", "carry_index", "source_key", "before_schema")
SELECT
  "v"."definition_id",
  "v"."version",
  ("node_ord" - 1)::int,
  "node"->>'id',
  ("carry_ord" - 1)::int,
  '${sourceKey}',
  "carry"->'schema'
FROM "workflow_definition_versions" AS "v"
CROSS JOIN LATERAL jsonb_array_elements(
  ${guardedArray(`"v"."definition"->'nodes'`)}
) WITH ORDINALITY AS "n"("node", "node_ord")
CROSS JOIN LATERAL jsonb_array_elements(
  ${guardedArray(`"node"->'configuration'->'carry'`)}
) WITH ORDINALITY AS "c"("carry", "carry_ord")
WHERE "carry"->'schema' IN (${priorList})
ON CONFLICT ("definition_id", "version", "node_index", "carry_index") DO NOTHING;`;
}

/** Rewrites every carry schema matching a prior shape to the current shape. The
 *  WHERE guard makes the row a no-op when it carries no matching shape. */
function buildUpdate(current: string, priorList: string): string {
  return `UPDATE "workflow_definition_versions" AS "v"
SET "definition" = jsonb_set(
  "v"."definition",
  '{nodes}',
  COALESCE((
    SELECT jsonb_agg("rewritten_node" ORDER BY "node_ord")
    FROM (
      SELECT
        CASE
          WHEN jsonb_typeof("node"->'configuration'->'carry') = 'array'
          THEN jsonb_set(
            "node",
            '{configuration,carry}',
            COALESCE((
              SELECT jsonb_agg("rewritten_carry" ORDER BY "carry_ord")
              FROM (
                SELECT
                  CASE
                    WHEN "carry"->'schema' IN (${priorList})
                    THEN jsonb_set("carry", '{schema}', ${TAG}${current}${TAG}::jsonb)
                    ELSE "carry"
                  END AS "rewritten_carry",
                  "carry_ord"
                FROM jsonb_array_elements("node"->'configuration'->'carry')
                     WITH ORDINALITY AS "c"("carry", "carry_ord")
              ) AS "carries"
            ), '[]'::jsonb)
          )
          ELSE "node"
        END AS "rewritten_node",
        "node_ord"
      FROM jsonb_array_elements(
        ${guardedArray(`"v"."definition"->'nodes'`)}
      ) WITH ORDINALITY AS "n"("node", "node_ord")
    ) AS "nodes"
  ), "v"."definition"->'nodes')
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(
    ${guardedArray(`"v"."definition"->'nodes'`)}
  ) AS "node"
  CROSS JOIN LATERAL jsonb_array_elements(
    ${guardedArray(`"node"->'configuration'->'carry'`)}
  ) AS "carry"
  WHERE "carry"->'schema' IN (${priorList})
);`;
}

const target = process.argv[2];
if (!target) {
  console.error(
    "Usage: tsx scripts/generate-carry-schema-resync-migration.ts <output .sql path>",
  );
  process.exit(1);
}

if (RESYNC_TARGETS.length === 0) {
  console.error("No resync targets have known prior shapes; nothing to generate.");
  process.exit(1);
}

const statements: string[] = [];
for (const source of RESYNC_TARGETS) {
  const current = canonicalizeSchema(source.current);
  const priors = source.knownPrior.map((prior) => canonicalizeSchema(prior));
  for (const literal of [current, ...priors]) {
    if (literal.includes(TAG)) {
      throw new Error(`dollar-quote tag ${TAG} appears inside a "${source.key}" shape`);
    }
    if (literal.includes(BREAKPOINT)) {
      throw new Error(`statement breakpoint marker appears inside a "${source.key}" shape`);
    }
  }
  const priorList = priors.map((prior) => `${TAG}${prior}${TAG}::jsonb`).join(", ");
  // Capture MUST precede rewrite: the pre-image is only recoverable while the
  // carry still holds the prior shape.
  statements.push(buildAuditInsert(source.key, priorList));
  statements.push(buildUpdate(current, priorList));
  console.log(
    `${source.key}: ${priors.length} prior shape(s), ${Buffer.byteLength(current, "utf8")} bytes current, quoting is safe`,
  );
}

// Keep the DDL half that drizzle-kit generated; replace only the data half so
// re-running never doubles it up.
let ddl = readFileSync(target, "utf8");
const sentinelAt = ddl.indexOf(SENTINEL);
if (sentinelAt !== -1) {
  ddl = ddl.slice(0, sentinelAt);
}
ddl = ddl.replace(new RegExp(`(?:\\s*${BREAKPOINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?\\s*$`), "");

const sql = `${ddl}\n${BREAKPOINT}\n${DATA_HEADER}\n${statements.join(`\n${BREAKPOINT}\n`)}\n`;

writeFileSync(target, sql, "utf8");
console.log(`Wrote ${target} (${Buffer.byteLength(sql, "utf8")} bytes).`);
