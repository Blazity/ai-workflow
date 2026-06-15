CREATE TABLE "workflow_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text,
	"workflow_name" text,
	"status" text,
	"ticket_key" text,
	"ticket_title" text,
	"ticket_url" text,
	"model" text,
	"sandbox_id" text,
	"created_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_sec" integer,
	"pr_url" text,
	"pr_number" integer,
	"pr_repo" text,
	"cost_usd" real,
	"cost_known" boolean,
	"tokens_input" integer,
	"tokens_cached" integer,
	"tokens_output" integer,
	"phases" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_runs_started_at_idx" ON "workflow_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_ticket_key_idx" ON "workflow_runs" USING btree ("ticket_key");