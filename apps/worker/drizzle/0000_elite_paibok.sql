CREATE TABLE "active_runs" (
	"ticket_key" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"sandbox_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_marker" (
	"id" integer PRIMARY KEY NOT NULL,
	"env" text NOT NULL,
	"endpoint_host" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "failed_tickets" (
	"ticket_key" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"error" text NOT NULL,
	"failed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate_current" (
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"run_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"check_run_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gate_current_repo_pr_pk" PRIMARY KEY("repo","pr")
);
--> statement-breakpoint
CREATE TABLE "gate_dedupe" (
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"head_sha" text NOT NULL,
	"run_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gate_dedupe_repo_pr_head_sha_pk" PRIMARY KEY("repo","pr","head_sha")
);
--> statement-breakpoint
CREATE TABLE "gate_locks" (
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gate_locks_repo_pr_pk" PRIMARY KEY("repo","pr")
);
--> statement-breakpoint
CREATE TABLE "thread_parents" (
	"ticket_key" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL
);
