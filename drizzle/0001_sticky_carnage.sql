ALTER TYPE "public"."run_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "run_attempts" ADD COLUMN "workflow_run_id" text;