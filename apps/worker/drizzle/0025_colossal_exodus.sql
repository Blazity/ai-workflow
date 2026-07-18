CREATE TABLE "ticket_transition_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"owner_token" text NOT NULL,
	"run_id" text,
	"actor_account_id" text NOT NULL,
	"target_status_id" text,
	"target_status_name" text NOT NULL,
	"webhook_identifier" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_trigger_events" DROP CONSTRAINT "pending_trigger_events_subject_key_head_sha_trigger_type_pk";--> statement-breakpoint
ALTER TABLE "pending_trigger_events" ADD CONSTRAINT "pending_trigger_events_subject_key_head_sha_trigger_type_definition_id_definition_version_pk" PRIMARY KEY("subject_key","head_sha","trigger_type","definition_id","definition_version");--> statement-breakpoint
CREATE INDEX "ticket_transition_intents_ticket_expiry_idx" ON "ticket_transition_intents" USING btree ("ticket_key","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_transition_intents_webhook_identifier_uidx" ON "ticket_transition_intents" USING btree ("webhook_identifier");