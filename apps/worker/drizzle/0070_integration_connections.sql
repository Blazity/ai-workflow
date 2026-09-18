CREATE TABLE "integration_connection_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_digests" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"test_status" text NOT NULL,
	"test_reason" text,
	"test_message" text,
	"tested_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connection_versions_test_status_check" CHECK ("integration_connection_versions"."test_status" in ('passed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"integration_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'environment' NOT NULL,
	"latest_version" integer DEFAULT 0 NOT NULL,
	"active_version" integer,
	"last_test_status" text,
	"last_test_reason" text,
	"last_test_message" text,
	"last_test_at" timestamp with time zone,
	"last_test_fingerprint" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_source_check" CHECK ("integration_connections"."source" in ('environment', 'stored')),
	CONSTRAINT "integration_connections_last_test_status_check" CHECK ("integration_connections"."last_test_status" is null or "integration_connections"."last_test_status" in ('passed', 'failed')),
	CONSTRAINT "integration_connections_active_version_check" CHECK ("integration_connections"."active_version" is null or ("integration_connections"."active_version" >= 1 and "integration_connections"."active_version" <= "integration_connections"."latest_version"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connection_versions_unique" ON "integration_connection_versions" USING btree ("integration_id","version");