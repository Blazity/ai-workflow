CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_key" text NOT NULL,
	"definition_id" integer NOT NULL,
	"run_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"assumptions" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by" text DEFAULT 'workflow' NOT NULL,
	"decided_by_id" text,
	"decided_by_label" text,
	"decided_at" timestamp with time zone,
	"dispatched_run_id" text
);
--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approval_requests_ticket_key_idx" ON "approval_requests" USING btree ("ticket_key");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_pending_ticket_idx" ON "approval_requests" USING btree ("ticket_key") WHERE "approval_requests"."status" = 'pending';