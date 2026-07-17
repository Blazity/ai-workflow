ALTER TABLE "workflow_owned_branches" ADD COLUMN "published_head_sha" text;
--> statement-breakpoint
UPDATE "workflow_runs"
SET "subject_key" = 'ticket:jira:' || upper(trim("ticket_key"))
WHERE "subject_key" IS NULL
  AND nullif(trim("ticket_key"), '') IS NOT NULL;
