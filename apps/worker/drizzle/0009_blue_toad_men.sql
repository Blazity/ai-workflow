CREATE TABLE "workflow_owned_branches" (
	"ticket_key" text NOT NULL,
	"provider" text NOT NULL,
	"repo_path" text NOT NULL,
	"branch_name" text NOT NULL,
	"pr_id" integer,
	"pr_url" text,
	"pr_branch_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_owned_branches_ticket_key_provider_repo_path_pk" PRIMARY KEY("ticket_key","provider","repo_path")
);
--> statement-breakpoint
CREATE INDEX "workflow_owned_branches_ticket_idx" ON "workflow_owned_branches" USING btree ("ticket_key");