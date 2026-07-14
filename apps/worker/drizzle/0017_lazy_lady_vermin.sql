ALTER TABLE "approval_requests" ADD COLUMN "definition_version" integer;--> statement-breakpoint
-- Backfill existing approvals to their definition's current head version so a row
-- filed before version pinning still resolves to a concrete version on approval.
UPDATE "approval_requests" ar
SET "definition_version" = (
	SELECT MAX(v."version")
	FROM "workflow_definition_versions" v
	WHERE v."definition_id" = ar."definition_id"
)
WHERE ar."definition_version" IS NULL;
