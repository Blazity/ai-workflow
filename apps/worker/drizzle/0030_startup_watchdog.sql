ALTER TABLE "workflow_runs" ADD COLUMN "entry_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "startup_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "diagnostic_id" text;--> statement-breakpoint
CREATE INDEX "workflow_runs_startup_watchdog_idx" ON "workflow_runs" USING btree ("startup_deadline_at") WHERE "workflow_runs"."entry_started_at" is null and coalesce("workflow_runs"."status", 'running') not in ('success', 'failed', 'blocked', 'awaiting', 'completed', 'cancelled');
