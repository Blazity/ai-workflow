CREATE TABLE "workflow_pr_review_publication_comments" (
	"publication_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider_reference" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "workflow_pr_review_publication_comments_publication_id_content_hash_pk" PRIMARY KEY("publication_id","content_hash"),
	CONSTRAINT "workflow_pr_review_publication_comments_state_check" CHECK ("workflow_pr_review_publication_comments"."state" in ('pending', 'published'))
);
--> statement-breakpoint
CREATE TABLE "workflow_pr_review_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"activation_scope" text NOT NULL,
	"provider" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"content_hash" text NOT NULL,
	"decision" text NOT NULL,
	"summary" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"provider_reference" text,
	"inline_comment_count" integer DEFAULT 0 NOT NULL,
	"summary_fallback_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"diagnostic_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "workflow_pr_review_publications_state_check" CHECK ("workflow_pr_review_publications"."state" in ('pending', 'published')),
	CONSTRAINT "workflow_pr_review_publications_decision_check" CHECK ("workflow_pr_review_publications"."decision" in ('approve', 'request_changes'))
);
--> statement-breakpoint
CREATE TABLE "workflow_run_external_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"activation_scope" text NOT NULL,
	"subject_key" text NOT NULL,
	"provider" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"name" text NOT NULL,
	"provider_reference" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"closure_intent" text,
	"conclusion" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"diagnostic_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_run_external_checks_state_check" CHECK ("workflow_run_external_checks"."state" in ('creating', 'pending', 'closing', 'completed')),
	CONSTRAINT "workflow_run_external_checks_conclusion_check" CHECK ("workflow_run_external_checks"."conclusion" is null or "workflow_run_external_checks"."conclusion" in ('success', 'failure', 'neutral', 'cancelled', 'timed_out', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "workflow_pr_review_publication_comments" ADD CONSTRAINT "workflow_pr_review_publication_comments_publication_id_workflow_pr_review_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."workflow_pr_review_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_pr_review_publications" ADD CONSTRAINT "workflow_pr_review_publications_run_id_workflow_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_external_checks" ADD CONSTRAINT "workflow_run_external_checks_run_id_workflow_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_pr_review_publications_content_unique" ON "workflow_pr_review_publications" USING btree ("provider","repository","pr_number","head_sha","content_hash");--> statement-breakpoint
CREATE INDEX "workflow_pr_review_publications_run_idx" ON "workflow_pr_review_publications" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_external_checks_attempt_unique" ON "workflow_run_external_checks" USING btree ("run_id","node_id","activation_scope","attempt");--> statement-breakpoint
CREATE INDEX "workflow_run_external_checks_reconcile_idx" ON "workflow_run_external_checks" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "workflow_run_external_checks_run_idx" ON "workflow_run_external_checks" USING btree ("run_id");
