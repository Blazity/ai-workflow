CREATE TABLE "ticket_label_mutation_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"owner_token" text NOT NULL,
	"run_id" text,
	"add_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"remove_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"provider_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_label_mutation_intents_nonempty_check" CHECK (cardinality("ticket_label_mutation_intents"."add_labels") > 0 or cardinality("ticket_label_mutation_intents"."remove_labels") > 0),
	CONSTRAINT "ticket_label_mutation_intents_disjoint_check" CHECK (not ("ticket_label_mutation_intents"."add_labels" && "ticket_label_mutation_intents"."remove_labels"))
);
--> statement-breakpoint
CREATE INDEX "ticket_label_mutation_intents_owner_expiry_idx" ON "ticket_label_mutation_intents" USING btree ("subject_key","owner_token","expires_at");--> statement-breakpoint

-- The 0032 trigger function intentionally references only the provider-boundary
-- columns shared by both intent tables. Reuse it so label calls participate in
-- the exact same owner-local counter and mutation-version CAS.
CREATE TRIGGER "ticket_label_provider_call_fence_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ticket_label_mutation_intents"
FOR EACH ROW
EXECUTE FUNCTION "sync_ticket_provider_call_fence"();--> statement-breakpoint

-- Extend the rolling-deployment guard below old application adapters. An old
-- pod does not know this table exists, but it still cannot hand off or delete an
-- owner while a new pod has an unresolved label provider call.
CREATE OR REPLACE FUNCTION "guard_active_run_ticket_provider_calls"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	owner_identity_changes boolean;
BEGIN
	IF TG_OP = 'DELETE' THEN
		owner_identity_changes := true;
	ELSE
		owner_identity_changes :=
			NEW."owner_token" IS DISTINCT FROM OLD."owner_token"
			OR NEW."run_id" IS DISTINCT FROM OLD."run_id";
	END IF;

	IF owner_identity_changes AND (
		OLD."ticket_provider_calls_in_flight" > 0
		OR EXISTS (
			SELECT 1
			FROM "ticket_transition_intents" AS intent
			WHERE intent."subject_key" = OLD."subject_key"
				AND intent."owner_token" = OLD."owner_token"
				AND intent."run_id" IS NOT DISTINCT FROM OLD."run_id"
				AND intent."provider_started_at" IS NOT NULL
				AND intent."provider_finished_at" IS NULL
		)
		OR EXISTS (
			SELECT 1
			FROM "ticket_label_mutation_intents" AS intent
			WHERE intent."subject_key" = OLD."subject_key"
				AND intent."owner_token" = OLD."owner_token"
				AND intent."run_id" IS NOT DISTINCT FROM OLD."run_id"
				AND intent."provider_started_at" IS NOT NULL
				AND intent."provider_finished_at" IS NULL
		)
	) THEN
		RAISE EXCEPTION 'active run has unfinished ticket provider calls';
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
