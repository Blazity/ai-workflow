ALTER TABLE "clarification_requests" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "owner_token" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "waiting_node_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "definition_version_pin" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "origin_entry" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "origin_trigger_node_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "origin_trigger_type" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "trigger_payload" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "prior_steps" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "interpreter_state" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "budget_state" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "runtime_context" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "workspace_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "source_heads" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "checkpoint_state" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "source_sandbox_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "snapshot_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "snapshot_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "cleanup_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "cleanup_error" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "cleanup_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "successor_owner_token" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "successor_reserved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
UPDATE "clarification_requests"
SET
  "subject_key" = 'ticket:jira:' || upper("ticket_key"),
  "owner_token" = 'legacy:' || "run_id",
  "checkpoint_state" = 'orphaned',
  "cleanup_state" = 'deleted',
  "cleanup_error" = 'Legacy clarification cannot be resumed; restart the ticket to rebuild the workflow checkpoint.',
  "status" = 'superseded'
WHERE "status" = 'pending' AND "checkpoint_state" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "clarification_requests_pending_ticket_idx";--> statement-breakpoint
ALTER TABLE "clarification_requests" ALTER COLUMN "ticket_key" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clarification_requests_pending_subject_idx" ON "clarification_requests" USING btree ("subject_key") WHERE "clarification_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "clarification_requests_checkpoint_expiry_idx" ON "clarification_requests" USING btree ("checkpoint_state","expires_at");--> statement-breakpoint
CREATE INDEX "clarification_requests_cleanup_idx" ON "clarification_requests" USING btree ("cleanup_state");
