CREATE TABLE "repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"path" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"default_branch" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rules" text DEFAULT '' NOT NULL,
	"relationships" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"current_profile_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_provider_check" CHECK ("repositories"."provider" in ('github', 'gitlab')),
	CONSTRAINT "repositories_source_check" CHECK ("repositories"."source" in ('imported', 'manual', 'seeded', 'migrated'))
);
--> statement-breakpoint
CREATE TABLE "repository_catalog_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"activated" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_catalog_state_single_row" CHECK ("repository_catalog_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "repository_profile_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"version" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rules" text DEFAULT '' NOT NULL,
	"relationships" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"script_groups" jsonb,
	"gate_groups" jsonb,
	"actor_id" text NOT NULL,
	"actor_label" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_profile_versions_version_check" CHECK ("repository_profile_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "repository_profile_versions" ADD CONSTRAINT "repository_profile_versions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_path_unique" ON "repositories" USING btree ("provider","path");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_profile_versions_unique" ON "repository_profile_versions" USING btree ("repository_id","version");