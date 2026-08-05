ALTER TABLE "webhook_trigger_endpoints" ADD COLUMN "require_timestamp" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_trigger_endpoints" ADD COLUMN "timestamp_header" text;--> statement-breakpoint
ALTER TABLE "webhook_trigger_endpoints" ADD COLUMN "timestamp_tolerance_seconds" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_trigger_endpoints" ADD CONSTRAINT "webhook_trigger_endpoints_timestamp_tolerance_check" CHECK ("webhook_trigger_endpoints"."timestamp_tolerance_seconds" > 0);