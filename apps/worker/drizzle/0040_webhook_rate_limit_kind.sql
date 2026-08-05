ALTER TABLE "webhook_trigger_rate_limits" ADD COLUMN "kind" text DEFAULT 'inbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_trigger_rate_limits" DROP CONSTRAINT "webhook_trigger_rate_limits_endpoint_id_window_start_pk";--> statement-breakpoint
ALTER TABLE "webhook_trigger_rate_limits" ADD CONSTRAINT "webhook_trigger_rate_limits_endpoint_id_window_start_kind_pk" PRIMARY KEY("endpoint_id","window_start","kind");
