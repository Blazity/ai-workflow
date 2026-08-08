CREATE TABLE "schedule_occurrences" (
	"schedule_id" text NOT NULL,
	"occurrence_at" timestamp with time zone NOT NULL,
	"definition_id" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"outcome" text,
	"skip_reason" text,
	"dropped_count" integer DEFAULT 0 NOT NULL,
	"dropped_count_capped" boolean DEFAULT false NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"blocking_run_id" text,
	"run_id" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_occurrences_schedule_id_occurrence_at_pk" PRIMARY KEY("schedule_id","occurrence_at"),
	CONSTRAINT "schedule_occurrences_outcome_check" CHECK ("schedule_occurrences"."outcome" is null or "schedule_occurrences"."outcome" in ('started', 'skipped_overlap', 'skipped_stale', 'superseded', 'expired', 'cancelled', 'error'))
);
--> statement-breakpoint
CREATE TABLE "workflow_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" integer NOT NULL,
	"node_id" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"overlap_policy" text DEFAULT 'skip' NOT NULL,
	"catch_up_grace_minutes" integer DEFAULT 60 NOT NULL,
	"paused_at" timestamp with time zone,
	"evaluation_watermark_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"last_started_occurrence_at" timestamp with time zone,
	"last_started_run_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_schedules_overlap_policy_check" CHECK ("workflow_schedules"."overlap_policy" in ('skip', 'queue', 'allow')),
	CONSTRAINT "workflow_schedules_catch_up_grace_check" CHECK ("workflow_schedules"."catch_up_grace_minutes" > 0)
);
--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_schedule_id_workflow_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."workflow_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_definition_version_fk" FOREIGN KEY ("definition_id","definition_version") REFERENCES "public"."workflow_definition_versions"("definition_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_occurrences_one_pending_per_schedule_idx" ON "schedule_occurrences" USING btree ("schedule_id") WHERE "schedule_occurrences"."pending" = true;--> statement-breakpoint
CREATE INDEX "schedule_occurrences_run_id_idx" ON "schedule_occurrences" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_schedules_definition_node_idx" ON "workflow_schedules" USING btree ("definition_id","node_id");