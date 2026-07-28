CREATE TABLE "harness_capability_catalogs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"cli_version" text NOT NULL,
	"catalog" jsonb NOT NULL,
	"catalog_hash" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"last_refresh_failed_at" timestamp with time zone,
	"last_refresh_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harness_capability_catalogs_provider_check" CHECK ("harness_capability_catalogs"."provider" in ('claude', 'codex'))
);
--> statement-breakpoint
ALTER TABLE "harness_capability_catalogs" ADD CONSTRAINT "harness_capability_catalogs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "harness_capability_catalogs_scope_unique" ON "harness_capability_catalogs" USING btree ("organization_id","provider","cli_version");
