ALTER TABLE "clarification_requests" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "owner_token" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "waiting_node_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "definition_version_pin" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "trigger_payload" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "prior_steps" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "budget_state" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "workspace_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "source_heads" jsonb;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "checkpoint_state" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "source_sandbox_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "snapshot_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "cleanup_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "cleanup_error" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "successor_owner_token" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "successor_reserved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "clarification_requests_checkpoint_expiry_idx" ON "clarification_requests" USING btree ("checkpoint_state","expires_at");--> statement-breakpoint
CREATE INDEX "clarification_requests_cleanup_idx" ON "clarification_requests" USING btree ("cleanup_state");