CREATE TABLE "webhook_trigger_deliveries" (
	"endpoint_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"subject_key" text NOT NULL,
	"definition_id" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_trigger_deliveries_endpoint_id_delivery_id_pk" PRIMARY KEY("endpoint_id","delivery_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_trigger_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" integer NOT NULL,
	"node_id" text NOT NULL,
	"auth_scheme" text DEFAULT 'hmac_sha256' NOT NULL,
	"header_name" text,
	"secret_ciphertext" text NOT NULL,
	"previous_secret_ciphertext" text,
	"previous_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_trigger_endpoints_auth_scheme_check" CHECK ("webhook_trigger_endpoints"."auth_scheme" in ('hmac_sha256', 'shared_token'))
);
--> statement-breakpoint
CREATE TABLE "webhook_trigger_rate_limits" (
	"endpoint_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "webhook_trigger_rate_limits_endpoint_id_window_start_pk" PRIMARY KEY("endpoint_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "webhook_trigger_rejection_counters" (
	"endpoint_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "webhook_trigger_rejection_counters_endpoint_id_window_start_reason_pk" PRIMARY KEY("endpoint_id","window_start","reason")
);
--> statement-breakpoint
ALTER TABLE "webhook_trigger_deliveries" ADD CONSTRAINT "webhook_trigger_deliveries_endpoint_id_webhook_trigger_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_trigger_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_trigger_deliveries" ADD CONSTRAINT "webhook_trigger_deliveries_definition_version_fk" FOREIGN KEY ("definition_id","definition_version") REFERENCES "public"."workflow_definition_versions"("definition_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_trigger_endpoints" ADD CONSTRAINT "webhook_trigger_endpoints_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_trigger_rate_limits" ADD CONSTRAINT "webhook_trigger_rate_limits_endpoint_id_webhook_trigger_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_trigger_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_trigger_deliveries_one_pending_per_subject_idx" ON "webhook_trigger_deliveries" USING btree ("subject_key") WHERE "webhook_trigger_deliveries"."pending" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_trigger_endpoints_definition_node_idx" ON "webhook_trigger_endpoints" USING btree ("definition_id","node_id");