CREATE TABLE "harness_profile_version_skills" (
	"profile_id" text NOT NULL,
	"profile_version" integer NOT NULL,
	"artifact_id" integer NOT NULL,
	"skill_name" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "harness_profile_version_skills_profile_id_profile_version_artifact_id_pk" PRIMARY KEY("profile_id","profile_version","artifact_id"),
	CONSTRAINT "harness_profile_version_skills_position_check" CHECK ("harness_profile_version_skills"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "harness_profile_versions" (
	"profile_id" text NOT NULL,
	"version" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text NOT NULL,
	"restored_from_version" integer,
	CONSTRAINT "harness_profile_versions_profile_id_version_pk" PRIMARY KEY("profile_id","version"),
	CONSTRAINT "harness_profile_versions_version_check" CHECK ("harness_profile_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "harness_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"slug" text NOT NULL,
	"draft_manifest" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"draft_restored_from_version" integer,
	"published_version" integer,
	"system" boolean DEFAULT false NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text NOT NULL,
	"updated_by_id" text NOT NULL,
	CONSTRAINT "harness_profiles_ownership_check" CHECK (("harness_profiles"."system" = true and "harness_profiles"."read_only" = true and "harness_profiles"."organization_id" is null) or ("harness_profiles"."system" = false and "harness_profiles"."organization_id" is not null)),
	CONSTRAINT "harness_profiles_draft_revision_check" CHECK ("harness_profiles"."draft_revision" > 0),
	CONSTRAINT "harness_profiles_published_version_check" CHECK ("harness_profiles"."published_version" is null or "harness_profiles"."published_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "harness_skill_artifact_files" (
	"artifact_id" integer NOT NULL,
	"path" text NOT NULL,
	"mode" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_base64" text NOT NULL,
	CONSTRAINT "harness_skill_artifact_files_artifact_id_path_pk" PRIMARY KEY("artifact_id","path"),
	CONSTRAINT "harness_skill_artifact_files_mode_check" CHECK ("harness_skill_artifact_files"."mode" in (420, 493)),
	CONSTRAINT "harness_skill_artifact_files_size_check" CHECK ("harness_skill_artifact_files"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "harness_skill_artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"artifact_hash" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_owner" text NOT NULL,
	"source_repository" text NOT NULL,
	"source_path" text NOT NULL,
	"source_commit_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "harness_manifests" jsonb;--> statement-breakpoint
ALTER TABLE "harness_profile_version_skills" ADD CONSTRAINT "harness_profile_version_skills_artifact_id_harness_skill_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."harness_skill_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_profile_version_skills" ADD CONSTRAINT "harness_profile_version_skills_profile_version_fk" FOREIGN KEY ("profile_id","profile_version") REFERENCES "public"."harness_profile_versions"("profile_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_profile_versions" ADD CONSTRAINT "harness_profile_versions_profile_id_harness_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."harness_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_profiles" ADD CONSTRAINT "harness_profiles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_profiles" ADD CONSTRAINT "harness_profiles_published_version_fk" FOREIGN KEY ("id","published_version") REFERENCES "public"."harness_profile_versions"("profile_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_skill_artifact_files" ADD CONSTRAINT "harness_skill_artifact_files_artifact_id_harness_skill_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."harness_skill_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_skill_artifacts" ADD CONSTRAINT "harness_skill_artifacts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "harness_profile_version_skills_name_unique" ON "harness_profile_version_skills" USING btree ("profile_id","profile_version","skill_name");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_profile_version_skills_position_unique" ON "harness_profile_version_skills" USING btree ("profile_id","profile_version","position");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_profile_versions_hash_unique" ON "harness_profile_versions" USING btree ("profile_id","manifest_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_profiles_org_slug_unique" ON "harness_profiles" USING btree ("organization_id","slug") WHERE "harness_profiles"."organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "harness_profiles_system_slug_unique" ON "harness_profiles" USING btree ("slug") WHERE "harness_profiles"."organization_id" is null;--> statement-breakpoint
CREATE INDEX "harness_profiles_organization_id_idx" ON "harness_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_skill_artifacts_org_hash_unique" ON "harness_skill_artifacts" USING btree ("organization_id","artifact_hash");--> statement-breakpoint
CREATE INDEX "harness_skill_artifacts_source_idx" ON "harness_skill_artifacts" USING btree ("organization_id","source_owner","source_repository","source_path");