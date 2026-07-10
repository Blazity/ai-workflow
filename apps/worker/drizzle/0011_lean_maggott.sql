CREATE TABLE "workflow_definition_versions" (
	"version" serial PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text NOT NULL,
	"created_by_label" text NOT NULL,
	"restored_from_version" integer
);
