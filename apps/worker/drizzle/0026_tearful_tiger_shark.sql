DROP TABLE "pending_trigger_events";--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_deliveries_one_pending_per_subject_idx" ON "trigger_deliveries" USING btree ("subject_key") WHERE "trigger_deliveries"."pending" = true;--> statement-breakpoint
ALTER TABLE "trigger_deliveries" DROP COLUMN "status";
