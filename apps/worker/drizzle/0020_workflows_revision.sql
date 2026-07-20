ALTER TABLE "active_runs" DROP CONSTRAINT "active_runs_pkey";--> statement-breakpoint
ALTER TABLE "active_runs" RENAME COLUMN "ticket_key" TO "subject_key";--> statement-breakpoint
ALTER TABLE "active_runs" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "ticket_key" text;--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "owner_token" text;--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "state" text DEFAULT 'reserved';--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
UPDATE "active_runs"
SET
	"ticket_key" = "subject_key",
	"subject_key" = 'ticket:jira:' || "subject_key",
	"owner_token" = 'legacy:' || "run_id",
	"state" = CASE WHEN "run_id" LIKE 'claiming:%' THEN 'reserved' ELSE 'bound' END,
	"run_id" = CASE WHEN "run_id" LIKE 'claiming:%' THEN NULL ELSE "run_id" END,
	"updated_at" = now();--> statement-breakpoint
ALTER TABLE "active_runs" ALTER COLUMN "owner_token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "active_runs" ALTER COLUMN "state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "active_runs" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_pkey" PRIMARY KEY ("subject_key");--> statement-breakpoint
CREATE INDEX "active_runs_ticket_key_idx" ON "active_runs" USING btree ("ticket_key");--> statement-breakpoint
CREATE UNIQUE INDEX "active_runs_subject_owner_idx" ON "active_runs" USING btree ("subject_key", "owner_token");--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_state_check" CHECK ("state" in ('reserved', 'bound', 'parking', 'parked', 'cancelling'));--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_state_run_id_check" CHECK (("state" = 'reserved' and "run_id" is null) or ("state" in ('bound', 'parking', 'parked') and "run_id" is not null) or "state" = 'cancelling');--> statement-breakpoint

CREATE TABLE "active_run_sandboxes" (
	"subject_key" text NOT NULL,
	"owner_token" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "active_run_sandboxes_subject_key_owner_token_sandbox_id_pk" PRIMARY KEY ("subject_key", "owner_token", "sandbox_id")
);--> statement-breakpoint
INSERT INTO "active_run_sandboxes" ("subject_key", "owner_token", "sandbox_id", "created_at")
SELECT "subject_key", "owner_token", "sandbox_id", "created_at"
FROM "active_runs"
WHERE "sandbox_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "active_run_sandboxes" ADD CONSTRAINT "active_run_sandboxes_subject_owner_fk" FOREIGN KEY ("subject_key", "owner_token") REFERENCES "public"."active_runs" ("subject_key", "owner_token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_runs" DROP COLUMN "sandbox_id";--> statement-breakpoint

ALTER TABLE "workflow_definitions" ADD COLUMN "layout" jsonb DEFAULT '{"nodes":{}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "layout_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "deployed_version" integer;--> statement-breakpoint
WITH latest AS (
	SELECT DISTINCT ON ("definition_id") "definition_id", "version", "definition"
	FROM "workflow_definition_versions"
	ORDER BY "definition_id", "version" DESC
), prepared AS (
	SELECT
		"definition_id",
		"version",
		jsonb_build_object(
			'nodes',
			COALESCE((
				SELECT jsonb_object_agg(
					node->>'id',
					jsonb_build_object(
						'x', COALESCE(node->'x', '0'::jsonb),
						'y', COALESCE(node->'y', '0'::jsonb)
					)
				)
				FROM jsonb_array_elements(COALESCE(latest."definition"->'nodes', '[]'::jsonb)) AS nodes(node)
			), '{}'::jsonb)
		) AS layout
	FROM latest
)
UPDATE "workflow_definitions" AS definition
SET
	"layout" = prepared.layout,
	"layout_revision" = 1,
	"deployed_version" = CASE WHEN definition."enabled" THEN prepared."version" ELSE NULL END,
	"updated_at" = now()
FROM prepared
WHERE definition."id" = prepared."definition_id";--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_deployed_version_fk" FOREIGN KEY ("id", "deployed_version") REFERENCES "public"."workflow_definition_versions" ("definition_id", "version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "trigger_deliveries" (
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"producer" text NOT NULL,
	"trigger_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"ticket_key" text,
	"head_sha" text NOT NULL,
	"definition_id" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_deliveries_provider_delivery_id_pk" PRIMARY KEY ("provider", "delivery_id")
);--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_definition_version_fk" FOREIGN KEY ("definition_id", "definition_version") REFERENCES "public"."workflow_definition_versions" ("definition_id", "version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_deliveries_one_pending_per_subject_idx" ON "trigger_deliveries" USING btree ("subject_key") WHERE "pending" = true;--> statement-breakpoint

ALTER TABLE "workflow_owned_branches" ADD COLUMN "published_head_sha" text;--> statement-breakpoint
ALTER TABLE "workflow_owned_branches" ADD COLUMN "target_branch" text;--> statement-breakpoint
ALTER TABLE "workflow_owned_branches" ADD COLUMN "pr_published_head_sha" text;--> statement-breakpoint
ALTER TABLE "workflow_owned_branches" ADD COLUMN "pr_target_branch" text;--> statement-breakpoint
ALTER TABLE "workflow_owned_branches" ADD COLUMN "pr_correlation_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "workflow_runs" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "budget_failure" jsonb;--> statement-breakpoint
UPDATE "workflow_runs"
SET "subject_key" = 'ticket:jira:' || "ticket_key"
WHERE "ticket_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_runs_subject_key_idx" ON "workflow_runs" USING btree ("subject_key");--> statement-breakpoint

DROP INDEX "clarification_requests_pending_ticket_idx";--> statement-breakpoint
ALTER TABLE "clarification_requests" ALTER COLUMN "ticket_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "clarification_requests" ALTER COLUMN "status" SET DEFAULT 'preparing';--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "hook_token" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "source_sandbox_id" text;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "snapshot_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "cleanup_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarification_requests" ADD COLUMN "cleanup_error" text;--> statement-breakpoint
UPDATE "clarification_requests"
SET
	"subject_key" = 'ticket:jira:' || "ticket_key",
	"status" = CASE WHEN "status" = 'pending' THEN 'superseded' ELSE "status" END;--> statement-breakpoint
ALTER TABLE "clarification_requests" DROP COLUMN "dispatched_run_id";--> statement-breakpoint
CREATE INDEX "clarification_requests_expiry_idx" ON "clarification_requests" USING btree ("status", "expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clarification_requests_hook_token_idx" ON "clarification_requests" USING btree ("hook_token");--> statement-breakpoint
CREATE UNIQUE INDEX "clarification_requests_pending_subject_idx" ON "clarification_requests" USING btree ("subject_key") WHERE "status" = 'pending';
