CREATE TABLE "pre_pr_check_config_versions" (
	"version" serial PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text NOT NULL,
	"created_by_label" text NOT NULL,
	"restored_from_version" integer
);
