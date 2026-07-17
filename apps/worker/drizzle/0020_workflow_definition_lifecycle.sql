ALTER TABLE "workflow_definitions" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "builtin_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "draft_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "layout" jsonb DEFAULT '{"nodes":{}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "layout_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "deployed_version" integer;--> statement-breakpoint
UPDATE "workflow_definitions" wd
SET "builtin_fallback" = true
WHERE wd."name" = 'Ticket workflow'
	AND wd."created_by_id" = 'system'
	AND wd."archived_at" IS NULL
	AND wd."trigger_types" = ARRAY['trigger_ticket_ai']::text[]
	AND NOT EXISTS (
		SELECT 1 FROM "workflow_definition_versions" v WHERE v."definition_id" = wd."id"
	);--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_single_builtin_fallback_idx" ON "workflow_definitions" USING btree ("builtin_fallback") WHERE "workflow_definitions"."builtin_fallback" = true;--> statement-breakpoint
CREATE TABLE "workflow_definition_deployments" (
	"id" serial PRIMARY KEY NOT NULL,
	"definition_id" integer NOT NULL,
	"selected_version" integer NOT NULL,
	"previous_version" integer,
	"action" text NOT NULL,
	"rollback_from_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text NOT NULL,
	"created_by_label" text NOT NULL,
	CONSTRAINT "workflow_definition_deployments_action_check" CHECK ("action" in ('deploy', 'rollback', 'migration'))
);--> statement-breakpoint
ALTER TABLE "workflow_definition_deployments" ADD CONSTRAINT "workflow_definition_deployments_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition_deployments" ADD CONSTRAINT "workflow_definition_deployments_selected_version_fk" FOREIGN KEY ("definition_id","selected_version") REFERENCES "public"."workflow_definition_versions"("definition_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_definition_deployments_definition_id_created_at_idx" ON "workflow_definition_deployments" USING btree ("definition_id", "created_at");--> statement-breakpoint
WITH latest AS (
	SELECT DISTINCT ON (v."definition_id")
		v."definition_id",
		v."version",
		v."definition"
	FROM "workflow_definition_versions" v
	ORDER BY v."definition_id", v."version" DESC
), prepared AS (
	SELECT
		latest."definition_id",
		latest."version",
		jsonb_set(
			latest."definition",
			'{nodes}',
			COALESCE((
				SELECT jsonb_agg(
					jsonb_set(jsonb_set(node, '{x}', '0'::jsonb, true), '{y}', '0'::jsonb, true)
					ORDER BY ordinal
				)
				FROM jsonb_array_elements(COALESCE(latest."definition"->'nodes', '[]'::jsonb))
					WITH ORDINALITY AS nodes(node, ordinal)
			), '[]'::jsonb),
			true
		) AS semantic_draft,
		jsonb_build_object(
			'nodes',
			COALESCE((
				SELECT jsonb_object_agg(
					node->>'id',
					jsonb_build_object(
						'x', COALESCE(node->'x', '0'::jsonb),
						'y', COALESCE(node->'y', '0'::jsonb)
					)
				)
				FROM jsonb_array_elements(COALESCE(latest."definition"->'nodes', '[]'::jsonb)) AS nodes(node)
			), '{}'::jsonb)
		) AS extracted_layout
	FROM latest
)
UPDATE "workflow_definitions" wd
SET
	"draft" = prepared.semantic_draft,
	"draft_revision" = 1,
	"layout" = prepared.extracted_layout,
	"layout_revision" = 1,
	"deployed_version" = CASE WHEN wd."enabled" THEN prepared."version" ELSE NULL END,
	"updated_at" = now()
FROM prepared
WHERE wd."id" = prepared."definition_id";--> statement-breakpoint
INSERT INTO "workflow_definition_deployments" (
	"definition_id",
	"selected_version",
	"previous_version",
	"action",
	"rollback_from_version",
	"created_by_id",
	"created_by_label"
)
SELECT
	wd."id",
	wd."deployed_version",
	NULL,
	'migration',
	NULL,
	'system',
	'System migration'
FROM "workflow_definitions" wd
WHERE wd."deployed_version" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_deployed_version_fk" FOREIGN KEY ("id","deployed_version") REFERENCES "public"."workflow_definition_versions"("definition_id","version") ON DELETE no action ON UPDATE no action;
