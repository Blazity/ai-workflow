ALTER TABLE "repository_catalog_state" ADD COLUMN "activation_reason" text;--> statement-breakpoint
ALTER TABLE "repository_profile_versions" ADD COLUMN "batch_timeout_minutes" integer;--> statement-breakpoint
ALTER TABLE "repository_suggestions" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "repository_access" jsonb;