CREATE TABLE "ticket_cancellation_fences" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"owner_token" text NOT NULL,
	"run_id" text,
	"target_status_id" text,
	"target_status_name" text NOT NULL,
	"webhook_identifier" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_transition_intents" ADD COLUMN "provider_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket_transition_intents" ADD COLUMN "provider_finished_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_cancellation_fences_webhook_identifier_uidx" ON "ticket_cancellation_fences" USING btree ("webhook_identifier");--> statement-breakpoint
CREATE INDEX "ticket_cancellation_fences_owner_occurred_idx" ON "ticket_cancellation_fences" USING btree ("subject_key","owner_token","occurred_at");