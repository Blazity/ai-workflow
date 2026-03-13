CREATE TYPE "public"."run_status" AS ENUM('pending', 'preparing_sandbox', 'running', 'succeeded', 'failed', 'timed_out', 'clarification_needed');--> statement-breakpoint
CREATE TYPE "public"."run_type" AS ENUM('implementation', 'review_fix', 'conflict_resolution');--> statement-breakpoint
CREATE TYPE "public"."ticket_source" AS ENUM('jira', 'linear');--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('queued', 'implementing', 'clarification_pending', 'awaiting_review', 'fixing_feedback', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"type" "run_type" NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"container_id" text,
	"branch_name" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"identifier" text NOT NULL,
	"source" "ticket_source" NOT NULL,
	"state" text,
	"workflow_state" "workflow_state" DEFAULT 'queued' NOT NULL,
	"assignee" text,
	"branch_name" text,
	"pr_id" text,
	"current_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_external_id_source_unique" UNIQUE("external_id","source")
);
--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_attempts_ticket_id_idx" ON "run_attempts" USING btree ("ticket_id");