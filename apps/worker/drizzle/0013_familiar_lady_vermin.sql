CREATE TABLE "workflow_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text NOT NULL,
	"created_by_label" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_name_active_idx" ON "workflow_definitions" USING btree ("name") WHERE "workflow_definitions"."archived_at" is null;--> statement-breakpoint
INSERT INTO "workflow_definitions" ("name", "enabled", "trigger_types", "created_by_id", "created_by_label")
VALUES ('Ticket workflow', true, '{trigger_ticket_ai}', 'system', 'System migration');--> statement-breakpoint
ALTER TABLE "workflow_definition_versions" ADD COLUMN "definition_id" integer;--> statement-breakpoint
UPDATE "workflow_definition_versions" SET "definition_id" = (SELECT "id" FROM "workflow_definitions" ORDER BY "id" LIMIT 1);--> statement-breakpoint
ALTER TABLE "workflow_definition_versions" ALTER COLUMN "definition_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definition_versions" ADD CONSTRAINT "workflow_definition_versions_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition_versions" DROP CONSTRAINT "workflow_definition_versions_pkey";--> statement-breakpoint
ALTER TABLE "workflow_definition_versions" ALTER COLUMN "version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workflow_definition_versions" ADD CONSTRAINT "workflow_definition_versions_definition_id_version_pk" PRIMARY KEY("definition_id","version");--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "definition_id" integer;--> statement-breakpoint
UPDATE "workflow_runs" SET "definition_id" = (SELECT "id" FROM "workflow_definitions" ORDER BY "id" LIMIT 1) WHERE "definition_version" IS NOT NULL;
