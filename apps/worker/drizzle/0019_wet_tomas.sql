CREATE TABLE "clarification_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_key" text NOT NULL,
	"run_id" text NOT NULL,
	"block_id" text,
	"definition_id" integer,
	"definition_version" integer,
	"questions" jsonb NOT NULL,
	"suggested_answers" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" text,
	"answered_by_id" text,
	"answered_by_label" text,
	"answered_at" timestamp with time zone,
	"dispatched_run_id" text
);
--> statement-breakpoint
CREATE INDEX "clarification_requests_status_idx" ON "clarification_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clarification_requests_ticket_key_idx" ON "clarification_requests" USING btree ("ticket_key");--> statement-breakpoint
CREATE INDEX "clarification_requests_run_id_idx" ON "clarification_requests" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clarification_requests_pending_ticket_idx" ON "clarification_requests" USING btree ("ticket_key") WHERE "clarification_requests"."status" = 'pending';