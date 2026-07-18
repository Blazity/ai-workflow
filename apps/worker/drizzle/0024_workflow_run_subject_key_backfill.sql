CREATE TABLE "publication_attempt_repositories" (
	"attempt_id" text NOT NULL,
	"provider" text NOT NULL,
	"repo_path" text NOT NULL,
	"branch_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"changed" boolean DEFAULT false NOT NULL,
	"expected_head" text,
	"target_head" text,
	"pushed_head" text,
	"pr_id" integer,
	"pr_url" text,
	"pr_is_new" boolean,
	"failure" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_attempt_repositories_attempt_id_provider_repo_path_pk" PRIMARY KEY("attempt_id","provider","repo_path"),
	CONSTRAINT "publication_attempt_repositories_provider_check" CHECK ("publication_attempt_repositories"."provider" in ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE TABLE "publication_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"block_id" text NOT NULL,
	"workspace_manifest" jsonb NOT NULL,
	"status" text DEFAULT 'preflighting' NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_attempts_status_check" CHECK ("publication_attempts"."status" in ('preflighting', 'pushing', 'finalized', 'creating_prs', 'published', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "workflow_owned_branches" ADD COLUMN "published_head_sha" text;--> statement-breakpoint
ALTER TABLE "publication_attempt_repositories" ADD CONSTRAINT "publication_attempt_repositories_attempt_id_publication_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."publication_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_attempts_run_block_idx" ON "publication_attempts" USING btree ("run_id","block_id");--> statement-breakpoint
UPDATE "workflow_runs"
SET "subject_key" = 'ticket:jira:' || upper(trim("ticket_key"))
WHERE "subject_key" IS NULL
  AND nullif(trim("ticket_key"), '') IS NOT NULL;
