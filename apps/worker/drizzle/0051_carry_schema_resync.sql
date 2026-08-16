CREATE TABLE "carry_schema_resync_audit" (
	"definition_id" integer NOT NULL,
	"version" integer NOT NULL,
	"node_index" integer NOT NULL,
	"node_id" text,
	"carry_index" integer NOT NULL,
	"source_key" text NOT NULL,
	"before_schema" jsonb NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carry_schema_resync_audit_definition_id_version_node_index_carry_index_pk" PRIMARY KEY("definition_id","version","node_index","carry_index")
);
--> statement-breakpoint
-- >>> AIW-245 carry schema resync data migration (generated below; do not hand-edit) <<<
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
-- scripts/generate-carry-schema-resync-migration.ts (see its header).
INSERT INTO "carry_schema_resync_audit"
  ("definition_id", "version", "node_index", "node_id", "carry_index", "source_key", "before_schema")
SELECT
  "v"."definition_id",
  "v"."version",
  ("node_ord" - 1)::int,
  "node"->>'id',
  ("carry_ord" - 1)::int,
  'review_result',
  "carry"->'schema'
FROM "workflow_definition_versions" AS "v"
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof("v"."definition"->'nodes') = 'array' THEN "v"."definition"->'nodes' ELSE '[]'::jsonb END
) WITH ORDINALITY AS "n"("node", "node_ord")
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof("node"->'configuration'->'carry') = 'array' THEN "node"->'configuration'->'carry' ELSE '[]'::jsonb END
) WITH ORDINALITY AS "c"("carry", "carry_ord")
WHERE "carry"->'schema' IN ($aiw_carry_resync${"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":true,"properties":{"decision":{"enum":["approve","request_changes"],"type":"string"},"feedback":{"type":"string"},"findings":{"items":{"additionalProperties":true,"properties":{"description":{"type":"string"},"endLine":{"type":"number"},"file":{"type":"string"},"severity":{"enum":["critical","suggestion"],"type":"string"},"startLine":{"type":"number"}},"required":["file","description","severity"],"type":"object"},"type":"array"}},"required":["decision","findings"],"type":"object"}$aiw_carry_resync$::jsonb, $aiw_carry_resync${"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":true,"properties":{"decision":{"enum":["approve","request_changes"],"type":"string"},"feedback":{"type":"string"},"findings":{"items":{"additionalProperties":true,"properties":{"description":{"type":"string"},"endLine":{"type":"number"},"file":{"type":"string"},"severity":{"enum":["Blocker","High","Medium","Nit"],"type":"string"},"startLine":{"type":"number"}},"required":["file","description","severity"],"type":"object"},"type":"array"}},"required":["decision","findings"],"type":"object"}$aiw_carry_resync$::jsonb)
ON CONFLICT ("definition_id", "version", "node_index", "carry_index") DO NOTHING;
--> statement-breakpoint
UPDATE "workflow_definition_versions" AS "v"
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
                    WHEN "carry"->'schema' IN ($aiw_carry_resync${"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":true,"properties":{"decision":{"enum":["approve","request_changes"],"type":"string"},"feedback":{"type":"string"},"findings":{"items":{"additionalProperties":true,"properties":{"description":{"type":"string"},"endLine":{"type":"number"},"file":{"type":"string"},"severity":{"enum":["critical","suggestion"],"type":"string"},"startLine":{"type":"number"}},"required":["file","description","severity"],"type":"object"},"type":"array"}},"required":["decision","findings"],"type":"object"}$aiw_carry_resync$::jsonb, $aiw_carry_resync${"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":true,"properties":{"decision":{"enum":["approve","request_changes"],"type":"string"},"feedback":{"type":"string"},"findings":{"items":{"additionalProperties":true,"properties":{"description":{"type":"string"},"endLine":{"type":"number"},"file":{"type":"string"},"severity":{"enum":["Blocker","High","Medium","Nit"],"type":"string"},"startLine":{"type":"number"}},"required":["file","description","severity"],"type":"object"},"type":"array"}},"required":["decision","findings"],"type":"object"}$aiw_carry_resync$::jsonb)
                    THEN jsonb_set("carry", '{schema}', $aiw_carry_resync${"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":true,"properties":{"decision":{"enum":["approve","request_changes"],"type":"string"},"feedback":{"type":"string"},"findings":{"items":{"additionalProperties":true,"properties":{"description":{"type":"string"},"endLine":{"type":"number"},"file":{"type":"string"},"repo":{"type":"string"},"severity":{"enum":["Blocker","High","Medium","Nit"],"type":"string"},"startLine":{"type":"number"}},"required":["file","description","severity"],"type":"object"},"type":"array"}},"required":["decision","findings"],"type":"object"}$aiw_carry_resync$::jsonb)
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
        CASE WHEN jsonb_typeof("v"."definition"->'nodes') = 'array' THEN "v"."definition"->'nodes' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS "n"("node", "node_ord")
    ) AS "nodes"
  ), "v"."definition"->'nodes')
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof("v"."definition"->'nodes') = 'array' THEN "v"."definition"->'nodes' ELSE '[]'::jsonb END
  ) AS "node"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof("node"->'configuration'->'carry') = 'array' THEN "node"->'configuration'->'carry' ELSE '[]'::jsonb END
  ) AS "carry"
  WHERE "carry"->'schema' IN ($aiw_carry_resync${"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":true,"properties":{"decision":{"enum":["approve","request_changes"],"type":"string"},"feedback":{"type":"string"},"findings":{"items":{"additionalProperties":true,"properties":{"description":{"type":"string"},"endLine":{"type":"number"},"file":{"type":"string"},"severity":{"enum":["critical","suggestion"],"type":"string"},"startLine":{"type":"number"}},"required":["file","description","severity"],"type":"object"},"type":"array"}},"required":["decision","findings"],"type":"object"}$aiw_carry_resync$::jsonb, $aiw_carry_resync${"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":true,"properties":{"decision":{"enum":["approve","request_changes"],"type":"string"},"feedback":{"type":"string"},"findings":{"items":{"additionalProperties":true,"properties":{"description":{"type":"string"},"endLine":{"type":"number"},"file":{"type":"string"},"severity":{"enum":["Blocker","High","Medium","Nit"],"type":"string"},"startLine":{"type":"number"}},"required":["file","description","severity"],"type":"object"},"type":"array"}},"required":["decision","findings"],"type":"object"}$aiw_carry_resync$::jsonb)
);
