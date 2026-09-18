CREATE TABLE "work_scope_entries" (
	"subject_key" text NOT NULL,
	"repository_key" text NOT NULL,
	"state" text NOT NULL,
	"unavailable_reason" text,
	"origin" text NOT NULL,
	"origin_rank" smallint NOT NULL,
	"rationale" text NOT NULL,
	"decided_by" jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_scope_entries_subject_key_repository_key_pk" PRIMARY KEY("subject_key","repository_key"),
	CONSTRAINT "work_scope_entries_state_check" CHECK ("work_scope_entries"."state" in ('selected', 'excluded', 'unavailable')),
	CONSTRAINT "work_scope_entries_unavailable_reason_check" CHECK ("work_scope_entries"."unavailable_reason" in ('not_enabled', 'unusable')),
	CONSTRAINT "work_scope_entries_unavailable_reason_pairing_check" CHECK (("work_scope_entries"."unavailable_reason" is not null) = ("work_scope_entries"."state" = 'unavailable')),
	CONSTRAINT "work_scope_entries_origin_check" CHECK ("work_scope_entries"."origin" in ('person', 'workflow_owned_branch', 'ticket_text', 'trigger_policy', 'inferred')),
	CONSTRAINT "work_scope_entries_origin_rank_check" CHECK ("work_scope_entries"."origin_rank" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "work_scope_trail" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_key" text,
	"run_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"repository_key" text,
	"event" jsonb NOT NULL,
	CONSTRAINT "work_scope_trail_kind_check" CHECK ("work_scope_trail"."kind" in ('entry_written', 'entry_removed', 'question_asked', 'question_answered', 'request_refused', 'map_shown')),
	CONSTRAINT "work_scope_trail_subject_or_run_check" CHECK ("work_scope_trail"."subject_key" is not null or "work_scope_trail"."run_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "work_scopes" (
	"subject_key" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "asked_repositories" jsonb;--> statement-breakpoint
ALTER TABLE "work_scope_entries" ADD CONSTRAINT "work_scope_entries_subject_key_work_scopes_subject_key_fk" FOREIGN KEY ("subject_key") REFERENCES "public"."work_scopes"("subject_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_scope_trail_subject_idx" ON "work_scope_trail" USING btree ("subject_key","id");--> statement-breakpoint
CREATE INDEX "work_scope_trail_run_idx" ON "work_scope_trail" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_scope_trail_answer_once" ON "work_scope_trail" USING btree (("event" ->> 'clarificationId')) WHERE "work_scope_trail"."kind" = 'question_answered';