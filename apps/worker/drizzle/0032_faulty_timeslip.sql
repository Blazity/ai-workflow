ALTER TABLE "ticket_transition_intents" ALTER COLUMN "provider_started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "active_runs" ADD COLUMN "ticket_provider_calls_in_flight" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Rows written before provider start/finish fencing existed are ambiguous. Mark
-- them started rather than letting a rolling deployment release their owner.
UPDATE "ticket_transition_intents"
SET "provider_started_at" = "created_at"
WHERE "provider_started_at" IS NULL;--> statement-breakpoint

-- A consumed echo is durable proof that the provider transition landed. Keep
-- that evidence after owner release so delayed Jira retries remain bot echoes.
UPDATE "ticket_transition_intents"
SET
	"provider_finished_at" = "consumed_at",
	"expires_at" = greatest(
		"expires_at",
		"consumed_at" + interval '30 days'
	)
WHERE "consumed_at" IS NOT NULL
	AND "provider_finished_at" IS NULL;--> statement-breakpoint

UPDATE "active_runs" AS active
SET
	"ticket_provider_calls_in_flight" = legacy.in_flight,
	"ticket_mutation_version" = active."ticket_mutation_version" + legacy.in_flight
FROM (
	SELECT
		intent."subject_key",
		intent."owner_token",
		intent."run_id",
		count(*)::integer AS in_flight
	FROM "ticket_transition_intents" AS intent
	WHERE intent."provider_started_at" IS NOT NULL
		AND intent."provider_finished_at" IS NULL
	GROUP BY intent."subject_key", intent."owner_token", intent."run_id"
) AS legacy
WHERE active."subject_key" = legacy."subject_key"
	AND active."owner_token" = legacy."owner_token"
	AND active."run_id" IS NOT DISTINCT FROM legacy."run_id";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "sync_ticket_provider_call_fence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	owner_count integer;
BEGIN
	IF TG_OP = 'INSERT'
		AND NEW."provider_started_at" IS NOT NULL
		AND NEW."provider_finished_at" IS NULL THEN
		UPDATE "active_runs" AS active
		SET
			"ticket_provider_calls_in_flight" = active."ticket_provider_calls_in_flight" + 1,
			"ticket_mutation_version" = active."ticket_mutation_version" + 1,
			"updated_at" = now()
		WHERE active."subject_key" = NEW."subject_key"
			AND active."owner_token" = NEW."owner_token"
			AND active."run_id" IS NOT DISTINCT FROM NEW."run_id";
		GET DIAGNOSTICS owner_count = ROW_COUNT;
		IF owner_count <> 1 THEN
			RAISE EXCEPTION 'started ticket transition has no exact active owner';
		END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'UPDATE'
		AND OLD."provider_started_at" IS NULL
		AND NEW."provider_started_at" IS NOT NULL
		AND NEW."provider_finished_at" IS NULL THEN
		UPDATE "active_runs" AS active
		SET
			"ticket_provider_calls_in_flight" = active."ticket_provider_calls_in_flight" + 1,
			"ticket_mutation_version" = active."ticket_mutation_version" + 1,
			"updated_at" = now()
		WHERE active."subject_key" = NEW."subject_key"
			AND active."owner_token" = NEW."owner_token"
			AND active."run_id" IS NOT DISTINCT FROM NEW."run_id";
		GET DIAGNOSTICS owner_count = ROW_COUNT;
		IF owner_count <> 1 THEN
			RAISE EXCEPTION 'started ticket transition has no exact active owner';
		END IF;
	END IF;

	IF TG_OP = 'UPDATE'
		AND OLD."provider_started_at" IS NOT NULL
		AND OLD."provider_finished_at" IS NULL
		AND NEW."provider_finished_at" IS NOT NULL THEN
		UPDATE "active_runs" AS active
		SET
			"ticket_provider_calls_in_flight" = active."ticket_provider_calls_in_flight" - 1,
			"updated_at" = now()
		WHERE active."subject_key" = NEW."subject_key"
			AND active."owner_token" = NEW."owner_token"
			AND active."run_id" IS NOT DISTINCT FROM NEW."run_id"
			AND active."ticket_provider_calls_in_flight" > 0;
	END IF;

	IF TG_OP = 'DELETE'
		AND OLD."provider_started_at" IS NOT NULL
		AND OLD."provider_finished_at" IS NULL THEN
		UPDATE "active_runs" AS active
		SET
			"ticket_provider_calls_in_flight" = active."ticket_provider_calls_in_flight" - 1,
			"updated_at" = now()
		WHERE active."subject_key" = OLD."subject_key"
			AND active."owner_token" = OLD."owner_token"
			AND active."run_id" IS NOT DISTINCT FROM OLD."run_id"
			AND active."ticket_provider_calls_in_flight" > 0;
		RETURN OLD;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "ticket_provider_call_fence_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "ticket_transition_intents"
FOR EACH ROW
EXECUTE FUNCTION "sync_ticket_provider_call_fence"();--> statement-breakpoint

-- Old application pods do not know about the counter. Enforce the same owner
-- boundary below their adapter layer during a rolling deployment.
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
	) THEN
		RAISE EXCEPTION 'active run has unfinished ticket provider calls';
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "active_run_ticket_provider_call_guard_trigger"
BEFORE DELETE OR UPDATE ON "active_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_active_run_ticket_provider_calls"();
