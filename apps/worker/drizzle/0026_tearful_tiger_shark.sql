DROP TABLE "pending_trigger_events";--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_deliveries_one_pending_per_subject_idx" ON "trigger_deliveries" USING btree ("subject_key") WHERE "trigger_deliveries"."pending" = true;--> statement-breakpoint
ALTER TABLE "trigger_deliveries" DROP COLUMN "status";
--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "hook_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "clarification_requests_hook_token_idx" ON "clarification_requests" USING btree ("hook_token");
