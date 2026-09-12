CREATE TABLE "repository_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"actor_id" text NOT NULL,
	"actor_label" text NOT NULL,
	"model" text NOT NULL,
	"outcome" text NOT NULL,
	"tokens_input" integer,
	"tokens_cached" integer,
	"tokens_output" integer,
	"cost_usd" numeric(19, 4),
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_suggestions_outcome_check" CHECK ("repository_suggestions"."outcome" in ('proposed', 'timeout', 'malformed', 'failed', 'missing'))
);
--> statement-breakpoint
ALTER TABLE "repository_suggestions" ADD CONSTRAINT "repository_suggestions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_suggestions_repository_idx" ON "repository_suggestions" USING btree ("repository_id","created_at");