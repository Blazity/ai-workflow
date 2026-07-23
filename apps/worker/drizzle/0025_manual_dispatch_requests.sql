CREATE TABLE "manual_dispatch_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"definition_id" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"trigger_node_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"input_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"ticket_key" text,
	"input_payload" jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_label" text NOT NULL,
	"owner_token" text,
	"run_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_dispatch_requests_status_check" CHECK ("manual_dispatch_requests"."status" in ('pending', 'reserved', 'prepared', 'candidate_started', 'started', 'failed')),
	CONSTRAINT "manual_dispatch_requests_input_kind_check" CHECK ("manual_dispatch_requests"."input_kind" in ('ticket', 'pull_request'))
);
--> statement-breakpoint
ALTER TABLE "manual_dispatch_requests" ADD CONSTRAINT "manual_dispatch_requests_definition_version_fk" FOREIGN KEY ("definition_id","definition_version") REFERENCES "public"."workflow_definition_versions"("definition_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manual_dispatch_requests_status_idx" ON "manual_dispatch_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "manual_dispatch_requests_subject_key_idx" ON "manual_dispatch_requests" USING btree ("subject_key");--> statement-breakpoint
CREATE INDEX "manual_dispatch_requests_run_id_idx" ON "manual_dispatch_requests" USING btree ("run_id");