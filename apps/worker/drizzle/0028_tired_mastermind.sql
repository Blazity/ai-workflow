ALTER TABLE "workflow_owned_branches" ADD COLUMN "target_branch" text;--> statement-breakpoint
ALTER TABLE "workflow_owned_branches" ADD COLUMN "pr_published_head_sha" text;--> statement-breakpoint
ALTER TABLE "workflow_owned_branches" ADD COLUMN "pr_target_branch" text;--> statement-breakpoint
ALTER TABLE "workflow_owned_branches" ADD COLUMN "pr_correlation_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "workflow_owned_branches"
SET "pr_published_head_sha" = "published_head_sha"
WHERE "pr_id" IS NOT NULL
  AND "published_head_sha" IS NOT NULL;
