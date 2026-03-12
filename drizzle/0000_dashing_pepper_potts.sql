CREATE TYPE "public"."agent_run_status" AS ENUM('provisioning', 'running', 'reviewing', 'fixing', 'merging', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_run_trigger" AS ENUM('new', 'review_fix', 'clarification_answer');--> statement-breakpoint
CREATE TYPE "public"."ticket_source" AS ENUM('jira', 'linear');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('queued', 'in_progress', 'clarifying', 'in_review', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"status" "agent_run_status" DEFAULT 'provisioning' NOT NULL,
	"trigger" "agent_run_trigger" NOT NULL,
	"branch_name" text,
	"container_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"source" "ticket_source" NOT NULL,
	"status" "ticket_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_external_id_source_unique" UNIQUE("external_id","source")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_ticket_id_idx" ON "agent_runs" USING btree ("ticket_id");