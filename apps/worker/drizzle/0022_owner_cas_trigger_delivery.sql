CREATE TABLE "active_run_sandboxes" (
	"subject_key" text NOT NULL,
	"owner_token" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "active_run_sandboxes_subject_key_owner_token_sandbox_id_pk" PRIMARY KEY("subject_key","owner_token","sandbox_id")
);
--> statement-breakpoint
CREATE TABLE "pending_trigger_events" (
	"subject_key" text NOT NULL,
	"head_sha" text NOT NULL,
	"trigger_type" text NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"ticket_key" text,
	"definition_id" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"failed_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviews" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_trigger_events_subject_key_head_sha_trigger_type_pk" PRIMARY KEY("subject_key","head_sha","trigger_type")
);
--> statement-breakpoint
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
	"status" text DEFAULT 'accepted' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_deliveries_provider_delivery_id_pk" PRIMARY KEY("provider","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "active_runs" RENAME COLUMN "ticket_key" TO "subject_key";
--> statement-breakpoint
ALTER TABLE "active_runs" RENAME COLUMN "sandbox_id" TO "legacy_sandbox_id";
--> statement-breakpoint
ALTER TABLE "active_runs" ALTER COLUMN "run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "ticket_key" text;
--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "owner_token" text;
--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "state" text DEFAULT 'reserved';
--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
UPDATE "active_runs"
SET "ticket_key" = "subject_key",
    "subject_key" = 'ticket:jira:' || "subject_key",
    "owner_token" = 'legacy:' || "run_id",
    "state" = CASE WHEN "run_id" LIKE 'claiming:%' THEN 'reserved' ELSE 'bound' END,
    "run_id" = CASE WHEN "run_id" LIKE 'claiming:%' THEN NULL ELSE "run_id" END;
--> statement-breakpoint
ALTER TABLE "active_runs" ALTER COLUMN "owner_token" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "active_runs" ALTER COLUMN "state" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "active_runs" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "subject_key" text;
--> statement-breakpoint
CREATE INDEX "pending_trigger_events_subject_created_idx" ON "pending_trigger_events" USING btree ("subject_key","created_at");
--> statement-breakpoint
CREATE INDEX "active_runs_ticket_key_idx" ON "active_runs" USING btree ("ticket_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "active_runs_subject_owner_idx" ON "active_runs" USING btree ("subject_key","owner_token");
--> statement-breakpoint
CREATE INDEX "workflow_runs_subject_key_idx" ON "workflow_runs" USING btree ("subject_key");
--> statement-breakpoint
INSERT INTO "active_run_sandboxes" ("subject_key", "owner_token", "sandbox_id")
SELECT "subject_key", "owner_token", "legacy_sandbox_id"
FROM "active_runs"
WHERE "legacy_sandbox_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "active_run_sandboxes" ADD CONSTRAINT "active_run_sandboxes_subject_key_active_runs_subject_key_fk" FOREIGN KEY ("subject_key") REFERENCES "public"."active_runs"("subject_key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "active_run_sandboxes" ADD CONSTRAINT "active_run_sandboxes_subject_owner_fk" FOREIGN KEY ("subject_key","owner_token") REFERENCES "public"."active_runs"("subject_key","owner_token") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pending_trigger_events" ADD CONSTRAINT "pending_trigger_events_definition_version_fk" FOREIGN KEY ("definition_id","definition_version") REFERENCES "public"."workflow_definition_versions"("definition_id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_definition_version_fk" FOREIGN KEY ("definition_id","definition_version") REFERENCES "public"."workflow_definition_versions"("definition_id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "active_runs" DROP COLUMN "legacy_sandbox_id";
--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_state_check" CHECK ("active_runs"."state" in ('reserved', 'bound'));
--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_state_run_id_check" CHECK (("active_runs"."state" = 'reserved' and "active_runs"."run_id" is null) or ("active_runs"."state" = 'bound' and "active_runs"."run_id" is not null));
