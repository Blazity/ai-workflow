CREATE TABLE "pr_autofix_attempts" (
	"definition_id" text NOT NULL,
	"node_id" text NOT NULL,
	"provider" text NOT NULL,
	"repo_path" text NOT NULL,
	"pr_number" integer NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pr_autofix_attempts_pk" PRIMARY KEY("definition_id","node_id","provider","repo_path","pr_number")
);
