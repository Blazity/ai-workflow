CREATE TABLE "workflow_block_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"activation_scope_id" text NOT NULL,
	"state" text NOT NULL,
	"outcome" jsonb,
	"selected_transition" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"diagnostic_id" text,
	"input_envelope" jsonb,
	"output_envelope" jsonb,
	"log_envelope" jsonb,
	"metadata_envelope" jsonb,
	"observation_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_block_attempts_attempt_check" CHECK ("workflow_block_attempts"."attempt" > 0),
	CONSTRAINT "workflow_block_attempts_observation_revision_check" CHECK ("workflow_block_attempts"."observation_revision" >= 0),
	CONSTRAINT "workflow_block_attempts_state_check" CHECK ("workflow_block_attempts"."state" in ('running', 'waiting_loop', 'waiting_for_clarification', 'completed', 'failed', 'cancelled', 'skipped')),
	CONSTRAINT "workflow_block_attempts_duration_check" CHECK ("workflow_block_attempts"."duration_ms" is null or "workflow_block_attempts"."duration_ms" >= 0),
	CONSTRAINT "workflow_block_attempts_completion_check" CHECK (("workflow_block_attempts"."state" in ('running', 'waiting_loop') and "workflow_block_attempts"."completed_at" is null) or ("workflow_block_attempts"."state" not in ('running', 'waiting_loop') and "workflow_block_attempts"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "workflow_run_observations" (
	"run_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"definition_id" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"definition_schema_version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"layout" jsonb NOT NULL,
	"runtime_manifest" jsonb NOT NULL,
	"capture_status" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_run_observations_run_org_unique" UNIQUE("run_id","organization_id"),
	CONSTRAINT "workflow_run_observations_schema_version_check" CHECK ("workflow_run_observations"."definition_schema_version" in (1, 2)),
	CONSTRAINT "workflow_run_observations_capture_status_check" CHECK ("workflow_run_observations"."capture_status" in ('available', 'unavailable'))
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "replay_organization_id" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "replay_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "replay_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "replay_capture_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_block_attempts" ADD CONSTRAINT "workflow_block_attempts_run_org_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."workflow_run_observations"("run_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_observations" ADD CONSTRAINT "workflow_run_observations_run_id_workflow_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_observations" ADD CONSTRAINT "workflow_run_observations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_observations" ADD CONSTRAINT "workflow_run_observations_definition_version_fk" FOREIGN KEY ("definition_id","definition_version") REFERENCES "public"."workflow_definition_versions"("definition_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_block_attempts_identity_unique" ON "workflow_block_attempts" USING btree ("run_id","node_id","attempt","activation_scope_id");--> statement-breakpoint
CREATE INDEX "workflow_block_attempts_run_id_idx" ON "workflow_block_attempts" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "workflow_block_attempts_org_run_idx" ON "workflow_block_attempts" USING btree ("organization_id","run_id","id");--> statement-breakpoint
CREATE INDEX "workflow_run_observations_org_captured_idx" ON "workflow_run_observations" USING btree ("organization_id","captured_at");--> statement-breakpoint
CREATE INDEX "workflow_run_observations_expires_at_idx" ON "workflow_run_observations" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_replay_organization_id_organization_id_fk" FOREIGN KEY ("replay_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "workflow_runs"
SET "block_statuses" = (
	SELECT coalesce(
		jsonb_object_agg(
			"entry"."key",
			CASE
				WHEN jsonb_typeof("entry"."value") = 'object'
					THEN "entry"."value" - 'output'
				ELSE "entry"."value"
			END
		),
		'{}'::jsonb
	)
	FROM jsonb_each("workflow_runs"."block_statuses") AS "entry"
)
WHERE "block_statuses" IS NOT NULL
	AND jsonb_typeof("block_statuses") = 'object';
