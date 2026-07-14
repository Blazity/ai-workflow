CREATE TABLE "workflow_definition_triggers" (
	"trigger_type" text PRIMARY KEY NOT NULL,
	"definition_id" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_definition_triggers" ADD CONSTRAINT "workflow_definition_triggers_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill the enabled trigger bindings from every currently enabled, non-archived
-- definition so the new one-enabled-per-trigger PK reflects existing state.
INSERT INTO "workflow_definition_triggers" ("trigger_type", "definition_id")
SELECT t, wd."id"
FROM "workflow_definitions" wd, unnest(wd."trigger_types") AS t
WHERE wd."enabled" AND wd."archived_at" IS NULL;